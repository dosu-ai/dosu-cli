import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config";
import { type FlatTestConfig, makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig, MCP_REMOTE_VERSION } from "../config-helpers";
import { restoreRunningInstall, stubRunningFromNpx } from "../running-install.test-utils";

// A one-off `npx @dosu/cli` doing the writing (and no dev mode): these tests pin the remote and
// mcp-remote forms written when there is no lasting Dosu install to run the local proxy with.
// providers-stdio.test.ts covers the proxy entries written when there is.
beforeEach(() => {
  vi.stubEnv("PATH", join(tmpdir(), "dosu-test-no-bin"));
  vi.stubEnv("DOSU_DEV", undefined);
  stubRunningFromNpx(tmpdir());
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreRunningInstall();
});

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

  it("resolves the endpoint for the active mode before calling a custom buildServer", async () => {
    const { createJSONProvider } = await import("./base");
    const globalPath = join(tempDir, "endpoint.json");
    const provider = createJSONProvider({
      providerName: "TestProvider",
      providerID: "test",
      local: false,
      priorityValue: 1,
      paths: [],
      globalPath,
      topKey: "mcpServers",
      buildServer: ({ url, headers }) => ({ endpoint: url, auth: headers["X-Dosu-API-Key"] }),
    });

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);
    const oss = loadJSONConfig(globalPath).mcpServers.dosu;
    expect(oss.endpoint).toMatch(/\/v1\/mcp$/);
    expect(oss.auth).toBe("key-abc");

    provider.install(makeCfg(), true);
    const cloud = loadJSONConfig(globalPath).mcpServers.dosu;
    expect(cloud.endpoint).toContain("/v2/mcp/deployments/dep-123");
    expect(cloud.auth).toBe("key-abc");
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
      buildServer: ({ url }) => ({ myUrl: `custom-${url.split("/").pop()}` }),
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

  /** Key lines of the root `[mcp_servers.dosu]` table, stopping at the next table header. */
  function dosuRootKeys(content: string): string[] {
    const lines = content.split("\n");
    const start = lines.indexOf("[mcp_servers.dosu]");
    if (start === -1) return [];
    const end = lines.findIndex((line, i) => i > start && line.startsWith("["));
    return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim());
  }

  // Codex defers every MCP tool behind tool_search unless the server opts out with
  // omit_tools_from = ["deferred"] (Codex 0.147.0+). It must sit on the root table, not in [.env].
  it.each([
    ["global", true, "codex-home/config.toml"],
    ["local", false, ".codex/config.toml"],
  ])("%s install keeps Dosu tools out of Codex's deferred set", async (_scope, global, rel) => {
    const { CodexProvider } = await import("./codex");

    CodexProvider().install(makeCfg(), global);

    const content = readFileSync(join(tempDir, rel), "utf-8");
    expect(dosuRootKeys(content)).toContain('omit_tools_from = ["deferred"]');
    expect(content.match(/omit_tools_from/g)?.length).toBe(1);
  });

  it("reinstall adds omit_tools_from to an existing entry and keeps other settings", async () => {
    const { CodexProvider } = await import("./codex");
    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    const before = `model = "gpt-5.5"

[mcp_servers.other]
command = "other-cmd"
omit_tools_from = []
`;
    const after = `
[profiles.fast]
model_reasoning_effort = "low"
`;
    const preChangeEntry = `
[mcp_servers.dosu]
command = "/usr/local/bin/npx"
args = ["-y", "mcp-remote@0.1.0", "https://api.dosu.dev/v1/mcp/deployments/old-dep"]

[mcp_servers.dosu.env]
X_DOSU_API_KEY = "old-key"
`;
    writeFileSync(configPath, before + preChangeEntry + after);

    CodexProvider().install(makeCfg(), true);

    const content = readFileSync(configPath, "utf-8");
    expect(content.startsWith(before)).toBe(true);
    expect(content).toContain(after);
    expect(content).not.toContain("old-key");
    expect(dosuRootKeys(content)).toContain('omit_tools_from = ["deferred"]');
    expect(content.match(/omit_tools_from = \["deferred"\]/g)?.length).toBe(1);
  });

  it("remove drops omit_tools_from with the Dosu entry and leaves other servers' keys", async () => {
    const { CodexProvider } = await import("./codex");
    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    const other = '[mcp_servers.other]\ncommand = "other-cmd"\nomit_tools_from = ["deferred"]\n';
    writeFileSync(configPath, other);

    CodexProvider().install(makeCfg(), true);
    CodexProvider().remove(true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain("[mcp_servers.dosu");
    expect(content).toContain(other);
    expect(content.match(/omit_tools_from/g)?.length).toBe(1);
  });

  // The post-upgrade refresh rewrites every pre-omit_tools_from entry. That rewrite must not switch
  // Dosu back on or drop the filters, timeouts, and "always allow" approvals the user set in Codex.
  it("reinstall keeps the user's own settings on the Dosu entry", async () => {
    const { CodexProvider } = await import("./codex");
    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    const userRoot = [
      "enabled = false",
      'disabled_tools = [\n  "read", # noisy\n  "list",\n]',
      "tool_timeout_sec = 120",
      'default_tools_approval_mode = "prompt"',
      "required = true",
    ];
    const toolsTable = '[mcp_servers.dosu.tools.search]\napproval_mode = "approve"';
    writeFileSync(
      configPath,
      `[mcp_servers.dosu]
command = "/usr/local/bin/npx"
${userRoot.join("\n")}
args = ["-y", "mcp-remote@0.1.0", "https://api.dosu.dev/v1/mcp/deployments/old-dep"]

${toolsTable}

[mcp_servers.dosu.env]
X_DOSU_API_KEY = "old-key"

[mcp_servers.other]
command = "other-cmd"
`,
    );
    const provider = CodexProvider();
    expect(provider.isCurrent(makeCfg())).toBe(false);

    provider.install(makeCfg(), true);

    const content = readFileSync(configPath, "utf-8");
    expect(dosuRootKeys(content)).toEqual([
      `command = ${JSON.stringify(npxPath)}`,
      expect.stringMatching(/^args = /),
      'omit_tools_from = ["deferred"]',
      ...userRoot.join("\n").split("\n"),
    ]);
    expect(content).toContain(`\n${toolsTable}\n`);
    expect(content).toContain('[mcp_servers.other]\ncommand = "other-cmd"\n');
    expect(content).not.toContain("old-key");
    expect(provider.isCurrent(makeCfg())).toBe(true);

    provider.install(makeCfg(), true);
    expect(readFileSync(configPath, "utf-8")).toBe(content);

    provider.remove(true);
    expect(readFileSync(configPath, "utf-8")).not.toContain("mcp_servers.dosu");
  });

  it("an unclosed array in the Dosu entry never swallows the next table", async () => {
    const { CodexProvider } = await import("./codex");
    const configPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    const other = '[mcp_servers.other]\ncommand = "other-cmd"\n';
    writeFileSync(configPath, `[mcp_servers.dosu]\ndisabled_tools = ["read"\n\n${other}`);

    CodexProvider().install(makeCfg(), true);

    const content = readFileSync(configPath, "utf-8");
    expect(content.match(/\[mcp_servers\.other]/g)?.length).toBe(1);
    expect(dosuRootKeys(content)).toContain('disabled_tools = ["read"');
  });

  it("an empty CODEX_HOME falls back to ~/.codex, as in Codex", async () => {
    const { CodexProvider } = await import("./codex");
    process.env.CODEX_HOME = "";

    expect(CodexProvider().globalConfigPath()).toBe(join(homedir(), ".codex", "config.toml"));
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

  it.each([
    "install",
    "remove",
    "prune",
  ])("%s preserves unrelated TOML arrays of tables after Dosu", async (operation) => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const path = join(tempDir, ".codex", "config.toml");
    const hooks = `[[hooks.PreToolUse]] # command hooks
matcher = "Bash"
[[ hooks.PreToolUse.hooks ]] # preserve inner whitespace too
type = "command"
command = "echo check"
`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `[mcp_servers.dosu]\nurl = "https://example.com/mcp"\n${hooks}`);

    if (operation === "remove") provider.remove(false);
    else provider.install(makeCfg(), operation === "prune");

    const content = readFileSync(path, "utf-8");
    expect(content).toContain(hooks);
    expect(content).not.toContain('url = "https://example.com/mcp"');
  });

  // Codex merges `mcp_servers.dosu` per-key across the global and project-local
  // configs, so a legacy remote-HTTP entry left in the scope we are NOT writing
  // merges into ours as a stray `url` beside `command`. Codex rejects that with
  // "url is not supported for stdio" and refuses to load the entire config —
  // every MCP server goes down, not just dosu.
  const LEGACY_REMOTE_TOML = `[mcp_servers.other]
command = "other-cmd"

[mcp_servers.dosu]
url = "https://api.dosu.dev/v1/mcp"

[mcp_servers.dosu.http_headers]
X-Deployment-ID = "old-dep"
`;

  it("global install strips a legacy remote-HTTP entry from the local scope", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const localPath = join(tempDir, ".codex", "config.toml");
    mkdirSync(join(tempDir, ".codex"), { recursive: true });
    writeFileSync(localPath, LEGACY_REMOTE_TOML);

    provider.install(makeCfg(), true);

    const local = readFileSync(localPath, "utf-8");
    expect(local).not.toContain("[mcp_servers.dosu]");
    expect(local).not.toContain("http_headers");
    expect(local).not.toContain("url =");
    // Only the dosu entry is pruned; unrelated servers survive untouched.
    expect(local).toContain("[mcp_servers.other]");
    expect(local).toContain('command = "other-cmd"');

    const global = readFileSync(join(tempDir, "codex-home", "config.toml"), "utf-8");
    expect(global).toContain("[mcp_servers.dosu]");
    expect(global).toContain("mcp-remote@");
  });

  it("install leaves a stdio entry in the other scope alone", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    // A project-local stdio entry is a deliberate per-repo deployment override:
    // it merges cleanly with ours, so the CLI must not delete it.
    provider.install(makeCfg({ deployment_id: "repo-dep" }), false);
    provider.install(makeCfg(), true);

    const local = readFileSync(join(tempDir, ".codex", "config.toml"), "utf-8");
    expect(local).toContain("[mcp_servers.dosu]");
    expect(local).toContain("/deployments/repo-dep");
  });

  it("install does not create the other scope's config file", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), true);

    expect(existsSync(join(tempDir, ".codex", "config.toml"))).toBe(false);
  });

  // Codex walks from the project root to the cwd and loads every .codex/config.toml it finds,
  // so a legacy entry at the repo root still merges when setup runs from a subdirectory.
  it("global install prunes a legacy entry at the project root from a subdirectory", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    mkdirSync(join(tempDir, ".git"), { recursive: true });
    mkdirSync(join(tempDir, ".codex"), { recursive: true });
    writeFileSync(join(tempDir, ".codex", "config.toml"), LEGACY_REMOTE_TOML);
    const sub = join(tempDir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);

    provider.install(makeCfg(), true);

    const root = readFileSync(join(tempDir, ".codex", "config.toml"), "utf-8");
    expect(root).not.toContain("[mcp_servers.dosu]");
    expect(root).toContain("[mcp_servers.other]");
  });

  // A project-local install must never rewrite the global config: other projects rely on it.
  it("local install leaves a legacy global entry untouched and fails with a remedy", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const globalPath = join(tempDir, "codex-home", "config.toml");
    mkdirSync(join(tempDir, "codex-home"), { recursive: true });
    writeFileSync(globalPath, LEGACY_REMOTE_TOML);

    expect(() => provider.install(makeCfg(), false)).toThrow(/--global/);

    // Global config preserved verbatim, and no half-written local entry left behind.
    expect(readFileSync(globalPath, "utf-8")).toBe(LEGACY_REMOTE_TOML);
    expect(existsSync(join(tempDir, ".codex", "config.toml"))).toBe(false);
  });

  it("local install proceeds when the global entry is already the stdio form", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();

    provider.install(makeCfg(), true);
    expect(() => provider.install(makeCfg({ deployment_id: "repo-dep" }), false)).not.toThrow();

    const global = readFileSync(join(tempDir, "codex-home", "config.toml"), "utf-8");
    expect(global).toContain("/deployments/dep-123");
    const local = readFileSync(join(tempDir, ".codex", "config.toml"), "utf-8");
    expect(local).toContain("/deployments/repo-dep");
  });

  // `[mcp_servers.dosu] # note` is valid TOML; detection and removal must both handle it.
  it("detects and removes a dosu section carrying a trailing TOML comment", async () => {
    const { CodexProvider } = await import("./codex");
    const provider = CodexProvider();
    const localPath = join(tempDir, ".codex", "config.toml");
    mkdirSync(join(tempDir, ".codex"), { recursive: true });
    writeFileSync(
      localPath,
      '[mcp_servers.dosu] # deployment override\nurl = "https://api.dosu.dev/v1/mcp"\n',
    );

    provider.install(makeCfg(), true);

    const local = readFileSync(localPath, "utf-8");
    expect(local).not.toContain("mcp_servers.dosu");
    expect(local).not.toContain("url =");
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
// --- 4. Manual provider ---

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

  it("install offers the local proxy command before the HTTP details", async () => {
    const { ManualProvider } = await import("./manual");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    ManualProvider().install(makeCfg(), false);

    const allOutput = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allOutput).toContain("dosu mcp serve --client <agent>");
    expect(allOutput.indexOf("dosu mcp serve")).toBeLessThan(allOutput.indexOf("Endpoint:"));
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
// --- 5. createJSONProvider-based providers: Claude, Cursor, OpenCode ---

describe("ClaudeProvider", () => {
  let tempDir: string;
  let origHome: string | undefined;
  let origCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-claude-test-"));
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

  it("global install writes an always-loaded http entry to ~/.claude.json", async () => {
    const { ClaudeProvider } = await import("./claude");

    ClaudeProvider().install(makeCfg(), true);

    const cfg = loadJSONConfig(join(tempDir, ".claude.json"));
    expect(cfg.mcpServers.dosu).toEqual({
      type: "http",
      url: expect.stringContaining("dep-123"),
      headers: { "X-Dosu-API-Key": "key-abc" },
      alwaysLoad: true,
    });
  });

  it("local install writes the same entry to cwd/.mcp.json", async () => {
    const { ClaudeProvider } = await import("./claude");

    ClaudeProvider().install(makeCfg(), false);

    const cfg = loadJSONConfig(join(tempDir, ".mcp.json"));
    expect(cfg.mcpServers.dosu).toEqual({
      type: "http",
      url: expect.stringContaining("dep-123"),
      headers: { "X-Dosu-API-Key": "key-abc" },
      alwaysLoad: true,
    });
    expect(existsSync(join(tempDir, ".claude.json"))).toBe(false);
  });

  it("OSS mode writes the same shape against the base MCP URL", async () => {
    const { ClaudeProvider } = await import("./claude");

    ClaudeProvider().install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const cfg = loadJSONConfig(join(tempDir, ".claude.json"));
    expect(Object.keys(cfg.mcpServers.dosu).sort()).toEqual([
      "alwaysLoad",
      "headers",
      "type",
      "url",
    ]);
    expect(cfg.mcpServers.dosu.url).toMatch(/\/v1\/mcp$/);
    expect(cfg.mcpServers.dosu.alwaysLoad).toBe(true);
  });

  it("rewrites a pre-alwaysLoad dosu entry and keeps other servers and settings", async () => {
    const { ClaudeProvider } = await import("./claude");
    const configPath = join(tempDir, ".claude.json");
    const other = { type: "http", url: "https://example.com/mcp", alwaysLoad: false };
    const stdio = { command: "node", args: ["server.js"] };
    writeFileSync(
      configPath,
      JSON.stringify({
        numStartups: 7,
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://old.example/mcp",
            headers: { "X-Dosu-API-Key": "old" },
          },
          other,
          stdio,
        },
      }),
    );

    ClaudeProvider().install(makeCfg(), true);

    const cfg = loadJSONConfig(configPath);
    expect(cfg.numStartups).toBe(7);
    expect(cfg.mcpServers.other).toEqual(other);
    expect(cfg.mcpServers.stdio).toEqual(stdio);
    expect(cfg.mcpServers.dosu).toEqual({
      type: "http",
      url: expect.stringContaining("dep-123"),
      headers: { "X-Dosu-API-Key": "key-abc" },
      alwaysLoad: true,
    });
  });

  it("remove deletes only the dosu entry", async () => {
    const { ClaudeProvider } = await import("./claude");
    const configPath = join(tempDir, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    ClaudeProvider().install(makeCfg(), true);
    ClaudeProvider().remove(true);

    const cfg = loadJSONConfig(configPath);
    expect(cfg.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("is detected on a fresh machine from `claude` on PATH, before ~/.claude exists", async () => {
    const { ClaudeProvider } = await import("./claude");
    mkdirSync(join(tempDir, "bin"));
    vi.stubEnv("PATH", join(tempDir, "bin"));
    try {
      expect(ClaudeProvider().isInstalled()).toBe(false);
      writeFileSync(join(tempDir, "bin", "claude"), "#!/bin/sh\n");
      expect(ClaudeProvider().isInstalled()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

  it("OSS mode writes the same shape against the base MCP URL", async () => {
    const { CursorProvider } = await import("./cursor");
    const provider = CursorProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const cfg = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(Object.keys(cfg.mcpServers.dosu).sort()).toEqual(["headers", "url"]);
    expect(cfg.mcpServers.dosu.url).toMatch(/\/v1\/mcp$/);
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

  it("OSS mode keeps OpenCode's remote shape against the base MCP URL", async () => {
    const { OpenCodeProvider } = await import("./opencode");
    const provider = OpenCodeProvider();

    provider.install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    const cfg = loadJSONConfig(provider.globalConfigPath());
    expect(cfg.mcp.dosu.type).toBe("remote");
    expect(cfg.mcp.dosu.enabled).toBe(true);
    expect(cfg.mcp.dosu.url).toMatch(/\/v1\/mcp$/);
  });
});
