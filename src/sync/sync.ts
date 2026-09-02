/**
 * The knowledge-sync pipeline: scan local sessions → gate → mine.
 *
 * Every trigger (hook, manual `dosu knowledge sync`, future FTUE bootstrap)
 * converges here. When the caller supplies a miner (authenticated cloud-mode
 * runs), the gated backlog is mined in capped batches and the watermark
 * advances only after a successful run — failures always leave the backlog
 * intact for a later trigger. Without a miner the run ends at the gate and
 * reports the backlog.
 *
 * Hook-triggered runs (`quiet`) must be invisible: they honor failure
 * backoff, never throw, and never write to stdout/stderr — failures go to
 * the debug log only.
 */

import { logger } from "../debug/logger";
import type { MinerRunResult } from "../miner/runner";
import { isWorthMining } from "../sessions/read";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { fileLock, type SyncLock } from "./lock";
import {
  backoffUntil,
  gateSessions,
  loadSyncState,
  type SyncState,
  saveSyncState,
} from "./watermark";

/**
 * The gate inspects sessions from the last 30 days — same window semantics as
 * the log-backfill skill's "last N days" scope. Older history is bootstrap's
 * job, not the background sync's.
 */
const GATE_WINDOW_DAYS = 30;

/** Safety cap per run, so a hyperactive machine can't unbound a quiet sync. */
const GATE_WINDOW = 200;

/**
 * Sessions mined per run. Oldest-first, so the watermark advances
 * monotonically and the remaining (newer) backlog is picked up by the
 * next trigger. Keeps any single hook-triggered run's token cost bounded.
 */
export const MINE_BATCH_LIMIT = 5;

type SyncStatus =
  | "backlog"
  | "nothing-new"
  | "skipped-backoff"
  | "skipped-lock"
  | "skipped-gateway"
  | "mined"
  | "mine-failed"
  | "error";

export interface SyncOutcome {
  status: SyncStatus;
  /** Completed sessions newer than the watermark. */
  readySessions: number;
  /** Sessions still inside the quiet period. */
  inFlightSessions: number;
  /** The gated backlog itself — what the mining step picks up. */
  sessions: AgentSession[];
  /** Sessions handed to the miner this run (≤ MINE_BATCH_LIMIT). */
  minedSessions?: number;
  /** Sessions skipped locally as too small to plausibly hold knowledge. */
  trivialSessions?: number;
  miner?: MinerRunResult;
  error?: string;
}

export interface SyncDeps {
  listSessions?: () => AgentSession[] | Promise<AgentSession[]>;
  loadState?: () => SyncState;
  saveState?: (state: SyncState) => void;
  /** When present, gated sessions are mined; absent = gate-and-report only. */
  mine?: (sessions: AgentSession[]) => Promise<MinerRunResult>;
  /** Local worthiness pre-filter; defaults to isWorthMining. */
  worthMining?: (session: AgentSession) => boolean;
  lock?: SyncLock;
  now?: () => Date;
}

export interface SyncOptions {
  /** Background (hook-triggered) run: honor backoff, never fail loudly. */
  quiet?: boolean;
  /**
   * Initial-setup backfill scope: scan the entire local session history —
   * no age cutoff, no count cap — instead of the rolling 30-day window.
   * A fresh install's history predates the window by construction, and old
   * sessions are exactly what the backfill exists to catch. Volume stays
   * bounded downstream: mining happens MINE_BATCH_LIMIT sessions per round.
   */
  bootstrap?: boolean;
  deps?: SyncDeps;
}

/** How many selected sessions a gate log line names before summarizing. */
const LOG_PREVIEW_LIMIT = 10;

/**
 * One debug-log line per run naming what the gate selected — the only
 * visibility a quiet (hook-triggered) run has, since it never writes to
 * stdout/stderr. Tail the debug log to watch hooks fire.
 */
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

export async function runKnowledgeSync(options: SyncOptions = {}): Promise<SyncOutcome> {
  const deps = options.deps ?? {};
  const loadState = deps.loadState ?? loadSyncState;
  const saveState = deps.saveState ?? saveSyncState;
  const now = deps.now ?? (() => new Date());

  const state = loadState();

  if (options.quiet) {
    const retryAt = backoffUntil(state);
    if (retryAt && now() < retryAt) {
      logger.debug("sync", `skipping quiet sync: backoff until ${retryAt.toISOString()}`);
      return { status: "skipped-backoff", readySessions: 0, inFlightSessions: 0, sessions: [] };
    }
  }

  let ready: AgentSession[];
  let inFlight: number;
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
    const sessions = await listSessions();
    ({ ready, inFlight } = gateSessions(sessions, state.watermark, now()));
    logGateResult(ready, inFlight, state.watermark);
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
    inFlightSessions: inFlight,
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

  // Mining: single-flight. The lock loser leaves state untouched — the
  // winner owns this run's attempt bookkeeping.
  const lock = deps.lock ?? fileLock();
  if (!lock.acquire()) {
    logger.debug("sync", "skipping: another sync run holds the lock");
    return { status: "skipped-lock", ...base };
  }

  try {
    // Ready is newest-first (scanner order); walk from the oldest so the
    // watermark can advance past everything examined without skipping newer
    // sessions. Trivial sessions are filtered locally — they never cost a
    // gateway run, and the watermark rolls over them for free.
    const worthMining = deps.worthMining ?? isWorthMining;
    const examined: AgentSession[] = [];
    const batch: AgentSession[] = [];
    let trivial = 0;
    for (let i = ready.length - 1; i >= 0 && batch.length < MINE_BATCH_LIMIT; i--) {
      const candidate = ready[i];
      examined.push(candidate);
      if (worthMining(candidate)) {
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
        minedSessions: 0,
        trivialSessions: trivial,
      };
    }

    logger.debug(
      "sync",
      `mining ${batch.length} of ${ready.length} ready sessions (${trivial} trivial skipped)`,
    );
    const miner = await deps.mine(batch);

    switch (miner.outcome) {
      case "completed": {
        // The watermark covers everything examined — mined and trivial
        // alike — so neither is ever revisited.
        const watermark = batchWatermark(examined);
        saveState({
          ...state,
          watermark,
          last_attempt_at: now().toISOString(),
          consecutive_failures: 0,
        });
        logger.debug(
          "sync",
          `mined ${batch.length} sessions, ${miner.notesWritten} notes; watermark → ${watermark}`,
        );
        return {
          status: "mined",
          ...base,
          minedSessions: batch.length,
          trivialSessions: trivial,
          miner,
        };
      }
      case "consent_off":
      case "credit_limit":
      case "quota_exceeded": {
        // Clean, expected refusals — not failures, so no backoff. The
        // watermark stays put and the backlog is retried once unblocked.
        saveState({
          ...state,
          last_attempt_at: now().toISOString(),
          consecutive_failures: 0,
        });
        logger.debug("sync", `mining skipped by gateway: ${miner.outcome}`);
        return { status: "skipped-gateway", ...base, minedSessions: 0, miner };
      }
      default: {
        // settings_conflict / error: real failures — back off before retrying.
        saveState({
          ...state,
          last_attempt_at: now().toISOString(),
          consecutive_failures: state.consecutive_failures + 1,
        });
        logger.debug("sync", `mining failed: ${miner.outcome}; ${miner.message ?? ""}`);
        return {
          status: "mine-failed",
          ...base,
          minedSessions: 0,
          miner,
          error: miner.message,
        };
      }
    }
  } finally {
    lock.release();
  }
}
