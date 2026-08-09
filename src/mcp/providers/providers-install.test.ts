import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config";
import { type FlatTestConfig, makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig, MCP_REMOTE_VERSION } from "../config-helpers";
import { allSetupProviders } from "../providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 1. Base provider (createJSONProvider)
// ---------------------------------------------------------------------------

describe("createJSONProvider (base)", () => {
  let tempDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-base-test-")));
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

  it("project install requires an explicit project root", async () => {
    const { createJSONProvider } = await import("./base");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath: join(tempDir, "g.json"),
      topKey: "mcpServers",
      localConfigPath: (projectRoot) => join(projectRoot, "local", "mcp.json"),
    });

    expect(() => provider.install(makeCfg(), false)).toThrow("explicit project root");
    expect(() => provider.remove(false)).toThrow("explicit project root");
  });

  it("project install writes a secretless proxy entry to the explicit project root", async () => {
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

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const cfg = loadJSONConfig(localPath);
    expect(cfg.mcpServers.dosu).toMatchObject({
      type: "stdio",
      command: "npx",
    });
    expect(cfg.mcpServers.dosu.args.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
    expect(provider.projectConfigPath(tempDir)).toBe(localPath);
    expect(provider.isProjectConfigured(tempDir)).toBe(true);
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

  it("legacy global cleanup removes only an owned Dosu entry", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "legacy-owned.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "claude",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
      localConfigPath: (projectRoot) => join(projectRoot, ".test", "mcp.json"),
    });
    writeFileSync(
      globalPath,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
            headers: { "X-Dosu-API-Key": "old-key" },
          },
          other: { url: "https://example.com/mcp" },
        },
      }),
    );

    expect(provider.removeLegacyGlobal?.()).toBe(true);
    expect(loadJSONConfig(globalPath).mcpServers).toEqual({
      other: { url: "https://example.com/mcp" },
    });
  });

  it("legacy global cleanup leaves missing, malformed, and foreign entries untouched", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "legacy-safe.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "claude",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
      localConfigPath: (projectRoot) => join(projectRoot, ".test", "mcp.json"),
    });

    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(existsSync(globalPath)).toBe(false);

    const malformed = '{"mcpServers":{"dosu":';
    writeFileSync(globalPath, malformed);
    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(readFileSync(globalPath, "utf-8")).toBe(malformed);

    const foreign = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://foreign.example/v1/mcp/deployments/dep-123",
          headers: { "X-Dosu-API-Key": "foreign-key" },
        },
      },
    });
    writeFileSync(globalPath, foreign);
    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(readFileSync(globalPath, "utf-8")).toBe(foreign);
  });

  it("legacy global cleanup does not follow a symlinked parent directory", async () => {
    const { createJSONProvider } = await import("./base");
    const realParent = join(tempDir, "legacy-real-parent");
    const linkedParent = join(tempDir, "legacy-linked-parent");
    const globalPath = join(linkedParent, "legacy.json");
    const targetPath = join(realParent, "legacy.json");
    const target = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
          headers: { "X-Dosu-API-Key": "old-key" },
        },
      },
    });
    mkdirSync(realParent);
    writeFileSync(targetPath, target);
    symlinkSync(realParent, linkedParent);
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "claude",
      local: true,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
      localConfigPath: (projectRoot) => join(projectRoot, ".test", "mcp.json"),
    });

    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(lstatSync(linkedParent).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe(target);
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

    provider.install(makeCfg(), false, { projectRoot: tempDir });
    provider.remove(false, { projectRoot: tempDir });

    const cfg = loadJSONConfig(localPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });

  it("refuses to overwrite or remove a foreign project entry named dosu", async () => {
    const { createJSONProvider } = await import("./base");
    const localPath = join(tempDir, "foreign", "mcp.json");
    mkdirSync(dirname(localPath), { recursive: true });
    const foreign = { command: "other-server", args: ["serve"] };
    writeFileSync(localPath, JSON.stringify({ mcpServers: { dosu: foreign } }));
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

    expect(provider.isProjectConfigured(tempDir)).toBe(false);
    expect(() => provider.install(makeCfg(), false, { projectRoot: tempDir })).toThrow(
      "refusing to overwrite",
    );
    expect(() => provider.remove(false, { projectRoot: tempDir })).toThrow("refusing to remove");
    expect(loadJSONConfig(localPath).mcpServers.dosu).toEqual(foreign);
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

// ---------------------------------------------------------------------------
// 2. Codex provider (TOML-based)
// ---------------------------------------------------------------------------

describe("CodexProvider", () => {
  let tempDir: string;
  let origCodexHome: string | undefined;
  let origCwd: string;
  let origPath: string | undefined;
  let npxPath: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-codex-test-")));
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
    // The API key rides in the env block as a ${VAR} placeholder the proxy
    // expands — argv (visible via `ps`) never carries the raw key.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded by mcp-remote
    expect(content).toContain("X-Dosu-API-Key:${X_DOSU_API_KEY}");
    expect(content).toContain("[mcp_servers.dosu.env]");
    expect(content).toContain('X_DOSU_API_KEY = "key-abc"');
    expect(content).not.toContain("X-Dosu-API-Key:key-abc");
    // Codex desktop only renders MCP Apps (the Session Knowledge card) for
    // stdio servers — a remote-HTTP entry works for tools but never shows
    // the card, so the provider must not write that form.
    expect(content).not.toContain('type = "http"');
    expect(content).not.toContain("http_headers");
  });

  it("project install writes a secretless TOML config to the explicit project root", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".codex", "config.toml");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.dosu]");
    expect(content).toContain('command = "npx"');
    expect(content).toContain('"mcp", "proxy"');
    expect(content).toContain("dep-123");
    expect(content).not.toContain("key-abc");
    expect(provider.projectConfigPath(tempDir)).toBe(configPath);
    expect(provider.isProjectConfigured(tempDir)).toBe(true);
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

  it("preserves legacy global Codex config because it is shared with Desktop", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const configPath = join(tempDir, "codex-home", "config.toml");

    provider.install(makeCfg(), true);
    const current = readFileSync(configPath, "utf-8");
    expect(provider.removeLegacyGlobal).toBeUndefined();
    provider.removeLegacyGlobal?.();
    expect(readFileSync(configPath, "utf-8")).toBe(current);

    const historical =
      '[mcp_servers.dosu]\ntype = "http"\nurl = "https://api.dosu.dev/v1/mcp/deployments/dep-123"\n\n[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "old-key"\n';
    writeFileSync(configPath, historical);
    provider.removeLegacyGlobal?.();
    expect(readFileSync(configPath, "utf-8")).toBe(historical);
  });

  it("local remove deletes dosu section from local TOML", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });
    provider.remove(false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".codex", "config.toml");
    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain("[mcp_servers.dosu]");
  });

  it("refuses to overwrite or remove a foreign local dosu section", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const configPath = join(tempDir, ".codex", "config.toml");
    mkdirSync(dirname(configPath), { recursive: true });
    const foreign = '[mcp_servers.dosu]\ncommand = "other-server"\nargs = ["serve"]\n';
    writeFileSync(configPath, foreign);

    expect(provider.isProjectConfigured(tempDir)).toBe(false);
    expect(() => provider.install(makeCfg(), false, { projectRoot: tempDir })).toThrow(
      "refusing to overwrite",
    );
    expect(() => provider.remove(false, { projectRoot: tempDir })).toThrow("refusing to remove");
    expect(readFileSync(configPath, "utf-8")).toBe(foreign);
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

// ---------------------------------------------------------------------------
// 3. Copilot provider
// ---------------------------------------------------------------------------

describe("CopilotProvider", () => {
  let tempDir: string;
  let origXdgConfig: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-copilot-test-")));
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

  it("project install writes a secretless entry to root .mcp.json", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toMatchObject({ type: "stdio", command: "npx" });
    expect(cfg.mcpServers.dosu.args.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
    expect(provider.projectConfigPath(tempDir)).toBe(configPath);
    expect(provider.isProjectConfigured(tempDir)).toBe(true);
  });

  it("OSS mode install writes base MCP URL for global and local Copilot configs", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);
    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), false, {
      projectRoot: tempDir,
    });

    const globalCfg = loadJSONConfig(join(tempDir, "xdg-config", "mcp-config.json"));
    expect(globalCfg.mcpServers.dosu.url).toContain("/v1/mcp");
    expect(globalCfg.mcpServers.dosu.url).not.toContain("/deployments/");

    const localCfg = loadJSONConfig(join(tempDir, ".mcp.json"));
    expect(localCfg.mcpServers.dosu.args).toContain("--oss");
    expect(JSON.stringify(localCfg)).not.toContain("key-abc");
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

  it("legacy global cleanup removes an owned entry and ignores a foreign entry", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();
    const configPath = join(tempDir, "xdg-config", "mcp-config.json");

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
            tools: ["*"],
            headers: { "X-Dosu-API-Key": "old-key" },
          },
        },
      }),
    );
    expect(provider.removeLegacyGlobal?.()).toBe(true);
    expect(loadJSONConfig(configPath).mcpServers.dosu).toBeUndefined();

    const foreign = JSON.stringify({
      mcpServers: { dosu: { command: "other-server", args: ["serve"] } },
    });
    writeFileSync(configPath, foreign);
    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(foreign);
  });

  it("legacy global cleanup does not follow a Copilot parent symlink", async () => {
    const { CopilotProvider } = await import("./copilot");
    const configPath = join(tempDir, "xdg-config", "mcp-config.json");
    const realParent = join(tempDir, "copilot-real-parent");
    const targetPath = join(realParent, "mcp-config.json");
    const target = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
          tools: ["*"],
          headers: { "X-Dosu-API-Key": "old-key" },
        },
      },
    });
    mkdirSync(realParent);
    writeFileSync(targetPath, target);
    symlinkSync(realParent, dirname(configPath));
    const provider = CopilotProvider();

    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(lstatSync(dirname(configPath)).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe(target);
  });

  it("local remove deletes dosu entry from servers", async () => {
    const { CopilotProvider } = await import("./copilot");
    const provider = CopilotProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });
    provider.remove(false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".mcp.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
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

// ---------------------------------------------------------------------------
// 4. MCPorter provider
// ---------------------------------------------------------------------------

describe("MCPorterProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-mcporter-test-")));
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

  it("project install writes a secretless entry under the explicit project root", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, "config", "mcporter.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu.command).toBe("npx");
    expect(cfg.mcpServers.dosu.args.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
    expect(provider.projectConfigPath(tempDir)).toBe(configPath);
    expect(provider.isProjectConfigured(tempDir)).toBe(true);
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

  it("legacy global cleanup removes an owned entry from plain JSON", async () => {
    const jsonPath = join(tempDir, ".mcporter", "mcporter.json");
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
            headers: { "X-Dosu-API-Key": "old-key" },
          },
          other: { url: "https://example.com/mcp" },
        },
      }),
    );
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    expect(provider.removeLegacyGlobal?.()).toBe(true);
    expect(loadJSONConfig(jsonPath).mcpServers).toEqual({
      other: { url: "https://example.com/mcp" },
    });
  });

  it("legacy global cleanup preserves JSONC byte-for-byte", async () => {
    const jsoncPath = join(tempDir, ".mcporter", "mcporter.jsonc");
    mkdirSync(dirname(jsoncPath), { recursive: true });
    const jsonc = `{
  // This comment must not be lost during compatibility cleanup.
  "mcpServers": {
    "dosu": {
      "type": "http",
      "url": "https://api.dosu.dev/v1/mcp/deployments/dep-123",
      "headers": { "X-Dosu-API-Key": "old-key" }
    }
  }
}\n`;
    writeFileSync(jsoncPath, jsonc);
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(readFileSync(jsoncPath, "utf-8")).toBe(jsonc);
  });

  it("legacy global cleanup does not follow an MCPorter parent symlink", async () => {
    const realParent = join(tempDir, "mcporter-real-parent");
    const linkedParent = join(tempDir, ".mcporter");
    const targetPath = join(realParent, "mcporter.json");
    const target = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
          headers: { "X-Dosu-API-Key": "old-key" },
        },
      },
    });
    mkdirSync(realParent);
    writeFileSync(targetPath, target);
    symlinkSync(realParent, linkedParent);
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    expect(provider.removeLegacyGlobal?.()).toBe(false);
    expect(lstatSync(linkedParent).isSymbolicLink()).toBe(true);
    expect(readFileSync(targetPath, "utf-8")).toBe(target);
  });

  it("local remove deletes dosu entry", async () => {
    const { MCPorterProvider } = await import("./mcporter");
    const provider = MCPorterProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });
    provider.remove(false, { projectRoot: tempDir });

    const configPath = join(tempDir, "config", "mcporter.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Manual provider
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 6. Claude Desktop provider
// ---------------------------------------------------------------------------

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
    // Claude Desktop chat launches MCP servers with a minimal PATH that has
    // no Homebrew/nvm, so the entry needs an absolute npx plus a PATH env
    // that lets npx's node shebang resolve.
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

// ---------------------------------------------------------------------------
// 7. createJSONProvider-based providers: Cursor, OpenCode, ClineCli,
//    Antigravity, Zed
//    (Cline is excluded because it depends on appSupportDir which is
//    platform-specific and hard to override via env)
// ---------------------------------------------------------------------------

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

  it("project install writes a secretless entry to the explicit project root", async () => {
    const { CursorProvider } = await import("./cursor");
    const provider = CursorProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers.dosu.command).toBe("npx");
    expect(cfg.mcpServers.dosu.args.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
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

  it("project install writes OpenCode's local command shape without a secret", async () => {
    const { OpenCodeProvider } = await import("./opencode");
    const provider = OpenCodeProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, "opencode.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcp.dosu).toMatchObject({ type: "local", enabled: true });
    expect(cfg.mcp.dosu.command.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
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

  it("project install writes Zed's command shape without a secret", async () => {
    const { ZedProvider } = await import("./zed");
    const provider = ZedProvider();

    provider.install(makeCfg(), false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".zed", "settings.json");
    expect(existsSync(configPath)).toBe(true);
    const cfg = loadJSONConfig(configPath);
    expect(cfg.context_servers.dosu.command).toBe("npx");
    expect(cfg.context_servers.dosu.args.join(" ")).toContain("mcp proxy --deployment dep-123");
    expect(cfg.context_servers.dosu.env).toEqual({});
    expect(JSON.stringify(cfg)).not.toContain("key-abc");
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

    provider.install(makeCfg(), false, { projectRoot: tempDir });
    provider.remove(false, { projectRoot: tempDir });

    const configPath = join(tempDir, ".zed", "settings.json");
    const cfg = loadJSONConfig(configPath);
    expect(cfg.context_servers.dosu).toBeUndefined();
  });
});

describe("project-scoped provider matrix", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalCodexHome: string | undefined;
  let originalXdgConfigHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-project-provider-matrix-"));
    originalHome = process.env.HOME;
    originalCodexHome = process.env.CODEX_HOME;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = join(tempDir, "home");
    process.env.CODEX_HOME = join(tempDir, "codex-home");
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-home");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes every supported project provider under the explicit root without the API key", () => {
    const providers = allSetupProviders();
    const localProviders = providers.filter((provider) => provider.supportsLocal());
    expect(localProviders.map((provider) => provider.id())).toEqual([
      "claude",
      "cursor",
      "vscode",
      "gemini",
      "codex",
      "zed",
      "copilot",
      "opencode",
      "mcporter",
      "factory",
    ]);

    for (const provider of localProviders) {
      const projectRoot = join(tempDir, "projects", provider.id());
      provider.install(makeCfg(), false, { projectRoot });

      const configPath = provider.projectConfigPath(projectRoot);
      expect(configPath, provider.id()).not.toBeNull();
      expect(configPath?.startsWith(`${projectRoot}/`), provider.id()).toBe(true);
      expect(provider.isProjectConfigured(projectRoot), provider.id()).toBe(true);
      expect(readFileSync(configPath as string, "utf-8"), provider.id()).not.toContain("key-abc");

      provider.remove(false, { projectRoot });
      expect(provider.isProjectConfigured(projectRoot), provider.id()).toBe(false);
    }
  });

  it("keeps global-only providers global-only", () => {
    const projectRoot = join(tempDir, "project");
    for (const provider of allSetupProviders().filter((candidate) => !candidate.supportsLocal())) {
      expect(provider.projectConfigPath(projectRoot), provider.id()).toBeNull();
      expect(provider.isProjectConfigured(projectRoot), provider.id()).toBe(false);
      expect(() => provider.install(makeCfg(), false, { projectRoot }), provider.id()).toThrow(
        /does not support local installation/,
      );
    }
  });
});
