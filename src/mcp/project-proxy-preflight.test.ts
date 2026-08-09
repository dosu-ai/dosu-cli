import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliSignalCleanup } from "../cli/signal-policy";
import { makeTestConfig } from "../config/config.test-utils";
import { preflightProjectProxy } from "./project-proxy-preflight";

const realProcessKill = process.kill.bind(process);

function config() {
  return makeTestConfig({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 1,
    deployment_id: "dep-a",
    api_key: "never-in-argv",
  });
}

function fakeChild(onWrite?: (value: string, stdout: EventEmitter) => void) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: { write(value: string): boolean };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 2_147_483_647;
  child.stdin = {
    write(value: string) {
      onWrite?.(value, child.stdout);
      return true;
    },
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close"));
    return true;
  });
  return child;
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
    realProcessKill(pid, 0);
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

describe("project proxy preflight", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === -2_147_483_647) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("runs the exact project command and requires an MCP initialize response", async () => {
    const child = fakeChild((value, stdout) => {
      const message = JSON.parse(value);
      if (message.method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "dosu", version: "1" },
              },
            })}\n`,
          ),
        );
      }
    });
    const spawn = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: { cwd: string; shell: boolean; detached: boolean },
      ) => child as never,
    );

    await expect(
      preflightProjectProxy(config(), "/repo", { spawn, timeoutMs: 100 }),
    ).resolves.toEqual({ ok: true, reason: "initialize_ok" });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("npx");
    expect(args).toEqual(expect.arrayContaining(["-y", "mcp", "proxy", "--deployment", "dep-a"]));
    expect(JSON.stringify(args)).not.toContain("never-in-argv");
    expect(options.cwd).toBe("/repo");
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(-2_147_483_647, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("launches the checked-in npx command through a shell on Windows", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-03-26",
                serverInfo: { name: "dosu", version: "1" },
              },
            })}\n`,
          ),
        );
      }
    });
    const spawn = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: { cwd: string; shell: boolean; detached: boolean },
      ) => child as never,
    );
    child.pid = 4321;
    const treeKiller = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    treeKiller.kill = vi.fn(() => true);
    const spawnTreeKiller = vi.fn(() => {
      queueMicrotask(() => treeKiller.emit("close", 0));
      return treeKiller;
    });

    await expect(
      preflightProjectProxy(config(), "C:\\repo", {
        spawn,
        platform: "win32",
        timeoutMs: 100,
        spawnTreeKiller: spawnTreeKiller as never,
      }),
    ).resolves.toEqual({ ok: true, reason: "initialize_ok" });

    expect(spawn.mock.calls[0][0]).toBe("npx");
    expect(spawn.mock.calls[0][2]).toMatchObject({
      cwd: "C:\\repo",
      shell: true,
      detached: false,
    });
    expect(spawnTreeKiller).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("resolves by a hard deadline when neither taskkill nor the proxy closes on Windows", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: 1,
              result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
            })}\n`,
          ),
        );
      }
    });
    child.pid = 9876;
    child.kill.mockImplementation(() => true);
    const treeKiller = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    treeKiller.kill = vi.fn(() => true);
    const spawnTreeKiller = vi.fn(() => treeKiller);

    await expect(
      preflightProjectProxy(config(), "C:\\repo", {
        spawn: (() => child) as never,
        platform: "win32",
        timeoutMs: 100,
        shutdownDeadlineMs: 1,
        spawnTreeKiller: spawnTreeKiller as never,
      }),
    ).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });

    expect(spawnTreeKiller).toHaveBeenCalledTimes(1);
    expect(treeKiller.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed when the exact proxy cannot initialize before the timeout", async () => {
    const child = fakeChild();
    child.pid = undefined;

    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 1,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("waits for a delayed child close before resolving", async () => {
    const child = fakeChild();
    child.pid = undefined;
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit("close"), 5);
      return true;
    });
    let resolved = false;
    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1,
      killGraceMs: 50,
    }).then((result) => {
      resolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(resolved).toBe(false);
    await expect(preflight).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("escalates to SIGKILL and reaps a child that ignores SIGTERM", async () => {
    const child = fakeChild();
    child.pid = undefined;
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close"));
      return true;
    });

    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 1,
        killGraceMs: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("reports a synchronous spawn failure without attempting protocol I/O", async () => {
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => {
          throw new Error("npx unavailable");
        }) as never,
      }),
    ).resolves.toEqual({ ok: false, reason: "spawn_failed" });
  });

  it("distinguishes child startup errors and early exits", async () => {
    const failed = fakeChild();
    const failedResult = preflightProjectProxy(config(), "/repo", {
      spawn: (() => failed) as never,
      timeoutMs: 100,
    });
    queueMicrotask(() => failed.emit("error", new Error("spawn failed")));
    await expect(failedResult).resolves.toEqual({ ok: false, reason: "spawn_failed" });

    const exited = fakeChild();
    const exitedResult = preflightProjectProxy(config(), "/repo", {
      spawn: (() => exited) as never,
      timeoutMs: 100,
    });
    queueMicrotask(() => exited.emit("close", 1));
    await expect(exitedResult).resolves.toEqual({ ok: false, reason: "process_exited" });
  });

  it("terminates and confirms a surviving POSIX group after the leader closes", async () => {
    const child = fakeChild();
    child.pid = 4242;
    let groupPresent = true;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGKILL") groupPresent = false;
      if (signal === 0 && !groupPresent) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });
    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 1,
      shutdownDeadlineMs: 20,
      killProcessGroup,
    });

    child.emit("close", 1);

    await expect(preflight).resolves.toEqual({ ok: false, reason: "process_exited" });
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, 0);
  });

  it("terminates and confirms the POSIX group after a child error", async () => {
    const child = fakeChild();
    child.pid = 4243;
    let groupPresent = true;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") groupPresent = false;
      if (signal === 0 && !groupPresent) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });
    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 20,
      killProcessGroup,
    });

    child.emit("error", new Error("leader failed"));

    await expect(preflight).resolves.toEqual({ ok: false, reason: "spawn_failed" });
    expect(killProcessGroup).toHaveBeenCalledWith(-4243, "SIGTERM");
    expect(killProcessGroup).toHaveBeenCalledWith(-4243, 0);
  });

  it("uses taskkill to confirm the Windows tree after the shell closes", async () => {
    const child = fakeChild();
    child.pid = 4321;
    const treeKiller = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    treeKiller.kill = vi.fn(() => true);
    const spawnTreeKiller = vi.fn(() => {
      queueMicrotask(() => treeKiller.emit("close", 0));
      return treeKiller;
    });
    const preflight = preflightProjectProxy(config(), "C:\\repo", {
      spawn: (() => child) as never,
      platform: "win32",
      timeoutMs: 1_000,
      spawnTreeKiller: spawnTreeKiller as never,
    });

    child.emit("close", 1);

    await expect(preflight).resolves.toEqual({ ok: false, reason: "process_exited" });
    expect(spawnTreeKiller).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("fails closed when a surviving group cannot be confirmed gone after leader close", async () => {
    const child = fakeChild();
    child.pid = 2468;
    const killProcessGroup = vi.fn(() => {});
    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 1,
      shutdownDeadlineMs: 1,
      killProcessGroup,
    });

    child.emit("close", 1);

    await expect(preflight).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });
  });

  it("rejects explicit initialize errors and malformed protocol replies", async () => {
    const cases: Array<[string, unknown]> = [
      ["initialize_rejected", { jsonrpc: "2.0", id: 1, error: { code: -32_000 } }],
      ["invalid_response", { jsonrpc: "2.0", id: 1, result: { protocolVersion: 7 } }],
      [
        "invalid_response",
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: [] } },
      ],
    ];

    for (const [reason, response] of cases) {
      const child = fakeChild((value, stdout) => {
        if (JSON.parse(value).method === "initialize") {
          queueMicrotask(() => stdout.emit("data", `${JSON.stringify(response)}\n`));
        }
      });
      await expect(
        preflightProjectProxy(config(), "/repo", {
          spawn: (() => child) as never,
          timeoutMs: 100,
        }),
      ).resolves.toEqual({ ok: false, reason });
    }
  });

  it("handles split lines, ignores unrelated messages, and accepts CRLF", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method !== "initialize") return;
      queueMicrotask(() => {
        stdout.emit("data", '{"jsonrpc":"2.0","id":99,"result":{}}\n');
        stdout.emit("data", '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025');
        stdout.emit("data", '-03-26","serverInfo":{"name":"dosu"}}}\r\n');
      });
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: true, reason: "initialize_ok" });
  });

  it("rejects malformed JSON and caps untrusted protocol output", async () => {
    const malformed = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() => stdout.emit("data", "not-json\n"));
      }
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => malformed) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_response" });

    const noisy = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() => stdout.emit("data", "x".repeat(1024 * 1024 + 1)));
      }
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => noisy) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_response" });
  });

  it("fails closed when the initialize write throws", async () => {
    const child = fakeChild();
    child.stdin.write = () => {
      throw new Error("broken pipe");
    };
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: false, reason: "spawn_failed" });
  });

  it("still resolves after signaling races with an already exiting child", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: 1,
              result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
            })}\n`,
          ),
        );
      }
    });
    child.pid = undefined;
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit("close"), 1);
      throw new Error("already exited");
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
        killGraceMs: 20,
      }),
    ).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });
  });

  it("ignores blank and non-object messages and makes completion idempotent", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method !== "initialize") return;
      queueMicrotask(() => {
        stdout.emit("data", "\nnull\n");
        stdout.emit(
          "data",
          `${JSON.stringify({
            id: 1,
            result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
          })}\n`,
        );
        stdout.emit("data", "not-json\n");
      });
    });
    child.kill.mockImplementation(() => {
      setTimeout(() => child.emit("close"), 2);
      return true;
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: true, reason: "initialize_ok" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("handles a child that closes synchronously while SIGTERM is sent", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: 1,
              result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
            })}\n`,
          ),
        );
      }
    });
    child.pid = undefined;
    child.kill.mockImplementation(() => {
      child.emit("close");
      return true;
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
        killGraceMs: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("does not authorize cleanup when the direct child closes before its POSIX group is gone", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: 1,
              result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
            })}\n`,
          ),
        );
      }
    });
    child.pid = 4242;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close"));
      // Signal 0 continues to report a surviving descendant after SIGKILL.
    });

    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
        killProcessGroup,
      }),
    ).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });
    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");
  });

  it.each([
    "SIGINT",
    "SIGTERM",
    "SIGHUP",
  ] as const)("turns %s into an interrupted result and waits for the whole group after an early close", async (signal) => {
    const child = fakeChild();
    child.pid = 4242;
    let groupPresent = true;
    const killProcessGroup = vi.fn((_pid: number, sent: NodeJS.Signals | 0) => {
      if (sent === "SIGTERM") queueMicrotask(() => child.emit("close"));
      if (sent === "SIGKILL") groupPresent = false;
      if (sent === 0 && !groupPresent) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });
    let signalCleanup: CliSignalCleanup | undefined;
    const unregister = vi.fn();
    const registerSignalCleanup = vi.fn((cleanup) => {
      signalCleanup = cleanup;
      return unregister;
    });

    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 1,
      shutdownDeadlineMs: 20,
      killProcessGroup,
      registerSignalCleanup,
    });
    expect(signalCleanup).toBeTypeOf("function");

    const cleanup = signalCleanup?.(signal);
    await expect(preflight).resolves.toEqual({ ok: false, reason: "interrupted" });
    await cleanup;

    expect(killProcessGroup).toHaveBeenCalledWith(-4242, "SIGKILL");
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("rejects guarded signal cleanup when tree shutdown cannot be confirmed", async () => {
    const child = fakeChild();
    child.pid = undefined;
    let signalCleanup: CliSignalCleanup | undefined;
    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 1,
      registerSignalCleanup: (cleanup) => {
        signalCleanup = cleanup;
        return () => {};
      },
    });

    const cleanup = Promise.resolve().then(() => signalCleanup?.("SIGINT"));
    await expect(preflight).resolves.toEqual({ ok: false, reason: "shutdown_unconfirmed" });
    await expect(cleanup).rejects.toThrow(/could not be confirmed/i);
  });

  it("does not authorize setup when a signal arrives during successful shutdown", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method === "initialize") {
        queueMicrotask(() =>
          stdout.emit(
            "data",
            `${JSON.stringify({
              id: 1,
              result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
            })}\n`,
          ),
        );
      }
    });
    child.pid = 8765;
    let groupPresent = true;
    let signalCleanup: CliSignalCleanup | undefined;
    let cleanup: Promise<void> | undefined;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          cleanup = Promise.resolve().then(() => signalCleanup?.("SIGINT"));
          groupPresent = false;
        });
      }
      if (signal === 0 && !groupPresent) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    const preflight = preflightProjectProxy(config(), "/repo", {
      spawn: (() => child) as never,
      timeoutMs: 1_000,
      killGraceMs: 20,
      killProcessGroup,
      registerSignalCleanup: (registered) => {
        signalCleanup = registered;
        return () => {};
      },
    });

    await expect(preflight).resolves.toEqual({ ok: false, reason: "interrupted" });
    await cleanup;
  });

  it.skipIf(process.platform === "win32")(
    "reaps a real detached descendant when interrupted during preflight",
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "dosu-preflight-signal-"));
      const descendantPIDPath = join(fixtureRoot, "descendant.pid");
      const descendantTerminatedPath = join(fixtureRoot, "descendant-terminated");
      const descendantScript = [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => { writeFileSync(process.argv[2], "SIGTERM"); process.exit(0); });',
        "writeFileSync(process.argv[1], String(process.pid));",
        "setInterval(() => {}, 1_000);",
      ].join("");
      const leaderScript = [
        'const { spawn } = require("node:child_process");',
        'process.on("SIGTERM", () => {});',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1], process.argv[2]], { stdio: "ignore" });`,
        'child.once("exit", () => process.exit(0));',
        "process.stdin.resume();",
        "setInterval(() => {}, 1_000);",
      ].join("");
      let leaderPID: number | undefined;
      let descendantPID: number | undefined;
      let signalCleanup: CliSignalCleanup | undefined;
      let testFailure: unknown;

      try {
        const preflight = preflightProjectProxy(config(), fixtureRoot, {
          spawn: ((
            _command: string,
            _args: string[],
            options: {
              cwd: string;
              env: NodeJS.ProcessEnv;
              stdio: ["pipe", "pipe", "pipe"];
              shell: boolean;
              detached: boolean;
            },
          ) => {
            const child = spawnProcess(
              process.execPath,
              ["-e", leaderScript, descendantPIDPath, descendantTerminatedPath],
              options,
            );
            leaderPID = child.pid;
            return child as never;
          }) as never,
          timeoutMs: 10_000,
          killGraceMs: 50,
          shutdownDeadlineMs: 10_000,
          killProcessGroup: realProcessKill,
          registerSignalCleanup: (cleanup) => {
            signalCleanup = cleanup;
            return () => {
              signalCleanup = undefined;
            };
          },
        });

        expect(await waitUntil(() => readPositivePID(descendantPIDPath) !== undefined, 2_000)).toBe(
          true,
        );
        descendantPID = readPositivePID(descendantPIDPath);
        if (descendantPID === undefined) throw new Error("descendant PID was not published");
        expect(processExists(descendantPID)).toBe(true);
        expect(signalCleanup).toBeTypeOf("function");

        const cleanup = signalCleanup?.("SIGTERM");
        await expect(preflight).resolves.toEqual({ ok: false, reason: "interrupted" });
        await cleanup;
        expect(await waitUntil(() => existsSync(descendantTerminatedPath), 2_000)).toBe(true);
        expect(processExists(-(leaderPID as number))).toBe(false);
      } catch (error: unknown) {
        testFailure = error;
      }

      if (leaderPID) {
        try {
          realProcessKill(-leaderPID, "SIGKILL");
        } catch {
          // The guarded shutdown normally removes the complete group.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
      if (testFailure) throw testFailure;
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "reaps a real surviving descendant after its detached leader exits early",
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "dosu-preflight-early-exit-"));
      const descendantPIDPath = join(fixtureRoot, "descendant.pid");
      const descendantTerminatedPath = join(fixtureRoot, "descendant-terminated");
      const descendantScript = [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => { writeFileSync(process.argv[2], "SIGTERM"); process.exit(0); });',
        "writeFileSync(process.argv[1], String(process.pid));",
        "setInterval(() => {}, 1_000);",
      ].join("");
      const leaderScript = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}, process.argv[1], process.argv[2]], { stdio: "ignore" });`,
        "setTimeout(() => process.exit(7), 100);",
      ].join("");
      let leaderPID: number | undefined;
      let descendantPID: number | undefined;
      let testFailure: unknown;

      try {
        const preflight = preflightProjectProxy(config(), fixtureRoot, {
          spawn: ((
            _command: string,
            _args: string[],
            options: {
              cwd: string;
              env: NodeJS.ProcessEnv;
              stdio: ["pipe", "pipe", "pipe"];
              shell: boolean;
              detached: boolean;
            },
          ) => {
            const child = spawnProcess(
              process.execPath,
              ["-e", leaderScript, descendantPIDPath, descendantTerminatedPath],
              options,
            );
            leaderPID = child.pid;
            return child as never;
          }) as never,
          timeoutMs: 2_000,
          killGraceMs: 250,
          shutdownDeadlineMs: 10_000,
          killProcessGroup: realProcessKill,
        });

        expect(await waitUntil(() => readPositivePID(descendantPIDPath) !== undefined, 2_000)).toBe(
          true,
        );
        descendantPID = readPositivePID(descendantPIDPath);
        if (descendantPID === undefined) throw new Error("descendant PID was not published");
        expect(processExists(descendantPID)).toBe(true);
        await expect(preflight).resolves.toEqual({ ok: false, reason: "process_exited" });
        expect(await waitUntil(() => existsSync(descendantTerminatedPath), 2_000)).toBe(true);
        // An orphaned, already-dead descendant can remain visible as a zombie
        // until the host's PID 1 reaps it. The process-group probe is the
        // production contract: ESRCH proves no member remains signalable.
        expect(processExists(-(leaderPID as number))).toBe(false);
      } catch (error: unknown) {
        testFailure = error;
      }

      if (leaderPID) {
        try {
          realProcessKill(-leaderPID, "SIGKILL");
        } catch {
          // The guarded shutdown normally removes the complete group.
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true });
      if (testFailure) throw testFailure;
    },
    30_000,
  );

  it("resolves a protocol result received after an early close without double-settling", async () => {
    const child = fakeChild((value, stdout) => {
      if (JSON.parse(value).method !== "initialize") return;
      child.emit("close");
      stdout.emit(
        "data",
        `${JSON.stringify({
          id: 1,
          result: { protocolVersion: "2025-03-26", serverInfo: { name: "dosu" } },
        })}\n`,
      );
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({ ok: false, reason: "process_exited" });
  });

  it("survives a SIGKILL race after an ignored SIGTERM", async () => {
    const child = fakeChild();
    child.pid = undefined;
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        setTimeout(() => child.emit("close"), 1);
        throw new Error("already exited");
      }
      return true;
    });
    await expect(
      preflightProjectProxy(config(), "/repo", {
        spawn: (() => child) as never,
        timeoutMs: 1,
        killGraceMs: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
