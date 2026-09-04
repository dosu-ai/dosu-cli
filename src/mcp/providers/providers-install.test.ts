import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config";
import { type FlatTestConfig, makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig, MCP_REMOTE_VERSION } from "../config-helpers";

// --- Helpers ---

function makeCfg(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 3600_000,
    deployment_id: "dep-123",
    deployment_name: "my-deploy",
    api_key: "key-abc",
    ...overrides,
  });
}

// --- 1. Base provider (createJSONProvider) ---

describe("createJSONProvider (base)", () => {
  let tempDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-base-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install creates JSON config with dosu entry", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "test-config.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
    });

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(globalPath);
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.type).toBe("http");
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("OSS mode install uses base MCP URL without deployment ID", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "oss-config.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
    });

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const cfg = loadJSONConfig(globalPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.type).toBe("http");
    expect(cfg.mcpServers.dosu.url).toContain("/v1/mcp");
    expect(cfg.mcpServers.dosu.url).not.toContain("/deployments/");
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("install throws when deployment_id is missing", async () => {
    const { createJSONProvider } = await import("./base");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "nope.json"),
      topKey: "mcpServers",
    });

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("local install throws when localConfigPath is not provided", async () => {
    const { createJSONProvider } = await import("./base");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "g.json"),
      topKey: "mcpServers",
    });

    expect(() => provider.install(makeCfg(), false)).toThrow("does not support local installation");
  });

  it("local install writes to localConfigPath when provided", async () => {
    const { createJSONProvider } = await import("./base");
    const localPath = join(tempDir, "local", "mcp.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "g.json"),
      topKey: "mcpServers",
      localConfigPath: () => localPath,
    });

    provider.install(makeCfg(), false);

    const cfg = loadJSONConfig(localPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
  });

  it("global remove deletes dosu entry from JSON config", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "remove.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        mcpServers: { dosu: { url: "old" }, other: { url: "keep" } },
      }),
    );

    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
    });

    provider.remove(true);

    const cfg = loadJSONConfig(globalPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
    expect(cfg.mcpServers.other).toEqual({ url: "keep" });
  });

  it("local remove throws when localConfigPath is not provided", async () => {
    const { createJSONProvider } = await import("./base");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "g.json"),
      topKey: "mcpServers",
    });

    expect(() => provider.remove(false)).toThrow("does not support local removal");
  });

  it("local remove deletes dosu entry when localConfigPath is provided", async () => {
    const { createJSONProvider } = await import("./base");
    const localPath = join(tempDir, "local-rm", "mcp.json");
    mkdirSync(join(tempDir, "local-rm"), { recursive: true });
    writeFileSync(localPath, JSON.stringify({ mcpServers: { dosu: { url: "x" } } }));

    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "g.json"),
      topKey: "mcpServers",
      localConfigPath: () => localPath,
    });

    provider.remove(false);

    const cfg = loadJSONConfig(localPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("install with custom buildServer uses that shape", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "custom.json");

    const provider = createJSONProvider({
      providerName: "Custom",
      providerID: "custom",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "servers",
      buildServer: (cfg) => ({
        myUrl: `custom-${cfg.active_account?.target?.deployment_id}`,
      }),
    });

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(globalPath);
    expect(cfg.servers.dosu).toEqual({ myUrl: "custom-dep-123" });
  });
});

// --- 2. Codex provider (TOML-based) ---

describe("CodexProvider", () => {
  let tempDir: string;
  let origCodexHome: string | undefined;
  let origCwd: string;
  let origPath: string | undefined;
  let npxPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-codex-test-"));
    origCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(tempDir, "codex-home");
    origCwd = process.cwd();
    process.chdir(tempDir);
    origPath = process.env.PATH;
    const binDir = join(tempDir, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    npxPath = join(binDir, "npx");
    writeFileSync(npxPath, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = binDir;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origCodexHome !== undefined) {
      process.env.CODEX_HOME = origCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    process.env.PATH = origPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes TOML config with dosu section", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, "codex-home", "config.toml");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.dosu]");
    // Absolute npx + explicit PATH: config.toml is shared with Codex
    // desktop, which launches from the Dock with the minimal launchd PATH.
    expect(content).toContain(`command = "${npxPath}"`);
    expect(content).toContain(`mcp-remote@${MCP_REMOTE_VERSION}`);
    expect(content).toContain("/deployments/dep-123");
    expect(content).toContain("http-only");
    // The API key rides in the env block as a ${VAR} placeholder; argv never carries the raw key.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded by mcp-remote
    expect(content).toContain("X-Dosu-API-Key:${X_DOSU_API_KEY}");
    expect(content).toContain("[mcp_servers.dosu.env]");
    expect(content).toContain('X_DOSU_API_KEY = "key-abc"');
    expect(content).not.toContain("X-Dosu-API-Key:key-abc");
    // Codex desktop only renders MCP Apps for stdio servers, so the provider
    // must not write the remote-HTTP form.
    expect(content).not.toContain('type = "http"');
    expect(content).not.toContain("http_headers");
  });

  it("local install writes TOML config to .codex/config.toml in cwd", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, ".codex", "config.toml");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.dosu]");
  });

  it("OSS mode install writes base MCP URL to TOML config", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const configPath = join(tempDir, "codex-home", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("/v1/mcp");
    expect(content).not.toContain("/deployments/");
  });

  it("install throws when deployment_id is missing", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("install throws a clear error when npx is not on PATH", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    process.env.PATH = join(tempDir, "no-bin");

    expect(() => provider.install(makeCfg(), true)).toThrow(/npx/);
  });

  it("install replaces existing dosu section", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    // First install
    provider.install(makeCfg({ deployment_id: "old-dep", api_key: "old-key" }), true);

    // Second install should replace
    provider.install(makeCfg({ deployment_id: "new-dep", api_key: "new-key" }), true);

    const configPath = join(tempDir, "codex-home", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("new-dep");
    expect(content).not.toContain("old-dep");
    // Should only have one dosu section
    const matches = content.match(/\[mcp_servers\.dosu\]/g);
    expect(matches?.length).toBe(1);
  });

  it("install replaces a legacy remote-HTTP dosu section including http_headers", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    writeFileSync(
      configPath,
      '[mcp_servers.dosu]\ntype = "http"\nurl = "https://old.example"\n\n[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "old-key"\n',
    );

    provider.install(makeCfg(), true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain('type = "http"');
    expect(content).not.toContain("http_headers");
    expect(content).not.toContain("old-key");
    expect(content.match(/\[mcp_servers\.dosu\]/g)?.length).toBe(1);
    expect(content).toContain("mcp-remote");
  });

  it("install preserves other TOML content", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    writeFileSync(configPath, '[other_section]\nkey = "value"\n');

    provider.install(makeCfg(), true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[other_section]");
    expect(content).toContain('key = "value"');
    expect(content).toContain("[mcp_servers.dosu]");
  });

  it("global install replaces loose-permission TOML config with owner-only permissions", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    writeFileSync(configPath, '[other_section]\nkey = "value"\n', { mode: 0o644 });

    provider.install(makeCfg(), true);

    expect(readFileSync(configPath, "utf-8")).toContain("[mcp_servers.dosu]");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("global remove deletes dosu section from TOML", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, "codex-home", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain("[mcp_servers.dosu]");
  });

  it("local remove deletes dosu section from local TOML", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), false);
    provider.remove(false);

    const configPath = join(tempDir, ".codex", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain("[mcp_servers.dosu]");
  });

  it("remove does nothing when config file does not exist", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    const configPath = join(tempDir, "codex-home", "config.toml");
    expect(() => provider.remove(true)).not.toThrow();
    expect(existsSync(configPath)).toBe(false);
  });

  it("isConfigured returns true when dosu section exists", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), true);
    expect(provider.isConfigured()).toBe(true);
  });

  it("isConfigured returns false when config does not exist", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    expect(provider.isConfigured()).toBe(false);
  });

  it("getConfigPath uses CODEX_HOME for global path", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    expect(provider.globalConfigPath()).toBe(join(tempDir, "codex-home", "config.toml"));
  });
});

// --- 3. Copilot provider ---

describe("CopilotProvider", () => {
  let tempDir: string;
  let origXdgConfig: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-copilot-test-"));
    origXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-config");
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to XDG_CONFIG_HOME/mcp-config.json with mcpServers key", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, "xdg-config", "mcp-config.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.type).toBe("http");
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
    expect(cfg.mcpServers.dosu.tools).toEqual(["*"]);
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("local install writes to cwd/.vscode/mcp.json with servers key", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, ".vscode", "mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.servers).toBeDefined();
    expect(cfg.servers.dosu).toBeDefined();
    expect(cfg.servers.dosu.type).toBe("http");
    expect(cfg.servers.dosu.url).toContain("dep-123");
    // local config should not have tools key
    expect(cfg.servers.dosu.tools).toBeUndefined();
  });

  it("OSS mode install writes base MCP URL for global and local Copilot configs", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);
    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), false);

    const globalCfg = loadJSONConfig(join(tempDir, "xdg-config", "mcp-config.json"));
    expect(globalCfg.mcpServers.dosu.url).toContain("/v1/mcp");
    expect(globalCfg.mcpServers.dosu.url).not.toContain("/deployments/");

    const localCfg = loadJSONConfig(join(tempDir, ".vscode", "mcp.json"));
    expect(localCfg.servers.dosu.url).toContain("/v1/mcp");
    expect(localCfg.servers.dosu.url).not.toContain("/deployments/");
  });

  it("install throws when deployment_id is missing", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("global remove deletes dosu entry from mcpServers", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, "xdg-config", "mcp-config.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("local remove deletes dosu entry from servers", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), false);
    provider.remove(false);

    const configPath = join(tempDir, ".vscode", "mcp.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.servers.dosu).toBeUndefined();
  });

  it("install preserves existing entries", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    const configPath = join(tempDir, "xdg-config", "mcp-config.json");
    mkdirSync(join(tempDir, "xdg-config"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { url: "http://other" } } }));

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.other).toEqual({ url: "http://other" });
    expect(cfg.mcpServers.dosu).toBeDefined();
  });
});

// --- 4. MCPorter provider ---

describe("MCPorterProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-mcporter-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to ~/.mcporter/mcporter.json with mcpServers key", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, ".mcporter", "mcporter.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("global install uses .jsonc path if it exists", async () => {
    const jsoncPath = join(tempDir, ".mcporter", "mcporter.jsonc");
    mkdirSync(join(tempDir, ".mcporter"), { recursive: true });
    writeFileSync(jsoncPath, JSON.stringify({ mcpServers: {} }));

    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(jsoncPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
  });

  it("global install prefers .json over .jsonc when .json exists", async () => {
    const jsonPath = join(tempDir, ".mcporter", "mcporter.json");
    const jsoncPath = join(tempDir, ".mcporter", "mcporter.jsonc");
    mkdirSync(join(tempDir, ".mcporter"), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(jsoncPath, JSON.stringify({ mcpServers: {} }));

    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(jsonPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
  });

  it("local install writes to cwd/config/mcporter.json", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, "config", "mcporter.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
  });

  it("OSS mode install writes base MCP URL for MCPorter", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const configPath = join(tempDir, ".mcporter", "mcporter.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu.url).toContain("/v1/mcp");
    expect(cfg.mcpServers.dosu.url).not.toContain("/deployments/");
  });

  it("install throws when deployment_id is missing", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("global remove deletes dosu entry", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, ".mcporter", "mcporter.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("local remove deletes dosu entry", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), false);
    provider.remove(false);

    const configPath = join(tempDir, "config", "mcporter.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });
});

// --- 5. Manual provider ---

describe("ManualProvider", () => {
  it("install logs MCP config to console", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.install(makeCfg(), false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("dep-123");
    expect(allOutput).not.toContain("key-abc");
    expect(allOutput).toContain("Secret hidden");
    expect(allOutput).toContain("X-Dosu-API-Key");

    logSpy.mockRestore();
  });

  it("install logs the full API key when requested", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.install(makeCfg(), false, { showSecret: true });

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("key-abc");

    logSpy.mockRestore();
  });

  it("hides short API keys completely", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.install(makeCfg({ api_key: "shortkey" }), false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("X-Dosu-API-Key: [hidden]");
    expect(allOutput).not.toContain("shortkey");

    logSpy.mockRestore();
  });

  it("reveals less of medium-length API keys", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.install(makeCfg({ api_key: "abcdefghijkl" }), false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("X-Dosu-API-Key: abc...jkl");
    expect(allOutput).not.toContain("abcd...ijkl");
    expect(allOutput).not.toContain("abcdefghijkl");

    logSpy.mockRestore();
  });

  it("OSS mode install logs base MCP URL", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("/v1/mcp");
    expect(allOutput).not.toContain("/deployments/");

    logSpy.mockRestore();
  });

  it("remove logs removal instructions", async () => {
    const { ManualProvider } = await import("./manual");
    const provider = ManualProvider();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    provider.remove(false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("remove");

    logSpy.mockRestore();
  });
});

// --- 6. Claude Desktop provider ---

describe("ClaudeDesktopProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let origPath: string | undefined;
  let npxPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-claude-desktop-test-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    origPath = process.env.PATH;
    process.env.HOME = tempDir;
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg");
    const binDir = join(tempDir, "fake-bin");
    mkdirSync(binDir, { recursive: true });
    npxPath = join(binDir, "npx");
    writeFileSync(npxPath, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = binDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    process.env.PATH = origPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes an absolute-npx mcp-remote stdio entry with PATH env", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(provider.globalConfigPath());
    const dosu = cfg.mcpServers.dosu;
    expect(dosu).toBeDefined();
    // Claude Desktop launches servers with a minimal PATH, so the entry needs
    // an absolute npx plus a PATH env that lets npx's node shebang resolve.
    expect(dosu.command).toBe(npxPath);
    expect(dosu.args).toContain(`mcp-remote@${MCP_REMOTE_VERSION}`);
    expect(dosu.args.join(" ")).toContain("/deployments/dep-123");
    // Key in env as a ${VAR} placeholder — never in argv.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded by mcp-remote
    expect(dosu.args).toContain("X-Dosu-API-Key:${X_DOSU_API_KEY}");
    expect(dosu.args.join(" ")).not.toContain("key-abc");
    expect(dosu.env.X_DOSU_API_KEY).toBe("key-abc");
    expect(dosu.args).toContain("http-only");
    expect(dosu.env.PATH).toContain(dirname(npxPath));
    expect(dosu.url).toBeUndefined();
  });

  it("OSS mode install uses the base MCP URL", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const cfg = loadJSONConfig(provider.globalConfigPath());
    const args = cfg.mcpServers.dosu.args.join(" ");
    expect(args).toContain("/v1/mcp");
    expect(args).not.toContain("/deployments/");
  });

  it("install throws when deployment_id is missing", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("install throws a clear error when npx is not on PATH", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    process.env.PATH = join(tempDir, "no-bin");

    expect(() => provider.install(makeCfg(), true)).toThrow(/npx/);
  });

  it("local install throws because Claude Desktop is global-only", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    expect(() => provider.install(makeCfg(), false)).toThrow("does not support local installation");
  });

  it("remove deletes the dosu entry", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const cfg = loadJSONConfig(provider.globalConfigPath());
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("local remove throws because Claude Desktop is global-only", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    expect(() => provider.remove(false)).toThrow("does not support local removal");
  });

  it("install skips empty PATH segments when resolving npx", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    process.env.PATH = `:${dirname(npxPath)}`;
    provider.install(makeCfg(), true);

    const cfg = loadJSONConfig(provider.globalConfigPath());
    expect(cfg.mcpServers.dosu.command).toBe(npxPath);
  });

  it("isConfigured reflects presence of the dosu entry", async () => {
    const { ClaudeDesktopProvider } = await import("./claude-desktop");
    const provider = ClaudeDesktopProvider();

    expect(provider.isConfigured()).toBe(false);
    provider.install(makeCfg(), true);
    expect(provider.isConfigured()).toBe(true);
  });
});

// --- 7. createJSONProvider-based providers: Cursor, OpenCode, ClineCli, Antigravity, Zed ---
// (Cline excluded: it depends on platform-specific appSupportDir, hard to override via env)

describe("CursorProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-cursor-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to ~/.cursor/mcp.json with mcpServers key", async () => {
    const { CursorProvider } = await import("./cursor");
    const provider = CursorProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
    // Cursor does not include type in buildServer
    expect(cfg.mcpServers.dosu.type).toBeUndefined();
  });

  it("local install writes to cwd/.cursor/mcp.json", async () => {
    const { CursorProvider } = await import("./cursor");
    const provider = CursorProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
  });

  it("remove deletes dosu entry", async () => {
    const { CursorProvider } = await import("./cursor");
    const provider = CursorProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, ".cursor", "mcp.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });
});

describe("OpenCodeProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-opencode-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to ~/.config/opencode/opencode.json with mcp key", async () => {
    const { OpenCodeProvider } = await import("./opencode");
    const provider = OpenCodeProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, ".config", "opencode", "opencode.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcp.dosu).toBeDefined();
    expect(cfg.mcp.dosu.type).toBe("remote");
    expect(cfg.mcp.dosu.enabled).toBe(true);
    expect(cfg.mcp.dosu.url).toContain("dep-123");
  });

  it("local install writes to cwd/opencode.json", async () => {
    const { OpenCodeProvider } = await import("./opencode");
    const provider = OpenCodeProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, "opencode.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcp.dosu).toBeDefined();
  });

  it("remove deletes dosu entry", async () => {
    const { OpenCodeProvider } = await import("./opencode");
    const provider = OpenCodeProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, ".config", "opencode", "opencode.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcp.dosu).toBeUndefined();
  });
});

describe("ClineCliProvider", () => {
  let tempDir: string;
  let origClineDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-clinecli-test-"));
    origClineDir = process.env.CLINE_DIR;
    process.env.CLINE_DIR = join(tempDir, "cline-home");
  });

  afterEach(() => {
    if (origClineDir !== undefined) {
      process.env.CLINE_DIR = origClineDir;
    } else {
      delete process.env.CLINE_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to CLINE_DIR/data/settings/cline_mcp_settings.json", async () => {
    const { ClineCliProvider } = await import("./cline-cli");
    const provider = ClineCliProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, "cline-home", "data", "settings", "cline_mcp_settings.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
    expect(cfg.mcpServers.dosu.type).toBe("streamableHttp");
    expect(cfg.mcpServers.dosu.disabled).toBe(false);
    expect(cfg.mcpServers.dosu.url).toContain("dep-123");
  });

  it("install throws when deployment_id is missing", async () => {
    const { ClineCliProvider } = await import("./cline-cli");
    const provider = ClineCliProvider();

    expect(() => provider.install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      "deployment ID is required",
    );
  });

  it("remove deletes dosu entry", async () => {
    const { ClineCliProvider } = await import("./cline-cli");
    const provider = ClineCliProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, "cline-home", "data", "settings", "cline_mcp_settings.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("local install throws because ClineCli does not support local", async () => {
    const { ClineCliProvider } = await import("./cline-cli");
    const provider = ClineCliProvider();

    expect(() => provider.install(makeCfg(), false)).toThrow("does not support local installation");
  });
});

describe("AntigravityProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-antigravity-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to ~/.gemini/antigravity/mcp_config.json with mcpServers key", async () => {
    const { AntigravityProvider } = await import("./antigravity");
    const provider = AntigravityProvider();

    provider.install(makeCfg(), true);

    const configPath = join(tempDir, ".gemini", "antigravity", "mcp_config.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeDefined();
    // Antigravity uses serverUrl instead of url
    expect(cfg.mcpServers.dosu.serverUrl).toContain("dep-123");
    expect(cfg.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("local install throws because Antigravity does not support local", async () => {
    const { AntigravityProvider } = await import("./antigravity");
    const provider = AntigravityProvider();

    expect(() => provider.install(makeCfg(), false)).toThrow("does not support local installation");
  });

  it("remove deletes dosu entry", async () => {
    const { AntigravityProvider } = await import("./antigravity");
    const provider = AntigravityProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const configPath = join(tempDir, ".gemini", "antigravity", "mcp_config.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });
});

describe("ZedProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-zed-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("global install writes to settings.json with context_servers key", async () => {
    const { ZedProvider } = await import("./zed");
    const provider = ZedProvider();

    provider.install(makeCfg(), true);

    const globalCfgPath = provider.globalConfigPath();
    expect(existsSync(globalCfgPath)).toBe(true);
    const cfg = loadJSONConfig(globalCfgPath);
    expect(cfg.context_servers.dosu).toBeDefined();
    expect(cfg.context_servers.dosu.source).toBe("custom");
    expect(cfg.context_servers.dosu.type).toBe("http");
    expect(cfg.context_servers.dosu.url).toContain("dep-123");
  });

  it("local install writes to cwd/.zed/settings.json", async () => {
    const { ZedProvider } = await import("./zed");
    const provider = ZedProvider();

    provider.install(makeCfg(), false);

    const configPath = join(tempDir, ".zed", "settings.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.context_servers.dosu).toBeDefined();
  });

  it("remove deletes dosu entry globally", async () => {
    const { ZedProvider } = await import("./zed");
    const provider = ZedProvider();

    provider.install(makeCfg(), true);
    provider.remove(true);

    const globalCfgPath = provider.globalConfigPath();
    const cfg = loadJSONConfig(globalCfgPath);
    expect(cfg.context_servers.dosu).toBeUndefined();
  });

  it("local remove deletes dosu entry from local config", async () => {
    const { ZedProvider } = await import("./zed");
    const provider = ZedProvider();

    provider.install(makeCfg(), false);
    provider.remove(false);

    const configPath = join(tempDir, ".zed", "settings.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.context_servers.dosu).toBeUndefined();
  });
});
