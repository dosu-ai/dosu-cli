/**
 * Single-flight lock for knowledge sync.
 *
 * Hooks fire at every session end, so two syncs can easily overlap; a
 * second concurrent mining run would double-spend gateway tokens on the
 * same backlog. The loser of the lock race exits quietly — the next
 * trigger will pick up whatever is left.
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";

const LOCK_FILENAME = "knowledge-sync.lock";

/** Locks older than this are considered abandoned (crashed run) and broken. */
export const STALE_LOCK_MS = 15 * 60 * 1000;

export interface SyncLock {
  /** True when this process now holds the lock. */
  acquire(): boolean;
  release(): void;
}

export function lockPath(configDir: string = getConfigDir()): string {
  return join(configDir, LOCK_FILENAME);
}

export function fileLock(
  configDir: string = getConfigDir(),
  now: () => Date = () => new Date(),
): SyncLock {
  const path = lockPath(configDir);
  let held = false;

  const tryCreate = (): boolean => {
    try {
      // wx = O_CREAT|O_EXCL — atomic "create only if absent".
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };

  return {
    acquire() {
      if (tryCreate()) {
        held = true;
        return true;
      }
      try {
        const age = now().getTime() - statSync(path).mtimeMs;
        if (age > STALE_LOCK_MS) {
          rmSync(path, { force: true });
          held = tryCreate();
          return held;
        }
      } catch {
        // Raced with the holder's release; treat as busy.
      }
      return false;
    },
    release() {
      if (!held) return;
      held = false;
      try {
        // Only remove our own lock; never a newer holder's.
        if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid)) {
          rmSync(path, { force: true });
        }
      } catch {
        // Stale-lock breaking covers a failed release.
      }
    },
  };
}
