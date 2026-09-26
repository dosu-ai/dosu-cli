/** Knowledge-sync state: the shipping watermark, which advances only past sessions the ship
 * phase settled (shipped, or deliberately passed over). Kept out of config.json, which is
 * credential-bearing and rewritten by auth flows. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import type { AgentSession } from "../sessions/scan";

const STATE_FILENAME = "knowledge-sync.json";
/** 2: sessions go to the Dosu memory pipeline; 1 was the local learner era (see migrateV1). */
const STATE_SCHEMA_VERSION = 2;

/** Sessions whose `updated` is newer than this are treated as still running. */
export const DEFAULT_QUIET_PERIOD_MS = 5 * 60 * 1000;

const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** One shipped session, as recorded by a completed ship phase. */
export interface ShippedSessionRecord {
  /** When the phase shipped this session (ISO). */
  at: string;
  /** The session's `harness/id`. */
  session: string;
  /** The ingest task the backend accepted (202) for this session. */
  task_id: string;
  /** Shareable memory-session page, when the backend returned one. */
  session_url?: string;
  /** The session's project (workspace basename), when the scanner knew it. */
  project?: string;
}

/** How many shipped-session history records the state file keeps. */
export const SHIPPED_HISTORY_LIMIT = 500;

/** The active run's baseline; status viewers subtract baseline_shipped from total_shipped for a
 * run-scoped progress bar. Only meaningful while the recorded pid holds the sync lock. */
interface SyncRun {
  pid: number;
  started_at: string;
  /** total_shipped when this run started. */
  baseline_shipped: number;
}

export interface SyncState {
  schema_version: number;
  /** ISO timestamp of the newest session already shipped past; null = nothing yet. */
  watermark: string | null;
  last_attempt_at?: string;
  consecutive_failures: number;
  /** Rolling shipped-session history, oldest first, capped at SHIPPED_HISTORY_LIMIT. */
  shipped_sessions?: ShippedSessionRecord[];
  /** All-time shipped-session count — survives the history cap above. */
  total_shipped?: number;
  /** The active run's progress baseline; see SyncRun. */
  run?: SyncRun;
  /** Absolute directories whose sessions get shipped (subdirectories included); absent means
   * everywhere. Undeterminable directories match UNKNOWN_PROJECT. */
  project_filter?: string[];
  /** User pressed stop: quiet (hook-triggered) syncs skip until resumed. Cleared by the
   * Activity screen's resume or any manual `dosu knowledge sync`. */
  paused?: boolean;
  /** `false` = the user opted out of shipping transcripts (`dosu knowledge transcripts
   * disable`). Shipping is on by default, so only the opt-out is ever stored. */
  ship_transcripts?: false;
}

/** Whether finished sessions are shipped to Dosu memory: on unless the user opted out. */
export function isShippingEnabled(state: SyncState): boolean {
  return state.ship_transcripts !== false;
}

export function syncStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, STATE_FILENAME);
}

function emptyState(): SyncState {
  return { schema_version: STATE_SCHEMA_VERSION, watermark: null, consecutive_failures: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 ? value : undefined;
}

function parseShipped(value: unknown): ShippedSessionRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (record): record is ShippedSessionRecord =>
        isRecord(record) &&
        typeof record.at === "string" &&
        typeof record.session === "string" &&
        typeof record.task_id === "string",
    )
    .map((record) => ({
      at: record.at,
      session: record.session,
      task_id: record.task_id,
      ...(typeof record.session_url === "string" ? { session_url: record.session_url } : {}),
      ...(typeof record.project === "string" ? { project: record.project } : {}),
    }));
}

/** The shipping-progress fields, from wherever a schema keeps them. */
function parseProgress(raw: Record<string, unknown>): Omit<SyncState, "schema_version"> {
  const shipped = parseShipped(raw.shipped_sessions);
  return {
    watermark: typeof raw.watermark === "string" ? raw.watermark : null,
    ...(typeof raw.last_attempt_at === "string" ? { last_attempt_at: raw.last_attempt_at } : {}),
    consecutive_failures: nonNegative(raw.consecutive_failures) ?? 0,
    shipped_sessions: shipped,
    total_shipped: nonNegative(raw.total_shipped) ?? shipped.length,
  };
}

/** User choices shared by both schemas. */
function parseSettings(raw: Record<string, unknown>): Partial<SyncState> {
  return {
    ...(Array.isArray(raw.project_filter)
      ? {
          project_filter: (raw.project_filter as unknown[]).filter(
            (p): p is string => typeof p === "string",
          ),
        }
      : {}),
    ...(raw.paused === true ? { paused: true } : {}),
  };
}

/** Schema 1 kept the local learner's progress at the top level and shipping (then opt-in) under
 * `ship`. Only shipping progress carries over: memory has never seen what the learner studied,
 * so starting from the learner's watermark would skip those sessions forever. */
function migrateV1(raw: Record<string, unknown>): SyncState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    ...parseProgress(isRecord(raw.ship) ? raw.ship : {}),
    ...parseSettings(raw),
  };
}

export function loadSyncState(configDir: string = getConfigDir()): SyncState {
  const path = syncStatePath(configDir);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!isRecord(raw)) return emptyState();
    if (raw.schema_version === 1) return migrateV1(raw);
    if (raw.schema_version !== STATE_SCHEMA_VERSION) return emptyState();
    const rawRun = raw.run;
    const run =
      isRecord(rawRun) &&
      typeof rawRun.pid === "number" &&
      typeof rawRun.started_at === "string" &&
      nonNegative(rawRun.baseline_shipped) !== undefined
        ? {
            pid: rawRun.pid,
            started_at: rawRun.started_at,
            baseline_shipped: rawRun.baseline_shipped as number,
          }
        : undefined;
    return {
      schema_version: STATE_SCHEMA_VERSION,
      ...parseProgress(raw),
      ...(run ? { run } : {}),
      ...parseSettings(raw),
      ...(raw.ship_transcripts === false ? { ship_transcripts: false as const } : {}),
    };
  } catch {
    return emptyState();
  }
}

/** Persist the pause switch: load-modify-save so concurrent counters are not clobbered. */
export function setSyncPaused(paused: boolean, configDir: string = getConfigDir()): void {
  const state = loadSyncState(configDir);
  if (paused) state.paused = true;
  else delete state.paused;
  saveSyncState(state, configDir);
}

/** Forget everything shipped so the next run starts from scratch: watermark, history, lifetime
 * counter, and failure backoff (the backend dedupes re-shipped traces on content hash). User
 * settings survive — the project filter, the pause switch, and the shipping opt-out are
 * choices, not progress. Memory already built in Dosu is untouched. */
export function resetSyncState(configDir: string = getConfigDir()): void {
  const previous = loadSyncState(configDir);
  saveSyncState(
    {
      ...emptyState(),
      ...(previous.project_filter ? { project_filter: previous.project_filter } : {}),
      ...(previous.paused ? { paused: true } : {}),
      ...(previous.ship_transcripts === false ? { ship_transcripts: false as const } : {}),
    },
    configDir,
  );
}

/** Pass over everything that finished before `now`, so only later sessions ship. Setup calls
 * this when the user declines the backfill; the watermark never moves backwards. */
export function skipBacklog(now: Date = new Date(), configDir: string = getConfigDir()): void {
  const state = loadSyncState(configDir);
  if (state.watermark && Date.parse(state.watermark) >= now.getTime()) return;
  saveSyncState({ ...state, watermark: now.toISOString() }, configDir);
}

/** Persist the shipping switch: load-modify-save so counters are not clobbered. */
export function setShipTranscripts(enabled: boolean, configDir: string = getConfigDir()): void {
  const state = loadSyncState(configDir);
  if (enabled) delete state.ship_transcripts;
  else state.ship_transcripts = false;
  saveSyncState(state, configDir);
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

/** Earliest time a background run should retry after failure: 15min * 2^(failures-1), capped
 * at 24h; null when no backoff is in force. Manual runs ignore this. */
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

/** Apply the shipping directory filter (empty passes everything): a session matches at or under
 * any picked directory; unresolvable sessions match only UNKNOWN_PROJECT. */
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
  /** Completed sessions newer than the watermark — the ship backlog. */
  ready: AgentSession[];
  /** Sessions newer than the watermark but still inside the quiet period; queued once quiet. */
  open: AgentSession[];
}

/** The gate that makes frequent hook triggers cheap: only sessions newer than the watermark and
 * quiet long enough to be complete count; fresher ones wait for the next trigger. */
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
