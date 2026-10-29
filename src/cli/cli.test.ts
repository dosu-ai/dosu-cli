import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
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
// The home screen takes over the terminal; the root action only has to reach it.
const { mockRunTUI } = vi.hoisted(() => ({ mockRunTUI: vi.fn(async () => {}) }));
vi.mock("../tui/tui", () => ({ runTUI: mockRunTUI }));
vi.mock("../version/incognito-backfill-check", () => ({ checkForIncognitoBackfill: vi.fn() }));
vi.mock("../version/mcp-refresh-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/mcp-refresh-check")>()),
  checkForMcpRefresh: vi.fn(),
  writeMcpRefreshCache: vi.fn(),
}));

import { createProgram, shouldRunBackgroundChecks, shouldRunMcpRefreshCheck } from "./cli";

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

  it("describes session capture in the root help", () => {
    const description = createProgram().description();
    expect(description).toMatch(/sessions/);
    expect(description).toMatch(/sessiondb server/);
  });

  it("does not expose the deleted product commands", () => {
    const names = new Set(createProgram().commands.map((c) => c.name()));
    for (const removed of ["ask", "docs", "review", "deployments", "skill", "telemetry", "org"]) {
      expect(names.has(removed)).toBe(false);
    }
    for (const kept of ["knowledge", "memory", "project", "setup", "mcp", "upgrade", "login"]) {
      expect(names.has(kept)).toBe(true);
    }
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

  it("skips background notices for upgrade", () => {
    expect(shouldRunBackgroundChecks("upgrade")).toBe(false);
    expect(shouldRunBackgroundChecks("status")).toBe(true);
  });

  it("skips background notices for the prompt-submit hook", () => {
    // Runs on every prompt while the user waits: no update check, no stderr notice.
    expect(shouldRunBackgroundChecks("knowledge context")).toBe(false);
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

  it("has mcp command with add, refresh, and list subcommands", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "add")).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "refresh")).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "list")).toBeDefined();
  });

  it("skips the automatic MCP refresh for setup, mcp refresh, and the hook-driven knowledge sync", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const refresh = mcpCmd?.commands.find((c) => c.name() === "refresh");
    const list = mcpCmd?.commands.find((c) => c.name() === "list");
    const setup = program.commands.find((c) => c.name() === "setup");
    const knowledgeCmd = program.commands.find((c) => c.name() === "knowledge");
    const sync = knowledgeCmd?.commands.find((c) => c.name() === "sync");
    if (!refresh || !list || !setup || !sync) throw new Error("commands missing");
    expect(shouldRunMcpRefreshCheck(setup)).toBe(false);
    expect(shouldRunMcpRefreshCheck(refresh)).toBe(false);
    expect(shouldRunMcpRefreshCheck(sync)).toBe(false);
    expect(shouldRunMcpRefreshCheck(list)).toBe(true);
    // Top-level commands that happen to share a subcommand's name still get the check.
    expect(shouldRunMcpRefreshCheck(new Command("refresh"))).toBe(true);
    expect(shouldRunMcpRefreshCheck(new Command("sync"))).toBe(true);
  });

  it("has setup command with --deployment option", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "setup");
    expect(cmd).toBeDefined();
    const opts = cmd?.options.find((o) => o.long === "--deployment");
    expect(opts).toBeDefined();
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

  it("has logs command with --tail, --follow, and --clear options", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "logs");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("debug logs");
    expect(cmd?.options.find((o) => o.long === "--tail")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--follow")).toBeDefined();
    expect(cmd?.options.find((o) => o.long === "--clear")).toBeDefined();
  });

  it("logs --follow prints history then streams appended lines", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "dosu-cli-follow-"));
    const logPath = join(dir, "debug.log");
    writeFileSync(logPath, "alpha\nbeta\n");
    const { logger } = await import("../debug/logger");
    const getLogPath = vi.mocked(logger.getLogPath);
    getLogPath.mockReturnValue(logPath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createProgram().parseAsync(["node", "dosu", "logs", "--follow", "-t", "1"]);
      expect(logSpy.mock.calls.join("\n")).toContain("beta");

      appendFileSync(logPath, "gamma\n");
      vi.advanceTimersByTime(600);
      expect(writeSpy.mock.calls.flat().join("")).toContain("gamma\n");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      logSpy.mockRestore();
      writeSpy.mockRestore();
      getLogPath.mockReturnValue("/tmp/test-debug.log");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs --follow without a log file waits for output", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "dosu-cli-follow-empty-"));
    const logPath = join(dir, "debug.log");
    const { logger } = await import("../debug/logger");
    const getLogPath = vi.mocked(logger.getLogPath);
    getLogPath.mockReturnValue(logPath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createProgram().parseAsync(["node", "dosu", "logs", "--follow"]);
      expect(logSpy.mock.calls.join("\n")).toContain("waiting for output");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      logSpy.mockRestore();
      getLogPath.mockReturnValue("/tmp/test-debug.log");
      rmSync(dir, { recursive: true, force: true });
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

  it.skipIf(process.platform === "win32")(
    "reads the prompt-submit hook payload from a redirected file",
    async () => {
      // `dosu knowledge context < payload.json` is how the hook is tested by hand. Under Bun a
      // file on stdin read as a stream after the CLI's startup awaits comes back empty, and
      // the hook then silently injects nothing.
      const root = mkdtempSync(join(tmpdir(), "dosu-cli-context-hook-"));
      mkdirSync(join(root, "dosu-cli"), { recursive: true });
      writeFileSync(
        join(root, "dosu-cli", "config.json"),
        JSON.stringify({
          schema_version: 2,
          active_account: {
            user_id: "u",
            session: { access_token: "t", refresh_token: "r", expires_at: 4102444800 },
            target: { api_key: "sk_user_test", deployment_id: "d" },
          },
        }),
      );
      const payload = join(root, "payload.json");
      writeFileSync(
        payload,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "s",
          prompt: "reduce the cost of the staleness agent",
          cwd: root,
        }),
      );
      const server = createServer((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ digest: "## Task Memory (Dosu)" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const child = spawn("bun", ["run", "src/index.ts", "knowledge", "context"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CI: "1",
            DOSU_DEV: "false",
            DOSU_BACKEND_URL_OVERRIDE: `http://127.0.0.1:${port}`,
            NODE_ENV: "test",
            XDG_CONFIG_HOME: root,
          },
          stdio: [openSync(payload, "r"), "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        await new Promise((resolve) => child.on("close", resolve));
        expect(JSON.parse(stdout)).toEqual({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "## Task Memory (Dosu)",
          },
        });
      } finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps an incognito agent's prompts and memory tool calls from the prompt-submit hook",
    async () => {
      // `dosu knowledge incognito on claude`, read from the state file the hook loads anyway.
      const root = mkdtempSync(join(tmpdir(), "dosu-cli-context-incognito-"));
      mkdirSync(join(root, "dosu-cli"), { recursive: true });
      writeFileSync(
        join(root, "dosu-cli", "config.json"),
        JSON.stringify({
          schema_version: 2,
          active_account: {
            user_id: "u",
            session: { access_token: "t", refresh_token: "r", expires_at: 4102444800 },
            target: { api_key: "sk_user_test", deployment_id: "d" },
          },
        }),
      );
      writeFileSync(
        join(root, "dosu-cli", "knowledge-sync.json"),
        JSON.stringify({
          schema_version: 3,
          sessions: {},
          consecutive_failures: 0,
          incognito_agents: ["claude"],
        }),
      );
      let requests = 0;
      const server = createServer((_req, res) => {
        requests++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ digest: "## Task Memory (Dosu)" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const hook = async (event: Record<string, unknown>): Promise<string> => {
        const payload = join(root, "payload.json");
        writeFileSync(payload, JSON.stringify({ session_id: "s", cwd: root, ...event }));
        const child = spawn("bun", ["run", "src/index.ts", "knowledge", "context"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CI: "1",
            DOSU_DEV: "false",
            DOSU_BACKEND_URL_OVERRIDE: `http://127.0.0.1:${port}`,
            NODE_ENV: "test",
            XDG_CONFIG_HOME: root,
          },
          stdio: [openSync(payload, "r"), "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        await new Promise((resolve) => child.on("close", resolve));
        return stdout;
      };
      try {
        const prompt = await hook({ hook_event_name: "UserPromptSubmit", prompt: "fix the build" });
        const tool = await hook({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__dosu__search_memory",
          tool_input: { query: "q" },
          tool_use_id: "toolu_1",
        });

        expect(prompt).toBe("");
        expect(JSON.parse(tool).hookSpecificOutput).toMatchObject({
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("dosu knowledge incognito off claude"),
        });
        expect(requests).toBe(0);
      } finally {
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(process.platform === "win32")(
    "settles a session of an incognito agent only its own processes can see, signed in or not",
    async () => {
      // Claude Code run with CLAUDE_CONFIG_DIR: `incognito off` from a plain shell cannot list
      // this session, so its prompt hook settles it while Claude Code is still listed.
      const root = mkdtempSync(join(tmpdir(), "dosu-cli-context-outside-"));
      const transcript = join(root, "claude-work", "projects", "-w", "s-outside.jsonl");
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ type: "user" })}\n`);
      const statePath = join(root, "dosu-cli", "knowledge-sync.json");
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify({
          schema_version: 3,
          sessions: {},
          consecutive_failures: 0,
          incognito_agents: ["claude"],
        }),
      );
      const payload = join(root, "payload.json");
      writeFileSync(
        payload,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "s-outside",
          transcript_path: transcript,
          prompt: "fix the build",
          cwd: root,
        }),
      );
      try {
        const child = spawn("bun", ["run", "src/index.ts", "knowledge", "context"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            CI: "1",
            DOSU_DEV: "false",
            HOME: root,
            NODE_ENV: "test",
            XDG_CONFIG_HOME: root,
            CLAUDE_CONFIG_DIR: join(root, "claude-work"),
          },
          stdio: [openSync(payload, "r"), "pipe", "pipe"],
        });
        await new Promise((resolve) => child.on("close", resolve));
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        expect(state.sessions["claude/s-outside"]).toMatchObject({
          outcome: "incognito",
          by_agent: true,
          path: transcript,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("rejects invalid CLI options as usage errors", async () => {
    await expect(
      createProgram().parseAsync(["node", "dosu", "setup", "--mode", "private"]),
    ).rejects.toMatchObject({ name: "CliUsageError", exitCode: 1 });
  });

  it("sets exit code 1 for an unknown command", async () => {
    const originalExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await createProgram().parseAsync(["node", "dosu", "definitely-unknown"]);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown command"));
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });

  describe("no arguments", () => {
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    afterEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
      mockRunTUI.mockReset();
    });

    it("launches the home screen on a terminal", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      await createProgram().parseAsync(["node", "dosu"]);
      expect(mockRunTUI).toHaveBeenCalledOnce();
    });

    it("prints help instead when stdin or stdout is not a terminal", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const program = createProgram();
      const helpSpy = vi.spyOn(program, "outputHelp").mockImplementation(() => {});
      await program.parseAsync(["node", "dosu"]);
      expect(mockRunTUI).not.toHaveBeenCalled();
      expect(helpSpy).toHaveBeenCalledOnce();
    });
  });

  it("does not expose the removed hooks command", () => {
    const program = createProgram();
    expect(program.commands.find((command) => command.name() === "hooks")).toBeUndefined();
  });
});
