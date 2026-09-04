/**
 * Knowledge-sync watermark — which sessions have already been mined, and
 * retry/backoff state for failed runs.
 *
 * The watermark is the mining pipeline's commit point: it advances only after
 * a successful mining run (never in the index-and-gate-only milestone), so
 * missed content is always retried on a later trigger. State lives in its own
 * file under the CLI config dir — deliberately not in `config.json`, which is
 * credential-bearing and rewritten by auth flows.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import type { AgentSession } from "../sessions/scan";

const STATE_FILENAME = "knowledge-sync.json";
const STATE_SCHEMA_VERSION = 1;

/** Sessions whose `updated` is newer than this are treated as still running. */
export const DEFAULT_QUIET_PERIOD_MS = 5 * 60 * 1000;

const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** One mined session, as recorded by a completed mining run. */
export interface MinedSessionRecord {
  /** When the run recorded this session (ISO). */
  at: string;
  /** The session's `harness/id`. */
  session: string;
  /** The session's project (workspace basename), when the scanner knew it. */
  project?: string;
}

/** How many mined-session history records the state file keeps. */
export const MINED_HISTORY_LIMIT = 500;

/**
 * A clean gateway refusal (consent off, credit limit, quota) from the most
 * recent mining attempt. Persisted so status surfaces (Activity view, --status)
 * can tell the user why mining is paused — quiet runs print nothing and the
 * refusal deliberately never triggers backoff, so without this it would be
 * visible only in the debug log. Cleared by the next successful run.
 */
interface SyncRefusal {
  at: string;
  outcome: string;
  message: string;
}

/**
 * The active mining run's baseline, written by the mining process when it
 * starts a run. Status viewers subtract baseline_mined from total_mined for
 * a run-scoped progress bar that survives reopening the TUI mid-run. Only
 * meaningful while the recorded pid holds the sync lock; a later run
 * overwrites it.
 */
interface SyncRun {
  pid: number;
  started_at: string;
  /** total_mined when this run started. */
  baseline_mined: number;
}

export interface SyncState {
  schema_version: number;
  /** ISO timestamp of the newest session already mined; null = never mined. */
  watermark: string | null;
  last_attempt_at?: string;
  consecutive_failures: number;
  /** Rolling mined-session history, oldest first, capped at MINED_HISTORY_LIMIT. */
  mined_sessions?: MinedSessionRecord[];
  /** All-time mined-session count — survives the history cap above. */
  total_mined?: number;
  /** All-time knowledge notes written by completed mining runs. */
  total_notes?: number;
  /**
   * All-time estimated tokens of investigation distilled: the chars÷4 token
   * estimate of every mined session's conversation. The analytics baseline —
   * future reads of the notes reuse this instead of re-learning it.
   */
  total_learning_tokens?: number;
  /** Why the last mining attempt was refused by the gateway, if it was. */
  last_refusal?: SyncRefusal;
  /** The active run's progress baseline; see SyncRun. */
  run?: SyncRun;
  /**
   * Absolute directories whose sessions get mined (subdirectories included).
   * Absent = everywhere, including directories that appear later. Sessions
   * whose directory can't be determined match UNKNOWN_PROJECT.
   */
  project_filter?: string[];
}

export function syncStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, STATE_FILENAME);
}

export function loadSyncState(configDir: string = getConfigDir()): SyncState {
  const empty: SyncState = {
    schema_version: STATE_SCHEMA_VERSION,
    watermark: null,
    consecutive_failures: 0,
  };
  const path = syncStatePath(configDir);
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (raw.schema_version !== STATE_SCHEMA_VERSION) return empty;
    const minedSessions = Array.isArray(raw.mined_sessions)
      ? (raw.mined_sessions as unknown[])
          .filter(
            (record): record is MinedSessionRecord =>
              typeof record === "object" &&
              record !== null &&
              typeof (record as MinedSessionRecord).at === "string" &&
              typeof (record as MinedSessionRecord).session === "string",
          )
          .map((record) => ({
            at: record.at,
            session: record.session,
            ...(typeof record.project === "string" ? { project: record.project } : {}),
          }))
      : [];
    const rawRefusal = raw.last_refusal as Partial<SyncRefusal> | undefined;
    const lastRefusal =
      rawRefusal &&
      typeof rawRefusal.at === "string" &&
      typeof rawRefusal.outcome === "string" &&
      typeof rawRefusal.message === "string"
        ? { at: rawRefusal.at, outcome: rawRefusal.outcome, message: rawRefusal.message }
        : undefined;
    const rawRun = raw.run as Partial<SyncRun> | undefined;
    const run =
      rawRun &&
      typeof rawRun.pid === "number" &&
      typeof rawRun.started_at === "string" &&
      typeof rawRun.baseline_mined === "number" &&
      rawRun.baseline_mined >= 0
        ? { pid: rawRun.pid, started_at: rawRun.started_at, baseline_mined: rawRun.baseline_mined }
        : undefined;
    return {
      schema_version: STATE_SCHEMA_VERSION,
      watermark: typeof raw.watermark === "string" ? raw.watermark : null,
      last_attempt_at: typeof raw.last_attempt_at === "string" ? raw.last_attempt_at : undefined,
      consecutive_failures:
        typeof raw.consecutive_failures === "number" && raw.consecutive_failures >= 0
          ? raw.consecutive_failures
          : 0,
      mined_sessions: minedSessions,
      total_mined:
        typeof raw.total_mined === "number" && raw.total_mined >= 0
          ? raw.total_mined
          : minedSessions.length,
      total_notes:
        typeof raw.total_notes === "number" && raw.total_notes >= 0 ? raw.total_notes : 0,
      total_learning_tokens:
        typeof raw.total_learning_tokens === "number" && raw.total_learning_tokens >= 0
          ? raw.total_learning_tokens
          : 0,
      ...(lastRefusal ? { last_refusal: lastRefusal } : {}),
      ...(run ? { run } : {}),
      ...(Array.isArray(raw.project_filter)
        ? {
            project_filter: (raw.project_filter as unknown[]).filter(
              (p): p is string => typeof p === "string",
            ),
          }
        : {}),
    };
  } catch {
    return empty;
  }
}

export function saveSyncState(state: SyncState, configDir: string = getConfigDir()): void {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = syncStatePath(configDir);
  // Write-then-rename, same discipline as config.json: hook-triggered syncs
  // can run concurrently and must never observe a torn state file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * When the previous run failed, the earliest time a background (hook) run
 * should try again: 15min · 2^(failures−1), capped at 24h. Returns null when
 * there is no backoff in force. Manual runs ignore this.
 */
export function backoffUntil(state: SyncState): Date | null {
  if (state.consecutive_failures === 0 || !state.last_attempt_at) return null;
  const last = Date.parse(state.last_attempt_at);
  if (Number.isNaN(last)) return null;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (state.consecutive_failures - 1), BACKOFF_MAX_MS);
  return new Date(last + delay);
}

/** Bucket for sessions whose working directory can't be determined. */
export const UNKNOWN_PROJECT = "(unknown)";

/** Whether dir is at or under base (path-boundary-aware prefix match). */
export function isUnderDir(dir: string, base: string): boolean {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  return dir === root || dir.startsWith(`${root}/`);
}

/**
 * Apply the mining directory filter; no/empty filter passes everything.
 * A session matches when its resolved directory sits at or under any picked
 * directory; unresolvable sessions match only the UNKNOWN_PROJECT entry.
 */
export function filterSessionsByProject(
  sessions: readonly AgentSession[],
  filter: readonly string[] | undefined,
  resolveDir: (session: AgentSession) => string | null,
): AgentSession[] {
  if (!filter || filter.length === 0) return [...sessions];
  const includeUnknown = filter.includes(UNKNOWN_PROJECT);
  const dirs = filter.filter((entry) => entry !== UNKNOWN_PROJECT);
  return sessions.filter((session) => {
    const dir = resolveDir(session);
    if (!dir) return includeUnknown;
    return dirs.some((base) => isUnderDir(dir, base));
  });
}

export interface GateResult {
  /** Completed sessions newer than the watermark — the mining backlog. */
  ready: AgentSession[];
  /**
   * Sessions newer than the watermark but still inside the quiet period —
   * live right now, queued once they go quiet.
   */
  open: AgentSession[];
}

/**
 * The gate that makes frequent hook triggers cheap: only sessions newer than
 * the watermark count, and only ones quiet long enough to be considered
 * complete — anything fresher is left for the next trigger.
 */
export function gateSessions(
  sessions: readonly AgentSession[],
  watermark: string | null,
  now: Date = new Date(),
  quietPeriodMs: number = DEFAULT_QUIET_PERIOD_MS,
): GateResult {
  const watermarkMs = watermark ? Date.parse(watermark) : Number.NEGATIVE_INFINITY;
  const completedBefore = now.getTime() - quietPeriodMs;

  const ready: AgentSession[] = [];
  const open: AgentSession[] = [];
  for (const session of sessions) {
    const updated = Date.parse(session.updated);
    if (Number.isNaN(updated) || updated <= watermarkMs) continue;
    if (updated > completedBefore) {
      open.push(session);
    } else {
      ready.push(session);
    }
  }
  return { ready, open };
}
