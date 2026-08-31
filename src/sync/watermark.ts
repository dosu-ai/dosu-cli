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

export interface SyncState {
  schema_version: number;
  /** ISO timestamp of the newest session already mined; null = never mined. */
  watermark: string | null;
  last_attempt_at?: string;
  consecutive_failures: number;
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
    return {
      schema_version: STATE_SCHEMA_VERSION,
      watermark: typeof raw.watermark === "string" ? raw.watermark : null,
      last_attempt_at: typeof raw.last_attempt_at === "string" ? raw.last_attempt_at : undefined,
      consecutive_failures:
        typeof raw.consecutive_failures === "number" && raw.consecutive_failures >= 0
          ? raw.consecutive_failures
          : 0,
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

export interface GateResult {
  /** Completed sessions newer than the watermark — the mining backlog. */
  ready: AgentSession[];
  /** Sessions newer than the watermark but still inside the quiet period. */
  inFlight: number;
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
  let inFlight = 0;
  for (const session of sessions) {
    const updated = Date.parse(session.updated);
    if (Number.isNaN(updated) || updated <= watermarkMs) continue;
    if (updated > completedBefore) {
      inFlight += 1;
    } else {
      ready.push(session);
    }
  }
  return { ready, inFlight };
}
