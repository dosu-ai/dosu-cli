import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

vi.mock("../version/update-check", () => ({ checkForUpdates: vi.fn() }));
vi.mock("../version/skill-update-check", () => ({ checkForSkillUpdates: vi.fn() }));
vi.mock("../version/pending-tasks-check", () => ({ checkForReadyTasks: vi.fn() }));

import { saveConfig } from "../config/config";
import type { CommandTelemetry } from "../telemetry/telemetry";
import { createProgram, shouldRunBackgroundChecks } from "./cli";

describe("CLI", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("creates a program with correct name", () => {
    const program = createProgram();
    expect(program.name()).toBe("dosu");
  });

  it("has version flag", () => {
    const program = createProgram();
    expect(program.version()).toMatch(/^v\d+/);
  });

  it("has an upgrade command", () => {
    const program = createProgram();
    const cmd = program.commands.find((command) => command.name() === "upgrade");
    expect(cmd?.description()).toContain("latest version");
  });

  it("skips background notices for upgrade and agent hot paths", () => {
    expect(shouldRunBackgroundChecks("upgrade", ["node", "dosu", "upgrade"])).toBe(false);
    expect(shouldRunBackgroundChecks("stop", ["node", "dosu", "hooks", "stop"])).toBe(false);
    expect(shouldRunBackgroundChecks("proxy", ["node", "dosu", "mcp", "proxy"])).toBe(false);
    expect(shouldRunBackgroundChecks("status", ["node", "dosu", "status"])).toBe(true);
  });

  it("has login command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "login");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Authenticate");
  });

  it("has logout command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "logout");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Clear saved credentials");
  });

  it("has status command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "status");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("status");
    expect(cmd?.options.find((o) => o.long === "--json")).toBeDefined();
  });

  it("has mcp command with add, list, and hidden proxy subcommands", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "add")).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "list")).toBeDefined();
    const proxy = mcpCmd?.commands.find((c) => c.name() === "proxy");
    expect(proxy).toBeDefined();
    expect(mcpCmd?.helpInformation()).not.toContain("proxy");
    expect(proxy?.options.find((o) => o.long === "--deployment")).toBeDefined();
    expect(proxy?.options.find((o) => o.long === "--oss")).toBeDefined();
  });

  it("has setup command with --deployment option", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "setup");
    expect(cmd).toBeDefined();
    const opts = cmd?.options.find((o) => o.long === "--deployment");
    expect(opts).toBeDefined();
  });

  it("setup exposes agent-mode flags", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "setup");
    expect(cmd?.options.find((o) => o.long === "--agent")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--tool")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--login-ticket")).toBeDefined();
  });

  it("login exposes ticket-flow flags (--request, --check, --json)", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "login");
    expect(cmd?.options.find((o) => o.long === "--request")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--check")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--json")).toBeDefined();
  });

  it("mcp add has --global flag", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const addCmd = mcpCmd?.commands.find((c) => c.name() === "add");
    const globalOpt = addCmd?.options.find((o) => o.long === "--global");
    expect(globalOpt).toBeDefined();
  });

  it("has --debug global option", () => {
    const program = createProgram();
    const debugOpt = program.options.find((o) => o.long === "--debug");
    expect(debugOpt).toBeDefined();
  });

  it("has logs command with --tail and --clear options", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "logs");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("debug logs");
    expect(cmd?.options.find((o) => o.long === "--tail")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--clear")).toBeDefined();
  });

  it("has telemetry privacy controls", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "telemetry");
    expect(cmd).toBeDefined();
    expect(cmd?.commands.map((subcommand) => subcommand.name())).toEqual([
      "status",
      "enable",
      "disable",
      "reset",
    ]);
  });

  it("records only the canonical command name and completes after an action", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "dosu-cli-telemetry-context-"));
    const originalConfigRoot = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configRoot;
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createProgram({ telemetry }).parseAsync(["node", "dosu", "logs"]);

      expect(telemetry.start).toHaveBeenCalledOnce();
      expect(telemetry.start).toHaveBeenCalledWith("logs", {
        mode: "cloud",
        isAuthenticated: false,
      });
      expect(telemetry.complete).toHaveBeenCalledWith(0);
      expect(telemetry.fail).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      rmSync(configRoot, { recursive: true, force: true });
      if (originalConfigRoot === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalConfigRoot;
    }
  });

  it("passes the current JWT identity to telemetry without passing the token", async () => {
    const configRoot = mkdtempSync(join(tmpdir(), "dosu-cli-telemetry-identity-"));
    const originalConfigRoot = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configRoot;
    const userID = "22222222-2222-4222-8222-222222222222";
    const payload = Buffer.from(
      JSON.stringify({ sub: userID, email: "user@example.com", private: "must-not-leak" }),
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      saveConfig({
        schema_version: 2,
        active_account: {
          user_id: userID,
          session: { access_token: accessToken, refresh_token: "refresh-secret", expires_at: 0 },
        },
      });

      await createProgram({ telemetry }).parseAsync(["node", "dosu", "logs"]);

      expect(telemetry.start).toHaveBeenCalledWith("logs", {
        mode: "cloud",
        isAuthenticated: true,
        user: { id: userID, email: "user@example.com" },
      });
      const calls = JSON.stringify(vi.mocked(telemetry.start).mock.calls);
      expect(calls).not.toContain(accessToken);
      expect(calls).not.toContain("refresh-secret");
      expect(calls).not.toContain("must-not-leak");
    } finally {
      logSpy.mockRestore();
      rmSync(configRoot, { recursive: true, force: true });
      if (originalConfigRoot === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalConfigRoot;
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not block a config-free command when config.json is a FIFO",
    () => {
      const configRoot = mkdtempSync(join(tmpdir(), "dosu-cli-telemetry-fifo-"));
      const configDir = join(configRoot, "dosu-cli");
      const configPath = join(configDir, "config.json");
      mkdirSync(configDir, { recursive: true });
      try {
        expect(spawnSync("mkfifo", [configPath]).status).toBe(0);
        const result = spawnSync("bun", ["run", "src/index.ts", "logs"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "1",
            DOSU_DEV: "false",
            DOSU_TELEMETRY_DISABLED: "0",
            DO_NOT_TRACK: "0",
            NODE_ENV: "test",
            XDG_CONFIG_HOME: configRoot,
          },
          timeout: 1_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
      } finally {
        rmSync(configRoot, { recursive: true, force: true });
      }
    },
  );

  it("preserves command output when telemetry start throws", async () => {
    const telemetry: CommandTelemetry = {
      start: vi.fn(() => {
        throw new Error("telemetry start failed");
      }),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        createProgram({ telemetry }).parseAsync(["node", "dosu", "logs"]),
      ).resolves.toBeDefined();
      expect(logSpy).toHaveBeenCalledWith("/tmp/test-debug.log");
      expect(telemetry.complete).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("preserves command output when telemetry completion rejects", async () => {
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockRejectedValue(new Error("telemetry completion failed")),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        createProgram({ telemetry }).parseAsync(["node", "dosu", "logs"]),
      ).resolves.toBeDefined();
      expect(logSpy).toHaveBeenCalledWith("/tmp/test-debug.log");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("bounds a telemetry completion that never settles", async () => {
    vi.useFakeTimers();
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn(() => new Promise<void>(() => {})),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const command = createProgram({ telemetry }).parseAsync(["node", "dosu", "logs"]);
      await vi.advanceTimersByTimeAsync(750);
      await expect(command).resolves.toBeDefined();
      expect(logSpy).toHaveBeenCalledWith("/tmp/test-debug.log");
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves validation behavior when telemetry failure reporting rejects", async () => {
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockRejectedValue(new Error("telemetry failure reporting failed")),
    };
    try {
      await expect(
        createProgram({ telemetry }).parseAsync(["node", "dosu", "definitely-unknown"]),
      ).resolves.toBeDefined();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("marks invalid CLI options as expected usage errors", async () => {
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      createProgram({ telemetry }).parseAsync(["node", "dosu", "setup", "--mode", "private"]),
    ).rejects.toMatchObject({ name: "CliUsageError", exitCode: 1 });

    expect(telemetry.start).toHaveBeenCalledWith("setup", expect.any(Object));
    expect(telemetry.complete).not.toHaveBeenCalled();
  });

  it("preserves the unknown-command exit code while marking it as expected", async () => {
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    try {
      await createProgram({ telemetry }).parseAsync(["node", "dosu", "definitely-unknown"]);

      expect(process.exitCode).toBe(1);
      expect(telemetry.fail).toHaveBeenCalledWith(
        expect.objectContaining({ name: "CliUsageError", exitCode: 1 }),
      );
      expect(telemetry.complete).not.toHaveBeenCalled();
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  it("does not record telemetry-control commands", async () => {
    const telemetry: CommandTelemetry = {
      start: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createProgram({ telemetry }).parseAsync(["node", "dosu", "telemetry", "status"]);
      expect(telemetry.start).not.toHaveBeenCalled();
      expect(telemetry.complete).not.toHaveBeenCalled();
      expect(telemetry.fail).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("has hooks command with entrypoint and lifecycle subcommands", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "hooks");
    expect(cmd).toBeDefined();
    const names = cmd?.commands.map((c) => c.name()) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        "user-prompt-submit",
        "post-tool-use",
        "stop",
        "status",
        "install",
        "uninstall",
        "doctor",
      ]),
    );
    const install = cmd?.commands.find((c) => c.name() === "install");
    expect(install?.options.find((o) => o.long === "--no-stop")).toBeDefined();
  });
});
