/** The knowledge-sync pipeline (scan, gate, mine): the watermark advances only after a
 * successful study run, and quiet hook-triggered runs never throw or write to stdout/stderr. */

import { logger } from "../debug/logger";
import type { LearnerRunResult } from "../learner/runner";
import { createProjectDirResolver } from "../sessions/project-dir";
import { estimateSessionTokens, isWorthStudying } from "../sessions/read";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { fileLock, type SyncLock } from "./lock";
import {
  backoffUntil,
  filterSessionsByProject,
  gateSessions,
  loadSyncState,
  SHIPPED_HISTORY_LIMIT,
  type ShippedSessionRecord,
  type ShipState,
  STUDIED_HISTORY_LIMIT,
  type SyncState,
  saveSyncState,
  shipBackoffUntil,
} from "./watermark";

/** The gate only inspects the last 30 days; older history is bootstrap's job. */
const GATE_WINDOW_DAYS = 30;

/** Safety cap per run, so a hyperactive machine can't unbound a quiet sync. */
const GATE_WINDOW = 200;

/** Sessions studied per run, oldest first so the watermark advances monotonically; sized against
 * the learner's per-run caps in runner.ts, raise the two together. */
export const MINE_BATCH_LIMIT = 20;

/** Sessions shipped per run, oldest first; the backlog drains across runs like studying. */
export const SHIP_BATCH_LIMIT = 20;

type SyncStatus =
  | "backlog"
  | "nothing-new"
  | "skipped-backoff"
  | "skipped-lock"
  | "skipped-gateway"
  | "skipped-paused"
  | "studied"
  | "mine-failed"
  | "error";

export interface ShipSessionResult {
  session: AgentSession;
  /** How the ship step disposed of this session. `incognito` and `skipped` still advance the
   * ship watermark; `failed` stops the batch and leaves the watermark for a retry. */
  outcome: "shipped" | "incognito" | "skipped" | "failed";
  /** The accepted ingest task id, on `shipped`. */
  taskId?: string;
  /** Shareable memory-session page, when the backend returned one. */
  sessionUrl?: string;
  /** One renderable line for skipped/failed results. */
  message?: string;
}

/** What the ship phase did this run, for outcome printers and tests. */
interface ShipPhaseOutcome {
  shipped: number;
  incognito: number;
  skipped: number;
  failed: number;
}

export interface SyncOutcome {
  status: SyncStatus;
  /** Completed sessions newer than the watermark. */
  readySessions: number;
  /** Sessions still inside the quiet period. */
  inFlightSessions: number;
  /** The gated backlog itself — what the studying step picks up. */
  sessions: AgentSession[];
  /** Sessions handed to the learner this run (≤ MINE_BATCH_LIMIT). */
  studiedSessions?: number;
  /** Sessions skipped locally as too small to plausibly hold knowledge. */
  trivialSessions?: number;
  learner?: LearnerRunResult;
  /** Ship-phase counts, when the ship step ran this run. */
  ship?: ShipPhaseOutcome;
  error?: string;
}

export interface SyncDeps {
  listSessions?: () => AgentSession[] | Promise<AgentSession[]>;
  loadState?: () => SyncState;
  saveState?: (state: SyncState) => void;
  /** When present, gated sessions are studied; absent = gate-and-report only. */
  mine?: (sessions: AgentSession[]) => Promise<LearnerRunResult>;
  /** When present AND the user opted in (`ship_transcripts`), gated sessions are shipped to the
   * Dosu memory ingest API under the ship phase's own watermark. Must process oldest-first and
   * stop after the first failed result. */
  ship?: (sessions: AgentSession[]) => Promise<ShipSessionResult[]>;
  /** Local worthiness pre-filter; defaults to isWorthStudying. */
  worthStudying?: (session: AgentSession) => boolean;
  /** Session → working directory, for the project filter; defaults to the cached resolver. */
  resolveProjectDir?: (session: AgentSession) => string | null;
  /** Per-session learning-token estimate; defaults to estimateSessionTokens. */
  sessionTokens?: (session: AgentSession) => number;
  lock?: SyncLock;
  now?: () => Date;
}

export interface SyncOptions {
  /** Background (hook-triggered) run: honor backoff, never fail loudly. */
  quiet?: boolean;
  /** Initial-setup backfill scope: scan the entire history with no age cutoff, since a fresh
   * install's sessions predate the 30-day window by construction. */
  bootstrap?: boolean;
  deps?: SyncDeps;
}

/** How many selected sessions a gate log line names before summarizing. */
const LOG_PREVIEW_LIMIT = 10;

/** One debug-log line naming what the gate selected: the only visibility a quiet run has. */
function logGateResult(
  ready: readonly AgentSession[],
  inFlight: number,
  watermark: string | null,
): void {
  const preview = ready
    .slice(0, LOG_PREVIEW_LIMIT)
    .map((s) => `${s.harness}/${s.id}`)
    .join(", ");
  const more =
    ready.length > LOG_PREVIEW_LIMIT ? ` (+${ready.length - LOG_PREVIEW_LIMIT} more)` : "";
  logger.debug(
    "sync",
    `gate: ${ready.length} ready, ${inFlight} in flight (watermark ${watermark ?? "none"})${
      preview ? ` \u00B7 ${preview}${more}` : ""
    }`,
  );
}

/** Newest `updated` timestamp among the batch — the new watermark. */
function batchWatermark(batch: readonly AgentSession[]): string {
  let newest = batch[0].updated;
  for (const s of batch) {
    if (Date.parse(s.updated) > Date.parse(newest)) newest = s.updated;
  }
  return newest;
}

/** The transcript-shipping phase: gates the same scanned sessions under its OWN watermark,
 * ships oldest-first, and keeps its own failure backoff. Mutates `state.ship` in place (so the
 * mine phase's later saves carry it) and persists immediately. Never throws. */
async function runShipPhase(
  state: SyncState,
  sessions: readonly AgentSession[],
  ship: NonNullable<SyncDeps["ship"]>,
  saveState: (state: SyncState) => void,
  now: () => Date,
  quiet: boolean,
): Promise<ShipPhaseOutcome | undefined> {
  if (quiet) {
    const retryAt = shipBackoffUntil(state);
    if (retryAt && now() < retryAt) {
      logger.debug("sync", `skipping ship phase: backoff until ${retryAt.toISOString()}`);
      return undefined;
    }
  }
  const { ready } = gateSessions(sessions, state.ship?.watermark ?? null, now());
  if (ready.length === 0) return undefined;

  // Oldest-first, like studying, so the ship watermark advances monotonically.
  const batch = ready.slice(-SHIP_BATCH_LIMIT).reverse();
  logger.debug(
    "sync",
    `shipping ${batch.length} of ${ready.length} sessions ready to ship (watermark ${state.ship?.watermark ?? "none"})`,
  );

  let results: ShipSessionResult[];
  try {
    results = await ship(batch);
  } catch (err) {
    // The ship step reports failures per session; a throw is a step bug — treat it as one
    // failed attempt so backoff still engages instead of crashing the sync run.
    const message = err instanceof Error ? err.message : String(err);
    logger.debug("sync", `ship step threw: ${message}`);
    results = [{ session: batch[0], outcome: "failed", message }];
  }

  const at = now().toISOString();
  const counts: ShipPhaseOutcome = { shipped: 0, incognito: 0, skipped: 0, failed: 0 };
  const processed: AgentSession[] = [];
  const records: ShippedSessionRecord[] = [];
  for (const result of results) {
    const key = `${result.session.harness}/${result.session.id}`;
    if (result.outcome === "failed") {
      counts.failed += 1;
      logger.debug("sync", `shipping failed at ${key}: ${result.message ?? "unknown error"}`);
      break;
    }
    processed.push(result.session);
    if (result.outcome === "shipped") {
      counts.shipped += 1;
      records.push({
        at,
        session: key,
        task_id: result.taskId ?? "unknown",
        ...(result.sessionUrl ? { session_url: result.sessionUrl } : {}),
        ...(result.session.project ? { project: result.session.project } : {}),
      });
      logger.debug(
        "sync",
        `shipped session ${key} → task ${result.taskId ?? "unknown"}${
          result.sessionUrl ? ` \u00B7 ${result.sessionUrl}` : ""
        }`,
      );
    } else if (result.outcome === "incognito") {
      counts.incognito += 1;
      logger.debug("sync", `not shipping incognito session ${key}`);
    } else {
      counts.skipped += 1;
      logger.debug("sync", `not shipping session ${key}: ${result.message ?? "skipped"}`);
    }
  }

  const shipState: ShipState = {
    // Everything processed — shipped, incognito, and skipped alike — is never revisited.
    watermark: processed.length > 0 ? batchWatermark(processed) : (state.ship?.watermark ?? null),
    last_attempt_at: at,
    consecutive_failures: counts.failed > 0 ? (state.ship?.consecutive_failures ?? 0) + 1 : 0,
    shipped_sessions: [...(state.ship?.shipped_sessions ?? []), ...records].slice(
      -SHIPPED_HISTORY_LIMIT,
    ),
    total_shipped: (state.ship?.total_shipped ?? 0) + counts.shipped,
  };
  state.ship = shipState;
  try {
    saveState({ ...state });
  } catch {
    // Persisting ship progress is best-effort; the accepted tasks are already server-side.
  }
  logger.debug(
    "sync",
    `ship phase: ${counts.shipped} shipped, ${counts.incognito} incognito, ${counts.skipped} skipped, ${counts.failed} failed; ship watermark → ${shipState.watermark ?? "none"}`,
  );
  return counts;
}

export async function runKnowledgeSync(options: SyncOptions = {}): Promise<SyncOutcome> {
  const deps = options.deps ?? {};
  const loadState = deps.loadState ?? loadSyncState;
  const saveState = deps.saveState ?? saveSyncState;
  const now = deps.now ?? (() => new Date());

  const state = loadState();

  if (options.quiet) {
    // The user's stop switch: hook-triggered runs stay off until resumed.
    if (state.paused) {
      logger.debug("sync", "skipping quiet sync: studying is paused");
      return { status: "skipped-paused", readySessions: 0, inFlightSessions: 0, sessions: [] };
    }
    const retryAt = backoffUntil(state);
    if (retryAt && now() < retryAt) {
      logger.debug("sync", `skipping quiet sync: backoff until ${retryAt.toISOString()}`);
      return { status: "skipped-backoff", readySessions: 0, inFlightSessions: 0, sessions: [] };
    }
  } else if (state.paused) {
    // An explicit run is an explicit resume; every later state save persists the clear.
    delete state.paused;
    logger.debug("sync", "manual sync resumes paused studying");
  }

  let ready: AgentSession[];
  let open: AgentSession[];
  let scanned: AgentSession[] = [];
  try {
    const listSessions =
      deps.listSessions ??
      (() =>
        options.bootstrap
          ? scanAgentSessions({})
          : scanAgentSessions({
              since: new Date(now().getTime() - GATE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
              limit: GATE_WINDOW,
            }));
    let sessions = await listSessions();
    if (state.project_filter?.length) {
      // Resolver only when filtering: it reads session heads on cache misses.
      let resolve = deps.resolveProjectDir;
      let flush: (() => void) | undefined;
      if (!resolve) {
        const resolver = createProjectDirResolver();
        resolve = resolver.resolve;
        flush = resolver.flush;
      }
      sessions = filterSessionsByProject(sessions, state.project_filter, resolve);
      flush?.();
      logger.debug("sync", `project filter active: ${state.project_filter.join(", ")}`);
    }
    scanned = sessions;
    ({ ready, open } = gateSessions(sessions, state.watermark, now()));
    logGateResult(ready, open.length, state.watermark);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug("sync", `sync failed: ${message}`);
    try {
      saveState({
        ...state,
        last_attempt_at: now().toISOString(),
        consecutive_failures: state.consecutive_failures + 1,
      });
    } catch {
      // Persisting backoff state is best-effort; the failure itself is what matters.
    }
    return { status: "error", readySessions: 0, inFlightSessions: 0, sessions: [], error: message };
  }

  const base = {
    readySessions: ready.length,
    inFlightSessions: open.length,
    sessions: ready,
  };

  // Shipping is opt-in and gated here, on the state the pipeline already loaded, so a stale
  // step built before the user disabled the flag can never ship anything.
  const shipStep = state.ship_transcripts === true ? deps.ship : undefined;
  const willMine = ready.length > 0 && Boolean(deps.mine);

  if (!willMine && !shipStep) {
    saveState({
      ...state,
      last_attempt_at: now().toISOString(),
      consecutive_failures: 0,
    });
    return { status: ready.length > 0 ? "backlog" : "nothing-new", ...base };
  }

  // Studying and shipping: single-flight. The lock loser leaves state untouched — the
  // winner owns this run's attempt bookkeeping.
  const lock = deps.lock ?? fileLock();
  if (!lock.acquire()) {
    logger.debug("sync", "skipping: another sync run holds the lock");
    return { status: "skipped-lock", ...base };
  }

  try {
    // Ship first: fire-and-forget HTTP, cheap next to a study run, and its own watermark and
    // backoff keep it fully independent of everything the mine path does below.
    const shipOutcome = shipStep
      ? await runShipPhase(state, scanned, shipStep, saveState, now, options.quiet === true)
      : undefined;
    const withShip = shipOutcome ? { ship: shipOutcome } : {};

    if (!willMine || !deps.mine) {
      saveState({
        ...state,
        last_attempt_at: now().toISOString(),
        consecutive_failures: 0,
      });
      return { status: ready.length > 0 ? "backlog" : "nothing-new", ...base, ...withShip };
    }

    // Stamp this run's progress baseline into every state save so status viewers can compute
    // run-scoped progress; same-pid batches (a bootstrap drain) keep the first batch's baseline.
    if (state.run?.pid !== process.pid) {
      state.run = {
        pid: process.pid,
        started_at: now().toISOString(),
        baseline_mined: state.total_mined ?? 0,
      };
    }

    // Walk ready oldest-first so the watermark can advance without skipping newer sessions;
    // trivial sessions are filtered locally and never cost a gateway run.
    const worthStudying = deps.worthStudying ?? isWorthStudying;
    const examined: AgentSession[] = [];
    const batch: AgentSession[] = [];
    let trivial = 0;
    for (let i = ready.length - 1; i >= 0 && batch.length < MINE_BATCH_LIMIT; i--) {
      const candidate = ready[i];
      examined.push(candidate);
      if (worthStudying(candidate)) {
        batch.push(candidate);
      } else {
        trivial += 1;
      }
    }

    if (batch.length === 0) {
      // Everything examined was trivial: commit the watermark past it
      // without spending a single gateway token.
      saveState({
        ...state,
        watermark: batchWatermark(examined),
        last_attempt_at: now().toISOString(),
        consecutive_failures: 0,
      });
      logger.debug("sync", `all ${trivial} examined sessions trivial; watermark advanced, no run`);
      return {
        status: "nothing-new",
        ...base,
        ...withShip,
        studiedSessions: 0,
        trivialSessions: trivial,
      };
    }

    logger.debug(
      "sync",
      `studying ${batch.length} of ${ready.length} ready sessions (${trivial} trivial skipped)`,
    );
    const learner = await deps.mine(batch);

    switch (learner.outcome) {
      case "completed": {
        // One line per session so the activity feed narrates the run…
        for (const s of batch) {
          logger.debug("sync", `studied session ${s.harness}/${s.id}`);
        }
        // …and a durable history record per session, so status views can
        // list everything ever studied (capped) with an all-time counter.
        const studiedAt = now().toISOString();
        const history = [
          ...(state.mined_sessions ?? []),
          ...batch.map((s) => ({
            at: studiedAt,
            session: `${s.harness}/${s.id}`,
            ...(s.project ? { project: s.project } : {}),
          })),
        ].slice(-STUDIED_HISTORY_LIMIT);
        // The watermark covers everything examined — studied and trivial
        // alike — so neither is ever revisited.
        const watermark = batchWatermark(examined);
        // Analytics: what this batch cost to learn originally (chars÷4 over
        // the studied conversations) — future note reads reuse that learning.
        const sessionTokens = deps.sessionTokens ?? estimateSessionTokens;
        let batchTokens = 0;
        for (const s of batch) batchTokens += sessionTokens(s);
        saveState({
          ...state,
          watermark,
          last_attempt_at: studiedAt,
          consecutive_failures: 0,
          mined_sessions: history,
          total_mined: (state.total_mined ?? 0) + batch.length,
          total_notes: (state.total_notes ?? 0) + learner.notesWritten,
          total_learning_tokens: (state.total_learning_tokens ?? 0) + batchTokens,
          // A successful run supersedes any earlier gateway refusal.
          last_refusal: undefined,
        });
        logger.debug(
          "sync",
          `studied ${batch.length} sessions, ${learner.notesWritten} suggested pages; watermark → ${watermark}`,
        );
        return {
          status: "studied",
          ...base,
          ...withShip,
          studiedSessions: batch.length,
          trivialSessions: trivial,
          learner,
        };
      }
      case "consent_off":
      case "credit_limit":
      case "quota_exceeded": {
        // Clean refusals are not failures: no backoff, watermark stays put. Persist the reason
        // so the Activity view and --status can explain why studying is paused.
        const at = now().toISOString();
        saveState({
          ...state,
          last_attempt_at: at,
          consecutive_failures: 0,
          last_refusal: {
            at,
            outcome: learner.outcome,
            message: learner.message ?? "Studying unavailable right now.",
          },
        });
        logger.debug("sync", `studying skipped by gateway: ${learner.outcome}`);
        return { status: "skipped-gateway", ...base, ...withShip, studiedSessions: 0, learner };
      }
      default: {
        // settings_conflict / error: real failures — back off before retrying.
        saveState({
          ...state,
          last_attempt_at: now().toISOString(),
          consecutive_failures: state.consecutive_failures + 1,
        });
        logger.debug("sync", `studying failed: ${learner.outcome}; ${learner.message ?? ""}`);
        return {
          status: "mine-failed",
          ...base,
          ...withShip,
          studiedSessions: 0,
          learner,
          error: learner.message,
        };
      }
    }
  } finally {
    lock.release();
  }
}
