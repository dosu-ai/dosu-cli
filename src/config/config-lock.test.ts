import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    statSync: vi.fn(actual.statSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

import { getConfigDir, getConfigPath } from "./config";
import { CONFIG_REFRESH_LOCK_FILENAME, withConfigRefreshLock } from "./config-lock";

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("config refresh lock", () => {
  let originalXdg: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalXdg = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-config-lock-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([false, true])("cleans up after task failure=%s", async (shouldFail) => {
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    const task = vi.fn(async () => {
      expect(existsSync(lockPath)).toBe(true);
      if (shouldFail) throw new Error("task failed");
      return "done";
    });

    if (shouldFail) {
      await expect(withConfigRefreshLock(task)).rejects.toThrow("task failed");
    } else {
      await expect(withConfigRefreshLock(task)).resolves.toBe("done");
    }

    expect(task).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("reclaims a stale lock without leaving claim files", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(lockPath, JSON.stringify({ owner_id: "dead-owner", pid: 1234, created_at: 1 }), {
      mode: 0o600,
    });
    const task = vi.fn(async () => "recovered");

    await expect(
      withConfigRefreshLock(task, {
        isProcessAlive: () => false,
        ownerId: "new-owner",
      }),
    ).resolves.toBe("recovered");

    expect(task).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("wraps config-directory creation failures before running the task", async () => {
    const cause = fsError("EACCES");
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw cause;
    });
    const task = vi.fn(async () => "should not run");

    await expect(withConfigRefreshLock(task)).rejects.toMatchObject({
      name: "SessionPersistenceError",
      code: "SESSION_PERSISTENCE_ERROR",
      cause,
    });

    expect(task).not.toHaveBeenCalled();
  });

  it("removes the partial lock when writing its metadata fails", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    const cause = fsError("EIO");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw cause;
    });
    const task = vi.fn(async () => "should not run");

    await expect(withConfigRefreshLock(task)).rejects.toMatchObject({
      name: "SessionPersistenceError",
      cause,
    });

    expect(task).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes the lock when closing its descriptor fails", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    const cause = fsError("EIO");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(closeSync).mockImplementationOnce((fd) => {
      actual.closeSync(fd);
      throw cause;
    });
    const task = vi.fn(async () => "should not run");

    await expect(withConfigRefreshLock(task)).rejects.toMatchObject({
      name: "SessionPersistenceError",
      cause,
    });

    expect(task).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object metadata", "[]"],
    ["invalid metadata", JSON.stringify({ owner_id: 42, pid: "bad", created_at: null })],
  ])("reclaims a stale lock with %s", async (_description, contents) => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(lockPath, contents, { mode: 0o600 });
    const task = vi.fn(async () => "recovered");
    const now = Date.now() + 1_000;

    await expect(
      withConfigRefreshLock(task, {
        now: () => now,
        staleAgeMs: 0,
        ownerId: "new-owner",
      }),
    ).resolves.toBe("recovered");

    expect(task).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("retries acquisition when a malformed lock disappears during inspection", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(lockPath, "not-json", { mode: 0o600 });
    vi.mocked(statSync).mockImplementationOnce((path) => {
      unlinkSync(path);
      throw fsError("ENOENT");
    });
    const task = vi.fn(async () => "acquired");

    await expect(withConfigRefreshLock(task, { staleAgeMs: 0 })).resolves.toBe("acquired");

    expect(task).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("retries acquisition when a stale lock disappears after it is claimed", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(lockPath, JSON.stringify({ owner_id: "dead", pid: 1234, created_at: 1 }), {
      mode: 0o600,
    });
    vi.mocked(statSync).mockImplementationOnce((path) => {
      unlinkSync(path);
      throw fsError("ENOENT");
    });
    const task = vi.fn(async () => "acquired");

    await expect(
      withConfigRefreshLock(task, { isProcessAlive: () => false, ownerId: "new-owner" }),
    ).resolves.toBe("acquired");

    expect(task).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("uses process liveness to reclaim a lock left by a dead owner", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(lockPath, JSON.stringify({ owner_id: "dead", pid: 1234, created_at: 1 }), {
      mode: 0o600,
    });
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw fsError("ESRCH");
    });

    try {
      await expect(withConfigRefreshLock(async () => "recovered")).resolves.toBe("recovered");
    } finally {
      kill.mockRestore();
    }

    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not remove a successor lock installed before release", async () => {
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);

    await withConfigRefreshLock(async () => {
      unlinkSync(lockPath);
      writeFileSync(
        lockPath,
        JSON.stringify({ owner_id: "successor", pid: process.pid, created_at: Date.now() }),
        { mode: 0o600 },
      );
    });

    expect(existsSync(lockPath)).toBe(true);
  });

  it("bounds waiting without deleting a live process lock", async () => {
    getConfigPath();
    const lockPath = join(getConfigDir(), CONFIG_REFRESH_LOCK_FILENAME);
    writeFileSync(
      lockPath,
      JSON.stringify({ owner_id: "live-owner", pid: process.pid, created_at: 0 }),
      { mode: 0o600 },
    );
    let now = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const task = vi.fn(async () => "should not run");

    await expect(
      withConfigRefreshLock(task, {
        now: () => now,
        sleep,
        timeoutMs: 20,
        retryDelayMs: 10,
        ownerId: "waiting-owner",
      }),
    ).rejects.toMatchObject({
      name: "SessionPersistenceError",
      code: "SESSION_PERSISTENCE_ERROR",
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(task).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });
});
