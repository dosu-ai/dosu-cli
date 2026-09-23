/** The knowledge-sync pipeline (scan, gate, mine): the watermark advances only after a
 * successful study run, and quiet hook-triggered runs never throw or write to stdout/stderr. */

import { logger } from "../debug/logger";
import type { LearnerRunResult } from "../learner/runner";
import { createProjectDirResolver } from "../sessions/project-dir";
import { estimateSessionTokens, isWorthStudying } from "../sessions/read";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { isIncognitoSession } from "./incognito";
import { fileLock, type SyncLock } from "./lock";
import {
  backoffUntil,
  filterSessionsByProject,
  gateSessions,
  loadSyncState,
  STUDIED_HISTORY_LIMIT,
  type StudiedSessionRecord,
  type SyncState,
  saveSyncState,
} from "./watermark";

/** The gate only inspects the last 30 days; older history is bootstrap's job. */
const GATE_WINDOW_DAYS = 30;

/** Safety cap per run, so a hyperactive machine can't unbound a quiet sync. */
const GATE_WINDOW = 200;

/** Sessions studied per run, oldest first so the watermark advances monotonically; sized against
 * the learner's per-run caps in runner.ts, raise the two together. */
export const MINE_BATCH_LIMIT = 20;

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
  /** Sessions skipped because the user ran `/dosu-incognito` in them. */
  incognitoSessions?: number;
  learner?: LearnerRunResult;
  error?: string;
}

export interface SyncDeps {
  listSessions?: () => AgentSession[] | Promise<AgentSession[]>;
  loadState?: () => SyncState;
  saveState?: (state: SyncState) => void;
  /** When present, gated sessions are studied; absent = gate-and-report only. */
  mine?: (sessions: AgentSession[]) => Promise<LearnerRunResult>;
  /** Local worthiness pre-filter; defaults to isWorthStudying. */
  worthStudying?: (session: AgentSession) => boolean;
  /** Per-session opt-out check; defaults to isIncognitoSession (transcript marker). */
  isIncognito?: (session: AgentSession) => boolean;
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

/** The key a session goes by in the studied-session history. */
function sessionKey(session: AgentSession): string {
  return `${session.harness}/${session.id}`;
}

/** One history record per session, stamped with the time the run recorded it and the activity
 * snapshot it studied. */
function studiedRecords(sessions: readonly AgentSession[], at: string): StudiedSessionRecord[] {
  return sessions.map((s) => ({
    at,
    session: sessionKey(s),
    updated: s.updated,
    ...(s.project ? { project: s.project } : {}),
  }));
}

/** Newest studied activity snapshot per session, so the batch can skip sessions with nothing new
 * since (a failed run's noted sessions, which the kept watermark would otherwise revisit). The
 * snapshot, not the run's finish time, is compared: activity during a run must be studied again. */
function lastStudiedSnapshot(
  history: readonly StudiedSessionRecord[] | undefined,
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const record of history ?? []) {
    const updated = record.updated ? Date.parse(record.updated) : Number.NaN;
    if (
      !Number.isNaN(updated) &&
      updated > (latest.get(record.session) ?? Number.NEGATIVE_INFINITY)
    ) {
      latest.set(record.session, updated);
    }
  }
  return latest;
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

  if (ready.length === 0 || !deps.mine) {
    saveState({
      ...state,
      last_attempt_at: now().toISOString(),
      consecutive_failures: 0,
    });
    return { status: ready.length > 0 ? "backlog" : "nothing-new", ...base };
  }

  // Studying: single-flight. The lock loser leaves state untouched — the
  // winner owns this run's attempt bookkeeping.
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
        baseline_mined: state.total_mined ?? 0,
      };
    }

    // Walk ready oldest-first so the watermark can advance without skipping newer sessions;
    // incognito and trivial sessions are filtered locally and never cost a gateway run. Both
    // count as examined so the watermark passes them and they are never re-read.
    // Sessions a failed run already noted are skipped the same way, unless resumed since.
    const worthStudying = deps.worthStudying ?? isWorthStudying;
    const isIncognito = deps.isIncognito ?? isIncognitoSession;
    const studiedSnapshot = lastStudiedSnapshot(state.mined_sessions);
    const examined: AgentSession[] = [];
    const batch: AgentSession[] = [];
    let trivial = 0;
    let incognito = 0;
    let alreadyStudied = 0;
    for (let i = ready.length - 1; i >= 0 && batch.length < MINE_BATCH_LIMIT; i--) {
      const candidate = ready[i];
      examined.push(candidate);
      const key = sessionKey(candidate);
      if (Date.parse(candidate.updated) <= (studiedSnapshot.get(key) ?? Number.NEGATIVE_INFINITY)) {
        alreadyStudied += 1;
        logger.debug("sync", `skipping already-studied session ${key}`);
      } else if (isIncognito(candidate)) {
        incognito += 1;
        logger.debug("sync", `skipping incognito session ${candidate.harness}/${candidate.id}`);
      } else if (worthStudying(candidate)) {
        batch.push(candidate);
      } else {
        trivial += 1;
      }
    }
    const skippedNote = `${trivial} trivial, ${incognito} incognito${
      alreadyStudied > 0 ? `, ${alreadyStudied} already studied` : ""
    } skipped`;

    if (batch.length === 0) {
      // Everything examined was trivial or incognito: commit the watermark past it
      // without spending a single gateway token.
      saveState({
        ...state,
        watermark: batchWatermark(examined),
        last_attempt_at: now().toISOString(),
        consecutive_failures: 0,
      });
      logger.debug(
        "sync",
        `nothing to study in ${examined.length} examined sessions (${skippedNote}); watermark advanced, no run`,
      );
      return {
        status: "nothing-new",
        ...base,
        studiedSessions: 0,
        trivialSessions: trivial,
        incognitoSessions: incognito,
      };
    }

    logger.debug(
      "sync",
      `studying ${batch.length} of ${ready.length} ready sessions (${skippedNote})`,
    );
    const learner = await deps.mine(batch);
    const sessionTokens = deps.sessionTokens ?? estimateSessionTokens;

    // Notes are append-only, so sessions a failed or refused run already noted go into the
    // history now: the batch loop then skips them on retry instead of noting them twice. The
    // watermark and backoff still follow the outcome below.
    const noted = new Set(learner.notedSessions ?? []);
    const notedBatch = batch.filter((s) => noted.has(sessionKey(s)));
    const partialProgress = (at: string): Partial<SyncState> => {
      if (notedBatch.length === 0) return {};
      let tokens = 0;
      for (const s of notedBatch) tokens += sessionTokens(s);
      logger.debug(
        "sync",
        `recorded ${notedBatch.length} noted sessions from the ${learner.outcome} run`,
      );
      return {
        mined_sessions: [...(state.mined_sessions ?? []), ...studiedRecords(notedBatch, at)].slice(
          -STUDIED_HISTORY_LIMIT,
        ),
        total_mined: (state.total_mined ?? 0) + notedBatch.length,
        total_notes: (state.total_notes ?? 0) + learner.notesWritten,
        total_learning_tokens: (state.total_learning_tokens ?? 0) + tokens,
      };
    };

    switch (learner.outcome) {
      case "completed": {
        // One line per session so the activity feed narrates the run…
        for (const s of batch) {
          logger.debug("sync", `studied session ${s.harness}/${s.id}`);
        }
        // …and a durable history record per session, so status views can
        // list everything ever studied (capped) with an all-time counter.
        const completedAt = now().toISOString();
        const history = [
          ...(state.mined_sessions ?? []),
          ...studiedRecords(batch, completedAt),
        ].slice(-STUDIED_HISTORY_LIMIT);
        // The watermark covers everything examined — studied and trivial
        // alike — so neither is ever revisited.
        const watermark = batchWatermark(examined);
        // Analytics: what this batch cost to learn originally (chars÷4 over
        // the studied conversations) — future note reads reuse that learning.
        let batchTokens = 0;
        for (const s of batch) batchTokens += sessionTokens(s);
        saveState({
          ...state,
          watermark,
          last_attempt_at: completedAt,
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
          studiedSessions: batch.length,
          trivialSessions: trivial,
          incognitoSessions: incognito,
          learner,
        };
      }
      case "consent_off":
      case "credit_limit":
      case "quota_exceeded":
      case "claude_code_missing": {
        // Clean refusals are not failures: no backoff, watermark stays put. Persist the reason
        // so the Activity view and --status can explain why studying is paused. A missing
        // Claude Code is the user's to fix, so retrying on a backoff schedule would only nag.
        const at = now().toISOString();
        saveState({
          ...state,
          ...partialProgress(at),
          last_attempt_at: at,
          consecutive_failures: 0,
          last_refusal: {
            at,
            outcome: learner.outcome,
            message: learner.message ?? "Studying unavailable right now.",
          },
        });
        logger.debug("sync", `studying skipped: ${learner.outcome}`);
        return { status: "skipped-gateway", ...base, studiedSessions: 0, learner };
      }
      default: {
        // settings_conflict / gateway_rejected / error: real failures — back off before retrying.
        // Any 400 counts, including one the batch's own content triggers, so it can't skip the
        // backoff; its quoted reason is still persisted for the status views.
        const at = now().toISOString();
        saveState({
          ...state,
          ...partialProgress(at),
          last_attempt_at: at,
          consecutive_failures: state.consecutive_failures + 1,
          ...(learner.outcome === "gateway_rejected" && learner.message
            ? { last_refusal: { at, outcome: learner.outcome, message: learner.message } }
            : {}),
        });
        logger.debug("sync", `studying failed: ${learner.outcome}; ${learner.message ?? ""}`);
        return {
          status: "mine-failed",
          ...base,
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
