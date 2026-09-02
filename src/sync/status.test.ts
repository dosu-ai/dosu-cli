import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSyncStatus } from "./status";
import { saveSyncState } from "./watermark";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-sync-status-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockFile = () => join(dir, "knowledge-sync.lock");

describe("getSyncStatus", () => {
  it("reports no run when there is no lock file", () => {
    const status = getSyncStatus({ configDir: dir, readLog: () => "" });
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.staleLock).toBeUndefined();
  });

  it("reports a running sync when the lock holder is alive", () => {
    writeFileSync(lockFile(), "4242");
    const started = new Date("2026-09-02T20:00:00Z");
    utimesSync(lockFile(), started, started);

    const status = getSyncStatus({
      configDir: dir,
      isProcessAlive: (pid) => pid === 4242,
      readLog: () => "",
    });

    expect(status.running).toBe(true);
    expect(status.pid).toBe(4242);
    expect(status.startedAt).toBe(started.toISOString());
    expect(status.staleLock).toBeUndefined();
  });

  it("flags a stale lock when the holder process is gone", () => {
    writeFileSync(lockFile(), "4242");
    const status = getSyncStatus({
      configDir: dir,
      isProcessAlive: () => false,
      readLog: () => "",
    });
    expect(status.running).toBe(false);
    expect(status.staleLock).toBe(true);
    expect(status.pid).toBe(4242);
  });

  it("treats a garbage lock file as a dead holder", () => {
    writeFileSync(lockFile(), "not-a-pid");
    const status = getSyncStatus({
      configDir: dir,
      isProcessAlive: (pid) => pid > 0,
      readLog: () => "",
    });
    expect(status.running).toBe(false);
    expect(status.staleLock).toBe(true);
  });

  it("recognizes its own live process via the default liveness check", () => {
    writeFileSync(lockFile(), String(process.pid));
    const status = getSyncStatus({ configDir: dir, readLog: () => "" });
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  it("includes the persisted watermark state and backoff", () => {
    const lastAttempt = new Date().toISOString();
    saveSyncState(
      {
        schema_version: 1,
        watermark: "2026-09-01T00:00:00Z",
        last_attempt_at: lastAttempt,
        consecutive_failures: 2,
      },
      dir,
    );

    const status = getSyncStatus({ configDir: dir, readLog: () => "" });
    expect(status.state.watermark).toBe("2026-09-01T00:00:00Z");
    expect(status.state.consecutive_failures).toBe(2);
    expect(status.backoffUntil).toBeDefined();
  });

  it("omits backoff when there are no failures", () => {
    saveSyncState({ schema_version: 1, watermark: null, consecutive_failures: 0 }, dir);
    const status = getSyncStatus({ configDir: dir, readLog: () => "" });
    expect(status.backoffUntil).toBeUndefined();
  });

  it("extracts recent sync/miner lines from the debug log, stripping the level", () => {
    const log = [
      "[2026-09-02T21:00:00Z] [DEBUG] [cli] starting",
      "[2026-09-02T21:00:01Z] [DEBUG] [sync] gate: 5 ready",
      "[2026-09-02T21:05:00Z] [INFO] [miner] run completed",
      "[2026-09-02T21:05:01Z] [DEBUG] [sync] mined 5 sessions",
      "",
    ].join("\n");

    const status = getSyncStatus({ configDir: dir, readLog: () => log });
    expect(status.recentActivity).toEqual([
      "[2026-09-02T21:00:01Z] [sync] gate: 5 ready",
      "[2026-09-02T21:05:00Z] [miner] run completed",
      "[2026-09-02T21:05:01Z] [sync] mined 5 sessions",
    ]);
  });

  it("caps recent activity at the last 10 lines", () => {
    const log = Array.from({ length: 25 }, (_, i) => `[t${i}] [DEBUG] [sync] line ${i}`).join("\n");
    const status = getSyncStatus({ configDir: dir, readLog: () => log });
    expect(status.recentActivity).toHaveLength(10);
    expect(status.recentActivity[9]).toContain("line 24");
  });
});
