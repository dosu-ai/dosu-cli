import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { terminatePosixProcessTree, terminateWindowsProcessTree } from "./process-tree";

function fakeChild(pid?: number) {
  return { pid, kill: vi.fn((_signal: NodeJS.Signals) => true) };
}

function fakeTreeKiller() {
  const process = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  process.kill = vi.fn(() => true);
  return process;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function readPositivePID(path: string): number | undefined {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(content)) return;
    const pid = Number.parseInt(content, 10);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return;
  }
}

describe("Windows process-tree shutdown", () => {
  it("runs taskkill against the complete PID tree without a shell", async () => {
    const child = fakeChild(4321);
    const treeKiller = fakeTreeKiller();
    const spawnTreeKiller = vi.fn(() => {
      queueMicrotask(() => treeKiller.emit("close", 0));
      return treeKiller;
    });

    await expect(
      terminateWindowsProcessTree(child, { spawnTreeKiller: spawnTreeKiller as never }),
    ).resolves.toBe("terminated");

    expect(spawnTreeKiller).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    "missing pid",
    "spawn throw",
    "taskkill error",
    "taskkill nonzero",
  ])("falls back to the shell kill for %s", async (scenario) => {
    const child = fakeChild(scenario === "missing pid" ? undefined : 1234);
    const treeKiller = fakeTreeKiller();
    const spawnTreeKiller = vi.fn(() => {
      if (scenario === "spawn throw") throw new Error("taskkill unavailable");
      if (scenario === "taskkill error") queueMicrotask(() => treeKiller.emit("error"));
      if (scenario === "taskkill nonzero") queueMicrotask(() => treeKiller.emit("close", 1));
      return treeKiller;
    });

    await expect(
      terminateWindowsProcessTree(child, { spawnTreeKiller: spawnTreeKiller as never }),
    ).resolves.toBe("unconfirmed");

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(spawnTreeKiller).toHaveBeenCalledTimes(scenario === "missing pid" ? 0 : 1);
  });

  it("resolves at the hard deadline even when both kill calls throw", async () => {
    const child = fakeChild(9999);
    child.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    const treeKiller = fakeTreeKiller();
    treeKiller.kill.mockImplementation(() => {
      throw new Error("already exited");
    });

    await expect(
      terminateWindowsProcessTree(child, {
        spawnTreeKiller: (() => treeKiller) as never,
        shutdownDeadlineMs: 1,
      }),
    ).resolves.toBe("unconfirmed");
    expect(treeKiller.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("POSIX process-group shutdown", () => {
  it.skipIf(process.platform === "win32")(
    "kills a real SIGTERM-resistant descendant in the detached process group",
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "dosu-process-tree-"));
      const descendantPIDPath = join(fixtureRoot, "descendant.pid");
      const descendantHeartbeatPath = join(fixtureRoot, "descendant.heartbeat");
      const descendantScript = [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        "writeFileSync(process.argv[1], String(process.pid));",
        "let heartbeat = 0;",
        "setInterval(() => writeFileSync(process.argv[2], String(++heartbeat)), 20);",
      ].join("");
      const leaderScript = [
        'const { spawn } = require("node:child_process");',
        'process.on("SIGTERM", () => {});',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1], process.argv[2]], { stdio: "ignore" });`,
        "setInterval(() => {}, 1_000);",
      ].join("");
      const leader = spawn(
        process.execPath,
        ["-e", leaderScript, descendantPIDPath, descendantHeartbeatPath],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      const leaderClosed = new Promise<void>((resolve) => leader.once("close", () => resolve()));
      let descendantPID: number | undefined;
      let testFailure: unknown;
      let statusChecks = 0;
      let lastGroupError:
        | { signal: NodeJS.Signals | 0; code: unknown; message: string }
        | undefined;
      const killProcessGroup = (pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) statusChecks += 1;
        try {
          process.kill(pid, signal);
        } catch (error: unknown) {
          lastGroupError = {
            signal,
            code:
              typeof error === "object" && error !== null && "code" in error
                ? error.code
                : undefined,
            message: error instanceof Error ? error.message : String(error),
          };
          throw error;
        }
      };

      try {
        expect(await waitUntil(() => readPositivePID(descendantPIDPath) !== undefined, 2_000)).toBe(
          true,
        );
        const parsedDescendantPID = readPositivePID(descendantPIDPath);
        if (parsedDescendantPID === undefined) throw new Error("descendant PID was not published");
        descendantPID = parsedDescendantPID;
        expect(processExists(parsedDescendantPID)).toBe(true);
        expect(
          await waitUntil(
            () =>
              existsSync(descendantHeartbeatPath) &&
              readFileSync(descendantHeartbeatPath).length > 0,
            2_000,
          ),
        ).toBe(true);

        const shutdownResult = await terminatePosixProcessTree(leader, {
          killProcessGroup,
          killGraceMs: 50,
          // Under the full parallel suite, SIGKILLed grandchildren can remain
          // visible as zombies or transiently return EPERM from kill(0) until
          // the OS schedules their reaper.
          // Keep the production hard deadline unchanged; this E2E gets a
          // generous confirmation window because it asserts confirmed reaping.
          shutdownDeadlineMs: 10_000,
        });
        expect(
          shutdownResult,
          `status checks=${statusChecks}; last group error=${JSON.stringify(lastGroupError)}`,
        ).toBe("terminated");
        const stoppedHeartbeat = readFileSync(descendantHeartbeatPath, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(readFileSync(descendantHeartbeatPath, "utf8")).toBe(stoppedHeartbeat);
      } catch (error: unknown) {
        testFailure = error;
      }

      let cleanupFailure: Error | undefined;
      if (leader.pid) {
        try {
          process.kill(-leader.pid, "SIGKILL");
        } catch {
          // The helper normally removes the complete group before cleanup.
        }
      }
      const leaderWasReaped = await Promise.race([
        leaderClosed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!leaderWasReaped) cleanupFailure = new Error("test process-group leader was not reaped");
      const pidToReap = descendantPID;
      if (pidToReap !== undefined) {
        try {
          process.kill(pidToReap, "SIGKILL");
        } catch {
          // The helper normally leaves no executing descendant. A zombie may
          // remain PID-visible until the platform's orphan reaper schedules it.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
      if (cleanupFailure) throw cleanupFailure;
      if (testFailure) throw testFailure;
    },
    30_000,
  );

  it("signals the negative group PID with TERM then KILL and confirms its exit", async () => {
    const child = fakeChild(4321);
    let present = true;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGKILL") present = false;
      if (signal === 0 && !present) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    await expect(
      terminatePosixProcessTree(child, {
        killProcessGroup,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
      }),
    ).resolves.toBe("terminated");
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to direct TERM/KILL without claiming confirmed cleanup when PID is absent", async () => {
    const child = fakeChild();

    await expect(
      terminatePosixProcessTree(child, { killGraceMs: 1, shutdownDeadlineMs: 1 }),
    ).resolves.toBe("unconfirmed");
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns unconfirmed by the hard deadline when a group survives SIGKILL", async () => {
    const child = fakeChild(2468);
    const killProcessGroup = vi.fn(() => {});

    await expect(
      terminatePosixProcessTree(child, {
        killProcessGroup,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
      }),
    ).resolves.toBe("unconfirmed");
    expect(killProcessGroup).toHaveBeenCalledWith(-2468, "SIGTERM");
    expect(killProcessGroup).toHaveBeenCalledWith(-2468, "SIGKILL");
  });

  it("continues from transient EPERM probes through KILL until absence is confirmed", async () => {
    const child = fakeChild(8642);
    let killed = false;
    let checksAfterKill = 0;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGKILL") killed = true;
      if (signal !== 0) return;
      if (!killed) throw Object.assign(new Error("term reaping"), { code: "EPERM" });
      checksAfterKill += 1;
      throw Object.assign(new Error(checksAfterKill === 1 ? "reaping" : "gone"), {
        code: checksAfterKill === 1 ? "EPERM" : "ESRCH",
      });
    });

    await expect(
      terminatePosixProcessTree(child, {
        killProcessGroup,
        killGraceMs: 1,
        shutdownDeadlineMs: 50,
      }),
    ).resolves.toBe("terminated");
    expect(killProcessGroup).toHaveBeenCalledWith(-8642, "SIGKILL");
    expect(checksAfterKill).toBe(2);
  });

  it.each(["gone", "forbidden"])("handles a group that is immediately %s", async (scenario) => {
    const child = fakeChild(777);
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error(scenario), { code: scenario === "gone" ? "ESRCH" : "EPERM" });
    });

    await expect(
      terminatePosixProcessTree(child, {
        killProcessGroup,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
      }),
    ).resolves.toBe(scenario === "gone" ? "terminated" : "unconfirmed");
  });
});
