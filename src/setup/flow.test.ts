import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Only mock true boundaries: terminal UI, auth (browser), and HTTP client
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

vi.mock("../auth/flow", () => ({
  startOAuthFlow: vi.fn(),
}));

vi.mock("../client/client", () => {
  const SessionExpiredError = class extends Error {
    constructor() {
      super("session expired");
      this.name = "SessionExpiredError";
    }
  };
  return {
    Client: vi.fn(),
    SessionExpiredError,
  };
});

import * as p from "@clack/prompts";
import type { Config } from "../config/config";
import { loadConfig, saveConfig, getConfigPath } from "../config/config";
import { CursorProvider } from "../mcp/providers/cursor";
import { OpenCodeProvider } from "../mcp/providers/opencode";
import { ClaudeDesktopProvider } from "../mcp/providers/claude-desktop";
import { loadJSONConfig } from "../mcp/config-helpers";
import {
  isStdioOnly,
  stepDetectTools,
  stepConfigureTools,
  stepShowSummary,
  runSetup,
  type ToolSelection,
  type ConfigResult,
} from "./flow";
import { Client } from "../client/client";
import { startOAuthFlow } from "../auth/flow";
import * as providersModule from "../mcp/providers";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let origHome: string | undefined;
let origXdg: string | undefined;

function setupTempEnv() {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-flow-test-"));
  origHome = process.env.HOME;
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = tempDir;
  process.env.XDG_CONFIG_HOME = tempDir;
}

function teardownTempEnv() {
  process.env.HOME = origHome;
  if (origXdg !== undefined) {
    process.env.XDG_CONFIG_HOME = origXdg;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
}

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    deployment_id: "dep-123",
    deployment_name: "TestDeploy",
    api_key: "key-abc",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. isStdioOnly — pure function, real providers
// ---------------------------------------------------------------------------

describe("isStdioOnly", () => {
  it("returns true for ClaudeDesktopProvider", () => {
    const provider = ClaudeDesktopProvider();
    expect(isStdioOnly(provider)).toBe(true);
  });

  it("returns false for CursorProvider", () => {
    const provider = CursorProvider();
    expect(isStdioOnly(provider)).toBe(false);
  });

  it("returns false for OpenCodeProvider", () => {
    const provider = OpenCodeProvider();
    expect(isStdioOnly(provider)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. stepDetectTools — real providers, temp HOME
// ---------------------------------------------------------------------------

describe("stepDetectTools", () => {
  beforeEach(() => {
    setupTempEnv();
    vi.clearAllMocks();
  });
  afterEach(teardownTempEnv);

  it("returns providers whose detect paths exist, excluding stdio-only", () => {
    // Create Cursor detect path so it's "installed"
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    // Mock allSetupProviders to return real providers built in our temp env
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => {
      return [CursorProvider(), ClaudeDesktopProvider()];
    });

    const detected = stepDetectTools();
    expect(detected.length).toBe(1);
    expect(detected[0].id()).toBe("cursor");
  });

  it("returns empty array when no providers are installed", () => {
    // Don't create any detect paths
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => {
      return [CursorProvider(), OpenCodeProvider()];
    });

    const detected = stepDetectTools();
    expect(detected.length).toBe(0);
  });

  it("returns multiple providers when all are installed", () => {
    // Create detect paths for both Cursor and OpenCode
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => {
      return [CursorProvider(), OpenCodeProvider()];
    });

    const detected = stepDetectTools();
    expect(detected.length).toBe(2);
    const ids = detected.map((p) => p.id());
    expect(ids).toContain("cursor");
    expect(ids).toContain("opencode");
  });
});

// ---------------------------------------------------------------------------
// 3. stepConfigureTools — real providers, real filesystem
// ---------------------------------------------------------------------------

describe("stepConfigureTools", () => {
  beforeEach(() => {
    setupTempEnv();
    vi.clearAllMocks();
  });
  afterEach(teardownTempEnv);

  it("installs a provider and writes real JSON config to disk", () => {
    const cfg = makeCfg();
    const cursor = CursorProvider();
    const selection: ToolSelection = {
      toInstall: [cursor],
      toRemove: [],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("install");
    expect(results[0].error).toBeUndefined();

    // Verify the file was actually written to disk
    const configPath = cursor.globalConfigPath();
    expect(existsSync(configPath)).toBe(true);

    const written = loadJSONConfig(configPath);
    expect(written.mcpServers).toBeDefined();
    expect(written.mcpServers.dosu).toBeDefined();
    expect(written.mcpServers.dosu.url).toContain("dep-123");
    expect(written.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("removes a provider and deletes the dosu entry from disk", () => {
    const cfg = makeCfg();
    const cursor = CursorProvider();

    // First install so there's something to remove
    cursor.install(cfg, true);
    const configPath = cursor.globalConfigPath();
    let written = loadJSONConfig(configPath);
    expect(written.mcpServers.dosu).toBeDefined();

    const selection: ToolSelection = {
      toInstall: [],
      toRemove: [cursor],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("remove");
    expect(results[0].error).toBeUndefined();

    // Verify the dosu entry was removed from disk
    written = loadJSONConfig(configPath);
    expect(written.mcpServers.dosu).toBeUndefined();
  });

  it("records skipped providers without touching disk", () => {
    const cursor = CursorProvider();
    const cfg = makeCfg();
    const selection: ToolSelection = {
      toInstall: [],
      toRemove: [],
      skipped: [cursor],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("skip");
    expect(results[0].error).toBeUndefined();
    // No file should have been created
    expect(existsSync(cursor.globalConfigPath())).toBe(false);
  });

  it("handles install errors and records them in results", () => {
    const claudeDesktop = ClaudeDesktopProvider();
    const cfg = makeCfg();
    // ClaudeDesktopProvider.install() always throws
    const selection: ToolSelection = {
      toInstall: [claudeDesktop],
      toRemove: [],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("install");
    expect(results[0].error).toBeDefined();
    expect(results[0].error!.message).toContain("stdio");
    // p.log.error should have been called
    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Claude Desktop"),
    );
  });

  it("handles mixed install, remove, and skip in one call", () => {
    const cfg = makeCfg();
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();

    // Pre-install opencode so we can remove it
    opencode.install(cfg, true);

    const cursorForSkip = CursorProvider();
    // Pre-install cursor so the skip entry refers to an installed provider
    cursorForSkip.install(cfg, true);

    // Fresh providers for this call
    const freshCursor = CursorProvider();
    const freshOpencode = OpenCodeProvider();
    const anotherCursor = CursorProvider();

    const selection: ToolSelection = {
      toInstall: [freshCursor],
      toRemove: [freshOpencode],
      skipped: [anotherCursor],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(3);

    const installResult = results.find((r) => r.action === "install");
    const removeResult = results.find((r) => r.action === "remove");
    const skipResult = results.find((r) => r.action === "skip");

    expect(installResult).toBeDefined();
    expect(installResult!.error).toBeUndefined();
    expect(removeResult).toBeDefined();
    expect(removeResult!.error).toBeUndefined();
    expect(skipResult).toBeDefined();

    // Verify cursor config was written
    const cursorConfig = loadJSONConfig(freshCursor.globalConfigPath());
    expect(cursorConfig.mcpServers.dosu).toBeDefined();

    // Verify opencode dosu entry was removed
    const opencodeConfig = loadJSONConfig(freshOpencode.globalConfigPath());
    expect(opencodeConfig.mcp.dosu).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. stepShowSummary — real providers, mocked clack log
// ---------------------------------------------------------------------------

describe("stepShowSummary", () => {
  beforeEach(() => {
    setupTempEnv();
    vi.clearAllMocks();
  });
  afterEach(teardownTempEnv);

  it("logs configured tools count and paths for installs", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "install" },
    ];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 tool"),
    );
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Cursor"),
    );
    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("Try it out"),
    );
  });

  it("logs removed tools count for removals", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "remove" },
    ];

    stepShowSummary(results);

    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Removed from 1 tool"),
    );
    // No "Try it out" when only removals
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("shows 'all configured' when only skipped results", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "skip" },
    ];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("All tools already configured"),
    );
    // Skipped still gets the "Try it out" message
    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("Try it out"),
    );
  });

  it("shows both install and remove summaries for mixed results", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "install" },
      { provider: opencode, action: "remove" },
    ];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 tool"),
    );
    expect(p.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Removed from 1 tool"),
    );
  });

  it("does not count errored results in install summary", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "install" },
      { provider: opencode, action: "install", error: new Error("failed") },
    ];

    stepShowSummary(results);

    // Only 1 successful install
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 tool"),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. runSetup integration — thin tests for interactive routing
//    Mocks: @clack/prompts, Client, auth/flow
//    Real: config (temp dir), styles
// ---------------------------------------------------------------------------

describe("runSetup integration", () => {
  const mockClient = vi.mocked(Client);
  const mockStartOAuthFlow = vi.mocked(startOAuthFlow);

  beforeEach(() => {
    setupTempEnv();
    vi.clearAllMocks();
    vi.mocked(p.isCancel).mockReturnValue(false);
  });
  afterEach(teardownTempEnv);

  function setupAuthenticatedClient(overrides: Record<string, any> = {}) {
    const clientMethods = {
      doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
      refreshToken: vi.fn(),
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      ]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
      ...overrides,
    };
    mockClient.mockImplementation(() => clientMethods as any);
    return clientMethods;
  }

  it("returns early when user declines login", async () => {
    // No token in config (fresh state via temp dir)
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    expect(mockStartOAuthFlow).not.toHaveBeenCalled();
    expect(p.log.success).not.toHaveBeenCalled();
  });

  it("returns early when user cancels login prompt", async () => {
    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as any);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    expect(mockStartOAuthFlow).not.toHaveBeenCalled();
  });

  it("completes full flow with existing token and no tools", async () => {
    // Save a real config with token
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();

    // Mock allSetupProviders to return nothing
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should warn about no tools
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No supported AI tools detected"),
    );

    // Config should have been saved with deployment info
    const savedCfg = loadConfig();
    expect(savedCfg.deployment_id).toBe("d1");
    expect(savedCfg.deployment_name).toBe("Deploy1");
  });

  it("completes full flow with tool install via real filesystem", async () => {
    // Save a real config with token
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();

    // Create Cursor detect path
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);

    // User selects cursor in multiselect
    vi.mocked(p.multiselect).mockResolvedValue(["cursor"]);

    await runSetup();

    // Verify the config was actually written to disk
    const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(cursorConfigPath)).toBe(true);
    const cursorConfig = loadJSONConfig(cursorConfigPath);
    expect(cursorConfig.mcpServers.dosu).toBeDefined();
    expect(cursorConfig.mcpServers.dosu.url).toContain("d1");

    // Verify summary was shown
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Configured 1 tool"),
    );
  });

  it("runs OAuth flow and saves tokens to real config", async () => {
    // No pre-existing config (fresh temp dir), so needs login
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockResolvedValue({
      access_token: "oauth-tok",
      refresh_token: "oauth-ref",
      expires_in: 7200,
    } as any);

    const clientMethods = setupAuthenticatedClient();
    clientMethods.createAPIKey.mockResolvedValue({ api_key: "minted-key" });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Real config on disk should have OAuth tokens
    const savedCfg = loadConfig();
    expect(savedCfg.access_token).toBe("oauth-tok");
    expect(savedCfg.refresh_token).toBe("oauth-ref");
  });

  it("uses deploymentID option to resolve deployment directly", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    const clientMethods = setupAuthenticatedClient();
    clientMethods.getDeployments.mockResolvedValue([
      { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      { deployment_id: "d2", name: "Deploy2", org_id: "o1", org_name: "Org1" },
    ]);

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup({ deploymentID: "d2" });

    // Should have skipped org selection
    expect(p.select).not.toHaveBeenCalled();

    // Config on disk should have d2
    const savedCfg = loadConfig();
    expect(savedCfg.deployment_id).toBe("d2");
    expect(savedCfg.deployment_name).toBe("Deploy2");
  });

  it("creates new API key when existing one is invalid", async () => {
    const cfg = makeCfg({ api_key: "bad-key" });
    saveConfig(cfg);

    const clientMethods = setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(false),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "fresh-key" }),
    });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid"),
    );

    // Config on disk should have fresh key
    const savedCfg = loadConfig();
    expect(savedCfg.api_key).toBe("fresh-key");
  });

  it("shows error when OAuth fails", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockRejectedValue(new Error("browser timeout"));

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("browser timeout"),
    );
  });

  it("auto-selects single org without prompting", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should not have shown org select since there's only one org
    expect(p.select).not.toHaveBeenCalled();
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("Org1"),
    );
  });

  it("prompts when multiple orgs exist", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockResolvedValue([
        { org_id: "o1", name: "Org1" },
        { org_id: "o2", name: "Org2" },
      ]),
    });
    vi.mocked(p.select).mockResolvedValueOnce("o1");
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select an organization" }),
    );
  });

  it("returns early when no orgs found", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockResolvedValue([]),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      "No organizations found for your account",
    );
  });

  it("handles SessionExpiredError during org fetch", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    const { SessionExpiredError } = await import("../client/client");
    setupAuthenticatedClient({
      getOrgs: vi.fn().mockRejectedValue(new SessionExpiredError()),
    });

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Session expired"),
    );
  });

  it("handles org fetch error", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockRejectedValue(new Error("network fail")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("network fail"),
    );
  });

  it("prompts when multiple deployments exist for org", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "D2", org_id: "o1", org_name: "Org1" },
      ]),
    });
    vi.mocked(p.select).mockResolvedValueOnce("d2");
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select a deployment" }),
    );
    const saved = loadConfig();
    expect(saved.deployment_id).toBe("d2");
  });

  it("returns early when no deployments for org", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "other", org_name: "Other" },
      ]),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("No deployments found"),
    );
  });

  it("handles deployment fetch error", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
  });

  it("handles API key creation failure", async () => {
    const cfg = makeCfg({ api_key: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(false),
      createAPIKey: vi.fn().mockRejectedValue(new Error("rate limited")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("rate limited"),
    );
  });

  it("refreshes token when initial check returns 401", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
    setupAuthenticatedClient({
      doRequestRaw: vi.fn()
        .mockResolvedValueOnce({ status: 401 })
        .mockResolvedValueOnce({ status: 200 }),
      refreshToken: mockRefreshToken,
    });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockRefreshToken).toHaveBeenCalled();
  });

  it("falls through to login when refresh fails", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      doRequestRaw: vi.fn().mockResolvedValue({ status: 401 }),
      refreshToken: vi.fn().mockRejectedValue(new Error("refresh failed")),
    });

    // User declines login
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith("Session expired.");
  });

  it("returns early when user cancels tool selection", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);

    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.multiselect).mockResolvedValue(cancelSymbol as any);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    // Should not have configured anything
    expect(existsSync(join(tempDir, ".cursor", "mcp.json"))).toBe(false);
  });

  it("handles user cancelling org selection", async () => {
    // Start with no deployment in config
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockResolvedValue([
        { org_id: "o1", name: "Org1" },
        { org_id: "o2", name: "Org2" },
      ]),
    });

    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.select).mockResolvedValueOnce(cancelSymbol as any);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    // Should return early without saving deployment
    const saved = loadConfig();
    expect(saved.deployment_id).toBeUndefined();
  });

  it("handles user cancelling deployment selection", async () => {
    // Start with no deployment in config
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "D2", org_id: "o1", org_name: "Org1" },
      ]),
    });

    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.select).mockResolvedValueOnce(cancelSymbol as any);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    const saved = loadConfig();
    expect(saved.deployment_id).toBeUndefined();
  });

  it("shows deployment not found error", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
      ]),
    });

    await runSetup({ deploymentID: "nonexistent" });

    expect(p.log.error).toHaveBeenCalledWith("Deployment nonexistent not found");
  });

  it("handles resolve deployment fetch error", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockRejectedValue(new Error("gone")),
    });

    await runSetup({ deploymentID: "d1" });

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("gone"),
    );
  });

  it("handles session verification failure (network error)", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      doRequestRaw: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    // Falls through to login prompt
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    // Should have asked to login
    expect(p.confirm).toHaveBeenCalled();
  });

  it("handles refresh succeeding but second verify failing", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      doRequestRaw: vi.fn()
        .mockResolvedValueOnce({ status: 403 })    // initial check fails
        .mockResolvedValueOnce({ status: 500 }),    // after refresh, still fails
      refreshToken: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith("Session expired.");
  });
});
