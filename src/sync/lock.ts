/** Single-flight lock for knowledge sync: concurrent mining runs would double-spend gateway
 * tokens on the same backlog. The loser of the lock race exits quietly. */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";

const LOCK_FILENAME = "knowledge-sync.lock";

/** Locks older than this are considered abandoned (crashed run) and broken. */
export const STALE_LOCK_MS = 15 * 60 * 1000;

/** True when a process with this pid exists; EPERM means alive but owned by another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
        // A dead holder is broken immediately so it can't block syncs for the full stale
        // window; an unparseable pid falls back to the age check.
        const holder = Number.parseInt(readFileSync(path, "utf8"), 10);
        const holderDead = Number.isInteger(holder) && holder > 0 && !processAlive(holder);
        if (age > STALE_LOCK_MS || holderDead) {
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
