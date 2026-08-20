import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigDir, getConfigPath } from "./config";
import { CONFIG_REFRESH_LOCK_FILENAME, withConfigRefreshLock } from "./config-lock";

describe("config refresh lock", () => {
  let originalXdg: string | undefined;
  let tempDir: string;

  beforeEach(() => {
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
