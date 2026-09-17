import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileLock, lockPath, STALE_LOCK_MS, stopSyncRun } from "./lock";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-lock-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fileLock", () => {
  it("acquires when no lock exists and writes its pid", () => {
    const lock = fileLock(dir);

    expect(lock.acquire()).toBe(true);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(String(process.pid));
  });

  it("a second lock loses the race while the first is held", () => {
    const first = fileLock(dir);
    const second = fileLock(dir);

    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
  });

  it("release removes the lock so the next run can acquire", () => {
    const lock = fileLock(dir);
    lock.acquire();
    lock.release();

    expect(existsSync(lockPath(dir))).toBe(false);
    expect(fileLock(dir).acquire()).toBe(true);
  });

  it("release without acquire is a no-op and never deletes a foreign lock", () => {
    // pid 1 (launchd/init) is always alive; kill(1, 0) fails with EPERM, not ESRCH.
    writeFileSync(lockPath(dir), "1");

    const lock = fileLock(dir);
    expect(lock.acquire()).toBe(false);
    lock.release();

    expect(readFileSync(lockPath(dir), "utf8")).toBe("1");
  });

  it("breaks a stale lock left by a crashed run", () => {
    writeFileSync(lockPath(dir), "1");
    const stale = new Date(Date.now() - STALE_LOCK_MS - 60 * 1000);
    utimesSync(lockPath(dir), stale, stale);

    const lock = fileLock(dir);

    expect(lock.acquire()).toBe(true);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(String(process.pid));
  });

  it("a fresh lock held by a live process is respected", () => {
    writeFileSync(lockPath(dir), "1");

    expect(fileLock(dir).acquire()).toBe(false);
  });

  it("breaks a fresh lock whose holder is dead", () => {
    // Out of macOS/Linux pid range, so kill(pid, 0) reports no such process.
    writeFileSync(lockPath(dir), "99999999");

    const lock = fileLock(dir);

    expect(lock.acquire()).toBe(true);
    expect(readFileSync(lockPath(dir), "utf8")).toBe(String(process.pid));
  });

  it("a fresh lock with an unparseable pid is respected until stale", () => {
    writeFileSync(lockPath(dir), "not-a-pid");

    expect(fileLock(dir).acquire()).toBe(false);

    const stale = new Date(Date.now() - STALE_LOCK_MS - 60 * 1000);
    utimesSync(lockPath(dir), stale, stale);
    expect(fileLock(dir).acquire()).toBe(true);
  });
});

describe("stopSyncRun", () => {
  it("SIGTERMs the process group and clears the holder's lock", () => {
    writeFileSync(lockPath(dir), "424242");
    const kill = vi.fn();

    expect(stopSyncRun(424242, dir, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-424242, "SIGTERM");
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("falls back to a single-pid kill when the group kill fails", () => {
    const kill = vi.fn((pid: number) => {
      if (pid < 0) throw new Error("ESRCH");
    });

    expect(stopSyncRun(424242, dir, kill)).toBe(true);
    expect(kill).toHaveBeenNthCalledWith(2, 424242, "SIGTERM");
  });

  it("still clears the lock when the process is already gone", () => {
    writeFileSync(lockPath(dir), "424242");
    const kill = vi.fn(() => {
      throw new Error("ESRCH");
    });

    expect(stopSyncRun(424242, dir, kill)).toBe(false);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  it("never touches a lock held by a different pid", () => {
    writeFileSync(lockPath(dir), "777");
    const kill = vi.fn();

    expect(stopSyncRun(424242, dir, kill)).toBe(true);
    expect(readFileSync(lockPath(dir), "utf8")).toBe("777");
  });

  it("rejects pids that could never name a run", () => {
    const kill = vi.fn();
    expect(stopSyncRun(0, dir, kill)).toBe(false);
    expect(stopSyncRun(-5, dir, kill)).toBe(false);
    expect(stopSyncRun(1.5, dir, kill)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
