import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import {
  buildProjectProxyCommand,
  isDosuMcpEntry,
  isDosuMcpEntryForProvider,
  isProjectProxyEntry,
  isProjectProxyEntryForProvider,
  isSafeProjectDeploymentID,
  ownedProjectProxyOptionsForProvider,
  ownedProjectProxyOptionsFromEntry,
  projectProxyOptionsFromEntry,
  recordProjectProxyEndpoint,
  resolveProjectProxyRuntime,
  runProjectProxy,
  sameProjectProxyTarget,
} from "./project-proxy";

const API_KEY = "dosu-secret-never-write-to-project";

function cloudConfig(overrides: Record<string, unknown> = {}): Config {
  return makeTestConfig({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Date.now() + 60_000,
    deployment_id: "dep-123",
    deployment_name: "Knowledge",
    api_key: API_KEY,
    mcp_endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
    ...overrides,
  });
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-project-proxy-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("buildProjectProxyCommand", () => {
  it("writes only a non-secret deployment reference into project config", () => {
    const command = buildProjectProxyCommand(cloudConfig());
    const serialized = JSON.stringify(command);

    expect(command.command).toBe("npx");
    expect(command.args).toContain("mcp");
    expect(command.args).toContain("proxy");
    expect(command.args).toContain("dep-123");
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("X-Dosu-API-Key");
    expect(serialized).not.toContain("api.dosu.dev");
  });

  it("marks OSS project entries without inventing a deployment", () => {
    const command = buildProjectProxyCommand(
      cloudConfig({ mode: "oss", deployment_id: undefined }),
    );

    expect(command.args).toContain("--oss");
    expect(command.args).not.toContain("--deployment");
  });

  it("rejects deployment IDs that could become Windows shell syntax", () => {
    expect(() =>
      buildProjectProxyCommand(cloudConfig({ deployment_id: "dep-a & calc.exe" })),
    ).toThrow(/invalid project deployment ID/i);
  });

  it("accepts only bounded identifiers with no shell metacharacters", () => {
    expect(isSafeProjectDeploymentID("dep-A_1.2:prod")).toBe(true);
    expect(isSafeProjectDeploymentID("x".repeat(256))).toBe(true);
    expect(isSafeProjectDeploymentID("x".repeat(257))).toBe(false);
    expect(isSafeProjectDeploymentID("-starts-with-dash")).toBe(false);
    expect(isSafeProjectDeploymentID(123)).toBe(false);
  });
});

describe("project proxy ownership", () => {
  it("recognizes only the exact checked-in command shape", () => {
    const command = buildProjectProxyCommand(cloudConfig());

    expect(isProjectProxyEntry(command)).toBe(true);
    expect(projectProxyOptionsFromEntry(command)).toEqual({ deploymentID: "dep-123" });
    expect(
      isProjectProxyEntry({
        type: "local",
        command: [command.command, ...command.args],
        enabled: true,
      }),
    ).toBe(true);
  });

  it("rejects a lookalike command, extra args, and secret-bearing entries", () => {
    const command = buildProjectProxyCommand(cloudConfig());

    expect(isProjectProxyEntry({ command: "npx", args: ["dosu", "mcp", "proxy"] })).toBe(false);
    expect(isProjectProxyEntry({ ...command, args: [...command.args, "--unexpected"] })).toBe(
      false,
    );
    expect(
      isProjectProxyEntry({
        ...command,
        headers: { "X-Dosu-API-Key": API_KEY },
      }),
    ).toBe(false);
    expect(isDosuMcpEntry({ command: "wrapper", args: ["dosu", "mcp", "proxy", "--oss"] })).toBe(
      false,
    );
    expect(
      isDosuMcpEntry({
        command: "npx",
        args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--deployment", "dep-a & calc.exe"],
      }),
    ).toBe(false);
  });

  it("recognizes an exact proxy emitted by an older released CLI for safe replacement", () => {
    expect(
      isDosuMcpEntry({
        command: "npx",
        args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--deployment", "dep-old"],
      }),
    ).toBe(true);
  });

  it("does not claim ownership of edited proxy or HTTP shapes with extra fields", () => {
    const command = buildProjectProxyCommand(cloudConfig());
    expect(isDosuMcpEntry({ ...command, userSetting: true })).toBe(false);
    expect(
      isDosuMcpEntry({
        type: "http",
        url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
        headers: { "X-Dosu-API-Key": API_KEY },
        userSetting: true,
      }),
    ).toBe(false);
  });

  it("does not treat another provider's released shape as ownership", () => {
    const standardDeployment = {
      type: "http",
      url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
      headers: { "X-Dosu-API-Key": API_KEY },
    };
    expect(isDosuMcpEntryForProvider("cursor", standardDeployment)).toBe(false);
    expect(isDosuMcpEntryForProvider("opencode", standardDeployment)).toBe(false);
    expect(isDosuMcpEntryForProvider("copilot", standardDeployment)).toBe(false);

    const ossStandard = { ...standardDeployment, url: "https://api.dosu.dev/v1/mcp" };
    expect(isDosuMcpEntryForProvider("cursor", ossStandard)).toBe(true);
    expect(isDosuMcpEntryForProvider("opencode", ossStandard)).toBe(true);
    expect(isDosuMcpEntryForProvider("copilot", ossStandard)).toBe(false);
  });

  it("parses every exact provider-specific proxy shape and rejects cross-provider shapes", () => {
    const args = ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--deployment", "dep-old"];
    const entries: Record<string, unknown> = {
      claude: { type: "stdio", command: "npx", args },
      gemini: { command: "npx", args },
      zed: { command: "npx", args, env: {} },
      opencode: { type: "local", command: ["npx", ...args], enabled: true },
    };

    for (const [provider, entry] of Object.entries(entries)) {
      expect(ownedProjectProxyOptionsForProvider(provider, entry)).toEqual({
        deploymentID: "dep-old",
      });
    }
    expect(ownedProjectProxyOptionsForProvider("zed", entries.gemini)).toBeNull();
    expect(ownedProjectProxyOptionsForProvider("opencode", entries.claude)).toBeNull();
    const current = buildProjectProxyCommand(cloudConfig());
    expect(isProjectProxyEntryForProvider("claude", { type: "stdio", ...current })).toBe(true);
    expect(isProjectProxyEntryForProvider("claude", null)).toBe(false);
  });

  it("rejects malformed command arrays, args, versions, and target tails", () => {
    const cases: unknown[] = [
      null,
      [],
      { command: ["npx", 7], type: "local", enabled: true },
      { command: 7, args: [] },
      { command: "npx", args: [7] },
      { command: "npx", args: ["-y", "@dosu/cli@latest", "mcp", "proxy", "--oss"] },
      { command: "npx", args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy"] },
      {
        command: "npx",
        args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--deployment", "bad value"],
      },
      { command: "npx", args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--oss"], env: [] },
    ];
    for (const entry of cases) expect(ownedProjectProxyOptionsFromEntry(entry)).toBeNull();
  });

  it("recognizes each released HTTP provider shape but rejects unsafe URLs", () => {
    const headers = { "X-Dosu-API-Key": API_KEY };
    const deploymentURL = "https://api.dosu.dev/v1/mcp/deployments/dep-123";
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["claude", { type: "http", url: deploymentURL, headers }],
      ["cursor", { url: deploymentURL, headers }],
      ["opencode", { type: "remote", enabled: true, url: deploymentURL, headers }],
      ["zed", { source: "custom", type: "http", url: deploymentURL, headers }],
      ["antigravity", { serverUrl: deploymentURL, headers }],
      ["copilot", { type: "http", url: deploymentURL, tools: ["*"], headers }],
    ];
    for (const [provider, entry] of shapes) {
      expect(isDosuMcpEntry(entry)).toBe(true);
      expect(isDosuMcpEntryForProvider(provider, entry)).toBe(true);
    }
    for (const url of [
      "file:///v1/mcp",
      "not a URL",
      `${deploymentURL}?leak=true`,
      `${deploymentURL}#fragment`,
      "https://api.dosu.dev/v1/mcp/deployments/a/b",
    ]) {
      expect(isDosuMcpEntry({ type: "http", url, headers })).toBe(false);
    }
    expect(
      isDosuMcpEntry({ type: "streamableHttp", disabled: true, url: deploymentURL, headers }),
    ).toBe(false);
    expect(isDosuMcpEntryForProvider("unknown", shapes[0][1])).toBe(false);
  });

  it("never claims a same-shaped MCP server on a foreign origin", () => {
    const headers = { "X-Dosu-API-Key": API_KEY };
    const url = "https://foreign.example/v1/mcp/deployments/dep-123";
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["claude", { type: "http", url, headers }],
      ["cursor", { url, headers }],
      ["vscode", { type: "http", url, headers }],
      ["gemini", { type: "http", url, headers }],
      ["zed", { source: "custom", type: "http", url, headers }],
      ["copilot", { type: "http", url, tools: ["*"], headers }],
      ["opencode", { type: "remote", enabled: true, url, headers }],
      ["antigravity", { serverUrl: url, headers }],
      ["mcporter", { type: "http", url, headers }],
      ["factory", { type: "http", url, headers }],
    ];

    for (const [provider, entry] of shapes) {
      expect(isDosuMcpEntry(entry)).toBe(false);
      expect(isDosuMcpEntryForProvider(provider, entry)).toBe(false);
    }
  });

  it("compares OSS and deployment targets without conflating them", () => {
    expect(sameProjectProxyTarget({ oss: true }, { oss: true })).toBe(true);
    expect(sameProjectProxyTarget({ oss: true }, { deploymentID: "dep-a" })).toBe(false);
    expect(sameProjectProxyTarget({ deploymentID: "dep-a" }, { deploymentID: "dep-a" })).toBe(true);
    expect(sameProjectProxyTarget({ deploymentID: "dep-a" }, { deploymentID: "dep-b" })).toBe(
      false,
    );
  });
});

describe("recordProjectProxyEndpoint", () => {
  it("stores the trusted endpoint in private user config state", () => {
    const cfg = cloudConfig({ mcp_endpoint: undefined });
    const saveCredential = vi.fn();
    recordProjectProxyEndpoint(cfg, { saveCredential });

    expect(cfg.active_account?.target?.mcp_endpoint).toContain("/v1/mcp/deployments/dep-123");
    expect(saveCredential).toHaveBeenCalledWith({
      userID: "test-user-id",
      targetKey: "deployment:dep-123",
      credential: {
        endpoint: expect.stringContaining("/v1/mcp/deployments/dep-123"),
        api_key: API_KEY,
      },
    });
  });

  it("records an OSS endpoint and rejects incomplete cloud credentials", () => {
    const saveCredential = vi.fn();
    const oss = cloudConfig({ mode: "oss", deployment_id: undefined, mcp_endpoint: undefined });
    recordProjectProxyEndpoint(oss, { saveCredential });
    expect(saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKey: "oss",
        credential: expect.objectContaining({ endpoint: expect.stringMatching(/\/v1\/mcp$/) }),
      }),
    );

    expect(() => recordProjectProxyEndpoint(cloudConfig({ deployment_id: undefined }))).toThrow(
      /deployment ID/i,
    );
    expect(() => recordProjectProxyEndpoint(cloudConfig({ api_key: undefined }))).toThrow(
      /API key/i,
    );
  });
});

describe("resolveProjectProxyRuntime", () => {
  it("loads the endpoint and key only from the matching user-level target", () => {
    expect(resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep-123" })).toEqual({
      endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
      apiKey: API_KEY,
    });
  });

  it("fails closed after the user switches to a different deployment", () => {
    expect(() => resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep-other" })).toThrow(
      /re-run.*setup/i,
    );
  });

  it("keeps different projects usable after the active deployment changes", () => {
    const cfg = cloudConfig({
      deployment_id: "dep-456",
      api_key: "key-for-dep-456",
      mcp_endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-456",
    });
    const credentials = {
      "deployment:dep-123": {
        endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
        api_key: API_KEY,
      },
      "deployment:dep-456": {
        endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-456",
        api_key: "key-for-dep-456",
      },
    };
    const readCredential = ({ targetKey }: { targetKey: string }) =>
      credentials[targetKey as keyof typeof credentials];

    expect(resolveProjectProxyRuntime(cfg, { deploymentID: "dep-123" }, readCredential)).toEqual({
      endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
      apiKey: API_KEY,
    });
    expect(
      resolveProjectProxyRuntime(cfg, { deploymentID: "dep-456" }, readCredential).apiKey,
    ).toBe("key-for-dep-456");
  });

  it("refuses a stored endpoint that is not a Dosu MCP path", () => {
    expect(() =>
      resolveProjectProxyRuntime(cloudConfig({ mcp_endpoint: "https://evil.test/collect" }), {
        deploymentID: "dep-123",
      }),
    ).toThrow(/invalid MCP endpoint/i);
  });

  it("fails closed when the user-level API key is missing", () => {
    expect(() =>
      resolveProjectProxyRuntime(cloudConfig({ api_key: undefined }), {
        deploymentID: "dep-123",
      }),
    ).toThrow(/API key/i);
  });

  it("resolves OSS credentials and rejects missing or contradictory targets", () => {
    const oss = cloudConfig({
      mode: "oss",
      deployment_id: undefined,
      mcp_endpoint: "https://api.dosu.dev/v1/mcp",
    });
    expect(resolveProjectProxyRuntime(oss, { oss: true })).toEqual({
      endpoint: "https://api.dosu.dev/v1/mcp",
      apiKey: API_KEY,
    });
    expect(() => resolveProjectProxyRuntime(oss, {})).toThrow(/exactly one project MCP target/i);
    expect(() => resolveProjectProxyRuntime(oss, { oss: true, deploymentID: "dep-a" })).toThrow(
      /exactly one project MCP target/i,
    );
  });

  it.each([
    ["invalid URL", "not a URL"],
    ["unsupported scheme", "file:///v1/mcp/deployments/dep-123"],
    ["wrong path", "https://api.dosu.dev/v1/mcp/deployments/other"],
    ["query", "https://api.dosu.dev/v1/mcp/deployments/dep-123?token=x"],
    ["fragment", "https://api.dosu.dev/v1/mcp/deployments/dep-123#x"],
    [
      "Windows shell metacharacters in userinfo",
      "https://user&whoami@api.dosu.dev/v1/mcp/deployments/dep-123",
    ],
    ["percent expansion syntax", "https://%25PATH%25@api.dosu.dev/v1/mcp/deployments/dep-123"],
  ])("rejects a stored endpoint with %s", (_name, endpoint) => {
    expect(() =>
      resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep-123" }, () => ({
        endpoint,
        api_key: API_KEY,
      })),
    ).toThrow(/invalid MCP endpoint/i);
  });

  it("does not fall back to the active API key when a stored record omits its key", () => {
    expect(() =>
      resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep-123" }, () => ({
        endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
        api_key: "",
      })),
    ).toThrow(/API key/i);
  });
});

describe("runProjectProxy", () => {
  it("passes the key through child env, never argv", async () => {
    const spawn = vi.fn().mockReturnValue({
      once(event: string, listener: (value: number) => void) {
        if (event === "close") listener(0);
        return this;
      },
    });

    await expect(
      runProjectProxy(
        { deploymentID: "dep-123" },
        {
          loadConfig: () => cloudConfig(),
          spawn: spawn as never,
          readCredential: () => undefined,
        },
      ),
    ).resolves.toBe(0);

    const [_command, args, options] = spawn.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain(API_KEY);
    expect(options.env.X_DOSU_API_KEY).toBe(API_KEY);
    expect(options.stdio).toBe("inherit");
    expect(options.shell).toBe(false);
    expect(options.detached).toBe(true);
  });

  it("launches npx.cmd through a shell on Windows without putting the key in argv", async () => {
    const spawn = vi.fn().mockReturnValue({
      once(event: string, listener: (value: number) => void) {
        if (event === "close") listener(0);
        return this;
      },
    });

    await expect(
      runProjectProxy(
        { deploymentID: "dep-123" },
        {
          loadConfig: () => cloudConfig(),
          spawn: spawn as never,
          readCredential: () => undefined,
          platform: "win32",
          findNpx: () => "C:\\Program Files\\nodejs\\npx.cmd",
        },
      ),
    ).resolves.toBe(0);

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("npx.cmd");
    expect(options.shell).toBe(true);
    expect(options.detached).toBe(false);
    expect(options.env.PATH).toMatch(/^C:\\Program Files\\nodejs;/);
    expect(JSON.stringify(args)).not.toContain(API_KEY);
  });

  it("forwards shutdown signals to the bridge and removes its listeners", async () => {
    const signals = new EventEmitter();
    const kill = vi.fn(() => true);
    const spawn = vi.fn().mockReturnValue({
      pid: 4321,
      once(_event: string, _listener: (value: number | null) => void) {
        return this;
      },
      kill,
    });
    let present = true;
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") present = false;
      if (signal === 0 && !present) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    const result = runProjectProxy(
      { deploymentID: "dep-123" },
      {
        loadConfig: () => cloudConfig(),
        spawn: spawn as never,
        signalSource: signals,
        readCredential: () => undefined,
        killProcessGroup,
      },
    );
    signals.emit("SIGTERM");

    await expect(result).resolves.toBe(0);
    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(kill).not.toHaveBeenCalled();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
  });

  it("does not let an early leader close hide a surviving POSIX descendant", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 9753;
    child.kill = vi.fn(() => true);
    const killProcessGroup = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("close", 0));
      // Signal 0 continues to report a surviving descendant after SIGKILL.
    });

    const result = runProjectProxy(
      { deploymentID: "dep-123" },
      {
        loadConfig: () => cloudConfig(),
        spawn: (() => child) as never,
        signalSource: signals,
        readCredential: () => undefined,
        killProcessGroup,
        killGraceMs: 1,
        shutdownDeadlineMs: 1,
      },
    );
    signals.emit("SIGTERM");

    await expect(result).resolves.toBe(1);
    expect(killProcessGroup).toHaveBeenCalledWith(-9753, "SIGTERM");
    expect(killProcessGroup).toHaveBeenCalledWith(-9753, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
    expect(signals.eventNames()).toEqual([]);
  });

  it("terminates the full Windows proxy tree and settles even without a child close event", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 2468;
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => child);
    const treeKiller = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    treeKiller.kill = vi.fn(() => true);
    const spawnTreeKiller = vi.fn(() => {
      queueMicrotask(() => treeKiller.emit("close", 0));
      return treeKiller;
    });

    const result = runProjectProxy(
      { deploymentID: "dep-123" },
      {
        loadConfig: () => cloudConfig(),
        spawn: spawn as never,
        signalSource: signals,
        readCredential: () => undefined,
        platform: "win32",
        findNpx: () => "C:\\Program Files\\nodejs\\npx.cmd",
        spawnTreeKiller: spawnTreeKiller as never,
      },
    );
    signals.emit("SIGTERM");

    await expect(result).resolves.toBe(0);
    expect(spawnTreeKiller).toHaveBeenCalledWith("taskkill", ["/PID", "2468", "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(signals.eventNames()).toEqual([]);
  });

  it("ignores an early Windows proxy close until taskkill reaches its hard deadline", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 1357;
    child.kill = vi.fn(() => true);
    const treeKiller = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    treeKiller.kill = vi.fn(() => true);

    const result = runProjectProxy(
      { deploymentID: "dep-123" },
      {
        loadConfig: () => cloudConfig(),
        spawn: (() => child) as never,
        signalSource: signals,
        readCredential: () => undefined,
        platform: "win32",
        findNpx: () => "C:\\node\\npx.cmd",
        spawnTreeKiller: (() => treeKiller) as never,
        shutdownDeadlineMs: 1,
      },
    );
    signals.emit("SIGHUP");
    queueMicrotask(() => child.emit("close", 0));

    await expect(result).resolves.toBe(1);
    expect(treeKiller.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(signals.eventNames()).toEqual([]);
  });

  it("returns one for a signal-like null exit and removes listeners", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn(() => true);
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return child;
    });
    await expect(
      runProjectProxy(
        { deploymentID: "dep-123" },
        {
          loadConfig: () => cloudConfig(),
          spawn: spawn as never,
          signalSource: signals,
          readCredential: () => undefined,
        },
      ),
    ).resolves.toBe(1);
    expect(signals.eventNames()).toEqual([]);
  });

  it("rejects bridge spawn errors and removes all signal listeners", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
    child.kill = vi.fn(() => true);
    const failure = new Error("bridge failed");
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit("error", failure));
      return child;
    });
    await expect(
      runProjectProxy(
        { deploymentID: "dep-123" },
        {
          loadConfig: () => cloudConfig(),
          spawn: spawn as never,
          signalSource: signals,
          readCredential: () => undefined,
        },
      ),
    ).rejects.toThrow("bridge failed");
    expect(signals.eventNames()).toEqual([]);
  });
});
