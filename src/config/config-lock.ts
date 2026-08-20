import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SessionPersistenceError } from "../auth/session-errors";
import { getConfigDir } from "./config";

export const CONFIG_REFRESH_LOCK_FILENAME = "session-refresh.lock";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_AGE_MS = 30_000;

interface LockMetadata {
  owner_id: string;
  pid: number;
  created_at: number;
}

interface ConfigRefreshLockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleAgeMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  ownerId?: string;
}

/** Run a complete refresh operation while holding the config-directory lock. */
export async function withConfigRefreshLock<T>(
  task: () => Promise<T>,
  options: ConfigRefreshLockOptions = {},
): Promise<T> {
  const release = await acquireConfigRefreshLock(options);
  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireConfigRefreshLock(options: ConfigRefreshLockOptions): Promise<() => void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleAgeMs = options.staleAgeMs ?? DEFAULT_STALE_AGE_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const ownerId = options.ownerId ?? randomUUID();
  const configDir = getConfigDir();
  const lockPath = join(configDir, CONFIG_REFRESH_LOCK_FILENAME);

  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new SessionPersistenceError({ cause });
  }

  const deadline = now() + Math.max(0, timeoutMs);
  while (true) {
    try {
      createLockFile(lockPath, { owner_id: ownerId, pid: process.pid, created_at: now() });
      return () => releaseOwnedLock(lockPath, ownerId);
    } catch (cause) {
      if (!hasErrorCode(cause, "EEXIST")) {
        throw new SessionPersistenceError({ cause });
      }
    }

    if (claimAndRemoveStaleLock(lockPath, staleAgeMs, now(), isProcessAlive, ownerId)) {
      continue;
    }
    if (now() >= deadline) {
      throw new SessionPersistenceError({
        cause: new Error("Timed out waiting for another Dosu session refresh."),
      });
    }
    await sleep(Math.max(1, retryDelayMs));
  }
}

function createLockFile(lockPath: string, metadata: LockMetadata): void {
  const fd = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(metadata));
  } catch (cause) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the original write failure.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // A failed best-effort cleanup is reclaimed through the stale-lock path.
    }
    throw cause;
  }
  try {
    closeSync(fd);
  } catch (cause) {
    try {
      unlinkSync(lockPath);
    } catch {
      // A failed best-effort cleanup is reclaimed through the stale-lock path.
    }
    throw cause;
  }
}

function releaseOwnedLock(lockPath: string, ownerId: string): void {
  try {
    if (readLockMetadata(lockPath)?.owner_id === ownerId) unlinkSync(lockPath);
  } catch {
    // Cleanup must not mask the refresh result. A crashed/failed cleanup is stale-reclaimable.
  }
}

/**
 * Claim a stale inode with a hard link before unlinking the public lock path.
 * This prevents one waiter from deleting a replacement lock created by another waiter.
 */
function claimAndRemoveStaleLock(
  lockPath: string,
  staleAgeMs: number,
  now: number,
  isProcessAlive: (pid: number) => boolean,
  ownerId: string,
): boolean {
  let stale = false;
  try {
    const metadata = readLockMetadata(lockPath);
    if (metadata && Number.isInteger(metadata.pid) && metadata.pid > 0) {
      stale = !isProcessAlive(metadata.pid);
    } else {
      stale = now - statSync(lockPath).mtimeMs >= staleAgeMs;
    }
  } catch (cause) {
    return hasErrorCode(cause, "ENOENT");
  }
  if (!stale) return false;

  const claimPath = `${lockPath}.stale.${process.pid}.${ownerId}`;
  try {
    linkSync(lockPath, claimPath);
    const current = statSync(lockPath);
    const claimed = statSync(claimPath);
    if (current.dev !== claimed.dev || current.ino !== claimed.ino) return false;
    unlinkSync(lockPath);
    return true;
  } catch (cause) {
    return hasErrorCode(cause, "ENOENT");
  } finally {
    try {
      unlinkSync(claimPath);
    } catch {
      // The claim is best-effort cleanup and never grants lock ownership by itself.
    }
  }
}

function readLockMetadata(lockPath: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.owner_id !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.created_at !== "number"
    ) {
      return undefined;
    }
    return {
      owner_id: parsed.owner_id,
      pid: parsed.pid,
      created_at: parsed.created_at,
    };
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !hasErrorCode(cause, "ESRCH");
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function hasErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
