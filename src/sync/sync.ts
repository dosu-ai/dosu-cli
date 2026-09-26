/** The knowledge-sync pipeline (scan, gate, ship): finished agent sessions go to the Dosu memory
 * ingest API. The watermark advances only past sessions the run settled, and quiet
 * hook-triggered runs never throw or write to stdout/stderr. */

import { logger } from "../debug/logger";
import { createProjectDirResolver } from "../sessions/project-dir";
import { isWorthStudying } from "../sessions/read";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { isIncognitoSession } from "./incognito";
import { fileLock, type SyncLock } from "./lock";
import {
  backoffUntil,
  filterSessionsByProject,
  gateSessions,
  isShippingEnabled,
  loadSyncState,
  SHIPPED_HISTORY_LIMIT,
  type ShippedSessionRecord,
  type SyncState,
  saveSyncState,
} from "./watermark";

/** Every run, the first-time backfill included, looks back this far and no further: memory
 * is most useful about recent work, and each shipped session costs a server-side ingest. */
export const SCAN_WINDOW_DAYS = 30;

/** Safety cap per hook-triggered run, so a hyperactive machine can't unbound a quiet sync. */
const SCAN_LIMIT = 200;

/** Sessions shipped per run, oldest first; a bootstrap drains the backlog run after run. */
export const SHIP_BATCH_LIMIT = 20;

type SyncStatus =
  | "backlog"
  | "nothing-new"
  | "shipped"
  | "ship-failed"
  | "disabled"
  | "skipped-backoff"
  | "skipped-lock"
  | "skipped-paused"
  | "error";

export interface ShipSessionResult {
  session: AgentSession;
  /** How the ship step disposed of this session. `incognito` and `skipped` still advance the
   * watermark; `failed` stops the batch and leaves the watermark for a retry. */
  outcome: "shipped" | "incognito" | "skipped" | "failed";
  /** The accepted ingest task id, on `shipped`. */
  taskId?: string;
  /** Shareable memory-session page, when the backend returned one. */
  sessionUrl?: string;
  /** One renderable line for skipped/failed results. */
  message?: string;
}

/** How a run disposed of the sessions it examined. */
interface ShipCounts {
  shipped: number;
  /** Opted out with `/dosu-incognito`; never uploaded. */
  incognito: number;
  /** Too small to plausibly hold anything worth learning; never uploaded. */
  trivial: number;
  /** Rejected by the backend or unreadable locally; not retried. */
  skipped: number;
  failed: number;
}

export interface SyncOutcome {
  status: SyncStatus;
  /** Completed sessions newer than the watermark. */
  readySessions: number;
  /** Sessions still inside the quiet period. */
  inFlightSessions: number;
  /** The gated backlog itself, newest first. */
  sessions: AgentSession[];
  /** Sessions the watermark moved past this run. */
  settledSessions?: number;
  counts?: ShipCounts;
  error?: string;
}

export interface SyncDeps {
  listSessions?: () => AgentSession[] | Promise<AgentSession[]>;
  loadState?: () => SyncState;
  saveState?: (state: SyncState) => void;
  /** When present, gated sessions are shipped; absent = gate-and-report only. Must process
   * oldest-first and stop after the first failed result. */
  ship?: (sessions: AgentSession[]) => Promise<ShipSessionResult[]>;
  /** Local worthiness pre-filter; defaults to isWorthStudying. */
  worthShipping?: (session: AgentSession) => boolean;
  /** Per-session opt-out check; defaults to isIncognitoSession (transcript marker). */
  isIncognito?: (session: AgentSession) => boolean;
  /** Session → working directory, for the project filter; defaults to the cached resolver. */
  resolveProjectDir?: (session: AgentSession) => string | null;
  lock?: SyncLock;
  now?: () => Date;
}

export interface SyncOptions {
  /** Background (hook-triggered) run: honor backoff, never fail loudly. */
  quiet?: boolean;
  /** First-time backfill: the whole scan window with no count cap, drained batch by batch. */
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
      preview ? ` · ${preview}${more}` : ""
    }`,
  );
}

/** Newest `updated` timestamp among the sessions — the new watermark. */
function newestUpdated(sessions: readonly AgentSession[]): string {
  let newest = sessions[0].updated;
  for (const s of sessions) {
    if (Date.parse(s.updated) > Date.parse(newest)) newest = s.updated;
  }
  return newest;
}

function key(session: AgentSession): string {
  return `${session.harness}/${session.id}`;
}

function empty(status: SyncStatus): SyncOutcome {
  return { status, readySessions: 0, inFlightSessions: 0, sessions: [] };
}

export async function runKnowledgeSync(options: SyncOptions = {}): Promise<SyncOutcome> {
  const deps = options.deps ?? {};
  const loadState = deps.loadState ?? loadSyncState;
  const saveState = deps.saveState ?? saveSyncState;
  const now = deps.now ?? (() => new Date());

  const state = loadState();

  if (!isShippingEnabled(state)) {
    logger.debug("sync", "skipping: transcript shipping is disabled");
    return empty("disabled");
  }
  if (options.quiet) {
    // The user's stop switch: hook-triggered runs stay off until resumed.
    if (state.paused) {
      logger.debug("sync", "skipping quiet sync: syncing is paused");
      return empty("skipped-paused");
    }
    const retryAt = backoffUntil(state);
    if (retryAt && now() < retryAt) {
      logger.debug("sync", `skipping quiet sync: backoff until ${retryAt.toISOString()}`);
      return empty("skipped-backoff");
    }
  } else if (state.paused) {
    // An explicit run is an explicit resume; every later state save persists the clear.
    delete state.paused;
    logger.debug("sync", "manual sync resumes paused syncing");
  }

  let ready: AgentSession[];
  let open: AgentSession[];
  try {
    const since = new Date(now().getTime() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const listSessions =
      deps.listSessions ??
      (() => scanAgentSessions(options.bootstrap ? { since } : { since, limit: SCAN_LIMIT }));
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
    return { ...empty("error"), error: message };
  }

  const base = { readySessions: ready.length, inFlightSessions: open.length, sessions: ready };
  if (ready.length === 0) return { status: "nothing-new", ...base };
  if (!deps.ship) return { status: "backlog", ...base };

  // Single-flight. The lock loser leaves state untouched — the winner owns this run.
  const lock = deps.lock ?? fileLock();
  if (!lock.acquire()) {
    logger.debug("sync", "skipping: another sync run holds the lock");
    return { status: "skipped-lock", ...base };
  }

  try {
    // Stamp this run's progress baseline into every state save so status viewers can compute
    // run-scoped progress; same-pid batches (a bootstrap drain) keep the first batch's baseline.
    if (state.run?.pid !== process.pid) {
      state.run = {
        pid: process.pid,
        started_at: now().toISOString(),
        baseline_shipped: state.total_shipped ?? 0,
      };
    }

    // Oldest first, so the watermark only ever advances. Incognito and trivial sessions are
    // settled locally — never uploaded — and count as examined so the watermark passes them.
    const worthShipping = deps.worthShipping ?? isWorthStudying;
    const isIncognito = deps.isIncognito ?? isIncognitoSession;
    const counts: ShipCounts = { shipped: 0, incognito: 0, trivial: 0, skipped: 0, failed: 0 };
    const examined: AgentSession[] = [];
    const localOutcome = new Map<AgentSession, "incognito" | "trivial">();
    const batch: AgentSession[] = [];
    // Sorted here rather than trusting the lister's order: the watermark depends on it.
    const oldestFirst = [...ready].sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));
    for (const candidate of oldestFirst) {
      if (batch.length >= SHIP_BATCH_LIMIT) break;
      examined.push(candidate);
      if (isIncognito(candidate)) localOutcome.set(candidate, "incognito");
      else if (!worthShipping(candidate)) localOutcome.set(candidate, "trivial");
      else batch.push(candidate);
    }
    logger.debug(
      "sync",
      `shipping ${batch.length} of ${ready.length} ready sessions (watermark ${state.watermark ?? "none"})`,
    );

    let results: ShipSessionResult[] = [];
    if (batch.length > 0) {
      try {
        results = await deps.ship(batch);
      } catch (err) {
        // The ship step reports failures per session; a throw is a step bug — treat it as one
        // failed attempt so backoff still engages instead of crashing the sync run.
        const message = err instanceof Error ? err.message : String(err);
        results = [{ session: batch[0], outcome: "failed", message }];
      }
    }
    const resultOf = new Map(results.map((r) => [r.session, r]));

    // Settle in order and stop at the first session the ship step did not finish: the
    // watermark must never jump past a session that still has to be retried.
    const at = now().toISOString();
    const settled: AgentSession[] = [];
    const records: ShippedSessionRecord[] = [];
    let error: string | undefined;
    for (const session of examined) {
      const local = localOutcome.get(session);
      if (local) {
        counts[local] += 1;
        logger.debug("sync", `not shipping ${local} session ${key(session)}`);
        settled.push(session);
        continue;
      }
      const result = resultOf.get(session);
      if (!result || result.outcome === "failed") {
        if (result) {
          counts.failed += 1;
          error = result.message ?? "unknown error";
          logger.debug("sync", `shipping failed at ${key(session)}: ${error}`);
        }
        break;
      }
      settled.push(session);
      if (result.outcome === "shipped") {
        counts.shipped += 1;
        records.push({
          at,
          session: key(session),
          task_id: result.taskId ?? "unknown",
          ...(result.sessionUrl ? { session_url: result.sessionUrl } : {}),
          ...(session.project ? { project: session.project } : {}),
        });
        logger.debug(
          "sync",
          `shipped session ${key(session)} → task ${result.taskId ?? "unknown"}${
            result.sessionUrl ? ` · ${result.sessionUrl}` : ""
          }`,
        );
      } else {
        counts[result.outcome] += 1;
        logger.debug(
          "sync",
          `not shipping session ${key(session)}: ${result.message ?? result.outcome}`,
        );
      }
    }

    const next: SyncState = {
      ...state,
      watermark: settled.length > 0 ? newestUpdated(settled) : state.watermark,
      last_attempt_at: at,
      consecutive_failures: counts.failed > 0 ? state.consecutive_failures + 1 : 0,
      shipped_sessions: [...(state.shipped_sessions ?? []), ...records].slice(
        -SHIPPED_HISTORY_LIMIT,
      ),
      total_shipped: (state.total_shipped ?? 0) + counts.shipped,
    };
    try {
      saveState(next);
    } catch {
      // Persisting progress is best-effort; the accepted tasks are already server-side.
    }
    logger.debug(
      "sync",
      `ship phase: ${counts.shipped} shipped, ${counts.incognito} incognito, ${counts.trivial} trivial, ${counts.skipped} skipped, ${counts.failed} failed; watermark → ${next.watermark ?? "none"}`,
    );
    return {
      status: counts.failed > 0 ? "ship-failed" : "shipped",
      ...base,
      settledSessions: settled.length,
      counts,
      ...(error ? { error } : {}),
    };
  } finally {
    lock.release();
  }
}
