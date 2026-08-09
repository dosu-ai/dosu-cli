import { mkdtempSync, rmSync } from "node:fs";
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

import { loadTelemetrySettings, setTelemetryConsent } from "../telemetry/settings";
import type { CommandTelemetry } from "../telemetry/telemetry";
import { _cliTelemetryInternals, createProgram, shouldRunBackgroundChecks } from "./cli";

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

  it("skips background notices for upgrade and hook entrypoints", () => {
    expect(shouldRunBackgroundChecks("upgrade", ["node", "dosu", "upgrade"])).toBe(false);
    expect(shouldRunBackgroundChecks("stop", ["node", "dosu", "hooks", "stop"])).toBe(false);
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

  it("has mcp command with add and list subcommands", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "add")).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "list")).toBeDefined();
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

  it("excludes telemetry controls and automatic hook entrypoints", () => {
    expect(_cliTelemetryInternals.shouldTrack("status")).toBe(true);
    expect(_cliTelemetryInternals.shouldTrack("hooks doctor")).toBe(true);
    expect(_cliTelemetryInternals.shouldTrack("telemetry status")).toBe(false);
    expect(_cliTelemetryInternals.shouldTrack("telemetry enable")).toBe(false);
    expect(_cliTelemetryInternals.shouldTrack("hooks user-prompt-submit")).toBe(false);
    expect(_cliTelemetryInternals.shouldTrack("hooks post-tool-use")).toBe(false);
    expect(_cliTelemetryInternals.shouldTrack("hooks stop")).toBe(false);
    expect(
      _cliTelemetryInternals.isHookEntrypoint(["node", "dosu", "hooks", "post-tool-use"]),
    ).toBe(true);
    expect(_cliTelemetryInternals.isHookEntrypoint(["node", "dosu", "hooks", "doctor"])).toBe(
      false,
    );
  });

  it("honors the master disable before creating an analytics ID", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "dosu-cli-telemetry-disabled-"));
    const originalConfigRoot = process.env.XDG_CONFIG_HOME;
    const originalDoNotTrack = process.env.DO_NOT_TRACK;
    process.env.XDG_CONFIG_HOME = configRoot;
    delete process.env.DO_NOT_TRACK;
    try {
      expect(setTelemetryConsent("analytics", true)).toBe(true);
      process.env.DO_NOT_TRACK = "1";

      expect(_cliTelemetryInternals.processTelemetry()).toBeUndefined();
      expect(loadTelemetrySettings().install_id).toBeUndefined();
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
      if (originalConfigRoot === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalConfigRoot;
      if (originalDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
      else process.env.DO_NOT_TRACK = originalDoNotTrack;
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
