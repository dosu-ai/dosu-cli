/** Point-in-time pipeline status for `dosu knowledge sync --status`: lock holder liveness,
 * watermark/backoff state, and the latest sync activity from the debug log. */

import { readFileSync, statSync } from "node:fs";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { lockPath } from "./lock";
import { backoffUntil, loadSyncState, type SyncState } from "./watermark";

export interface SyncStatus {
  /** True when a live process holds the sync lock. */
  running: boolean;
  /** PID recorded in the lock file, when one exists. */
  pid?: number;
  /** When the current run took the lock (lock file mtime, ISO). */
  startedAt?: string;
  /** Lock file exists but its process is gone — a crashed run. */
  staleLock?: boolean;
  state: SyncState;
  /** Set when failed runs have quiet syncs waiting out a backoff. */
  backoffUntil?: string;
  /** Latest `[sync]` lines from the debug log, oldest first. */
  recentActivity: string[];
}

/** "950" / "~12k" / "~1.2M" — compact token counts for analytics lines. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1_000;
    return `~${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = tokens / 1_000_000;
  return `~${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}

export interface SyncStatusDeps {
  configDir?: string;
  isProcessAlive?: (pid: number) => boolean;
  /** Full debug-log contents; defaults to reading the logger's file. */
  readLog?: () => string;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but owned by someone else; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultReadLog(): string {
  try {
    return readFileSync(logger.getLogPath(), "utf-8");
  } catch {
    return "";
  }
}

function readLockFile(configDir: string): { pid: number; mtime: Date } | null {
  const path = lockPath(configDir);
  try {
    const pid = Number.parseInt(readFileSync(path, "utf-8"), 10);
    return { pid: Number.isNaN(pid) ? -1 : pid, mtime: statSync(path).mtime };
  } catch {
    return null;
  }
}

/** How many recent debug-log sync lines the status report includes. */
const ACTIVITY_LINES = 10;

function recentSyncActivity(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => line.includes("[sync]") || line.includes("[miner]"))
    .slice(-ACTIVITY_LINES)
    .map((line) => line.replace(/ \[(DEBUG|INFO|WARN|ERROR)\]/, ""));
}

export function getSyncStatus(deps: SyncStatusDeps = {}): SyncStatus {
  const configDir = deps.configDir ?? getConfigDir();
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const readLog = deps.readLog ?? defaultReadLog;

  const lock = readLockFile(configDir);
  const running = lock !== null && isProcessAlive(lock.pid);

  const state = loadSyncState(configDir);
  const retryAt = backoffUntil(state);

  return {
    running,
    ...(lock ? { pid: lock.pid, startedAt: lock.mtime.toISOString() } : {}),
    ...(lock && !running ? { staleLock: true } : {}),
    state,
    ...(retryAt ? { backoffUntil: retryAt.toISOString() } : {}),
    recentActivity: recentSyncActivity(readLog()),
  };
}
