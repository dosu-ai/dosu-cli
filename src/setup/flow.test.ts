import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CRITICAL: mock `open` so runSetup's github-step (imported dynamically) can
// never actually pop a real browser tab to the Dosu App install URL when the
// `repo_not_installed` code path fires. Also mock `git` lookup so
// detectGitRepo() doesn't hit the real filesystem.
vi.mock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error("git not available in tests");
  }),
}));

// Only mock true boundaries: terminal UI, auth (browser), and HTTP client
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
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

// tRPC client used by:
//   - completeOnboarding via `user.updateProfile`
//   - github step via `workspaces.create`, `dataSource.create`, etc.
// Tests can override any of these via `mockTrpc.<path>.mockResolvedValue(...)`.
const mockTrpc = vi.hoisted(() => ({
  user: {
    getCliOnboardingContext: {
      query: vi.fn().mockResolvedValue({
        user_id: "test-user-id",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      }),
    },
    getProfile: {
      query: vi.fn().mockResolvedValue({ user_id: "test-user-id", finished_onboarding: true }),
    },
    updateProfile: { mutate: vi.fn().mockResolvedValue(null) },
    trackCliOnboardingEvent: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
    trackCliOnboardingPreAuthEvent: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
  },
  organization: {
    getOrganizations: {
      query: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1", user_role: "OWNER" }]),
    },
  },
  githubRepository: { listForOrg: { query: vi.fn().mockResolvedValue([]) } },
  workspaces: {
    create: { mutate: vi.fn() },
    listForSpace: { query: vi.fn().mockResolvedValue([]) },
  },
  dataSource: { create: { mutate: vi.fn() } },
  deploymentDataSource: { create: { mutate: vi.fn().mockResolvedValue({}) } },
}));
vi.mock("@trpc/client", () => ({
  createTRPCClient: vi.fn(() => mockTrpc),
  httpLink: vi.fn(() => ({})),
}));
vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn(() => mockTrpc),
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

const mockInstallSkill = vi.fn();
vi.mock("../commands/skill", () => ({
  installSkill: (...args: unknown[]) => mockInstallSkill(...args),
  skillAgentIDsForProviders: (providerIDs: string[]) =>
    providerIDs
      .map(
        (providerID) =>
          ({ claude: "claude-code", cursor: "cursor" })[providerID as "claude" | "cursor"],
      )
      .filter(Boolean),
  skillInstallTargetForProvider: (providerID: string) => {
    const target = {
      claude: { path: "/skills/claude/dosu", symlink: true },
      cursor: { path: "/skills/cursor/dosu", symlink: false },
    }[providerID as "claude" | "cursor"];
    return target ?? null;
  },
  skillCommand: vi.fn(),
}));

const { mockStepConnectGitHubRepo } = vi.hoisted(() => ({
  mockStepConnectGitHubRepo: vi.fn(),
}));

// AGENTS.md step: mocked so flow tests never write an AGENTS.md into the real
// repo cwd. Defaults (not in a git work tree) are installed by
// `installSetupStepDefaults()`.
const { mockInGitWorkTree, mockStepUpdateAgentsMd } = vi.hoisted(() => ({
  mockInGitWorkTree: vi.fn(),
  mockStepUpdateAgentsMd: vi.fn(),
}));
vi.mock("./agents-md-step", () => ({
  inGitWorkTree: (...args: unknown[]) => mockInGitWorkTree(...args),
  stepUpdateAgentsMd: (...args: unknown[]) => mockStepUpdateAgentsMd(...args),
}));

const { mockStepConfigureAgentRules } = vi.hoisted(() => ({
  mockStepConfigureAgentRules: vi.fn(),
}));
vi.mock("./rules-step", () => ({
  stepConfigureAgentRules: (...args: unknown[]) => mockStepConfigureAgentRules(...args),
}));
vi.mock("./github-step", () => ({
  stepConnectGitHubRepo: (...args: unknown[]) => mockStepConnectGitHubRepo(...args),
  // Audit handoff never fires in these tests: not a git repo.
  detectGitRepo: vi.fn(() => null),
}));

import * as p from "@clack/prompts";
import { OAuthCallbackError } from "../auth/errors";
import { startOAuthFlow } from "../auth/flow";
import { Client } from "../client/client";
import type { Config } from "../config/config";
import { loadConfig, saveConfig } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { loadJSONConfig, saveJSONConfig } from "../mcp/config-helpers";
import * as providersModule from "../mcp/providers";
import { ClaudeProvider } from "../mcp/providers/claude";
import { ClaudeDesktopProvider } from "../mcp/providers/claude-desktop";
import { CursorProvider } from "../mcp/providers/cursor";
import { OpenCodeProvider } from "../mcp/providers/opencode";
import {
  type ConfigResult,
  runInstallSkill,
  runSetup,
  stepConfigureTools,
  stepDetectTools,
  stepShowSummary,
  type ToolSelection,
} from "./flow";

/** Default p.multiselect behaviour: accept the agent selection's initial values. */
function installMultiselectDefault() {
  vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
    const o = opts as { message: string; initialValues?: unknown[] };
    return (o.initialValues ?? []) as unknown as never;
  });
}

/** Override the selected agent provider IDs. */
function mockToolSelection(selection: string[]) {
  vi.mocked(p.multiselect).mockResolvedValue(selection as unknown as never);
}

function installSetupStepDefaults() {
  mockStepConnectGitHubRepo.mockResolvedValue({ advance: false, has_connected_repo: false });
  mockInGitWorkTree.mockReturnValue(false);
  mockStepUpdateAgentsMd.mockReturnValue(true);
  mockStepConfigureAgentRules.mockResolvedValue([]);
}

function installRemoteSetupDefaults() {
  mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
    user_id: "test-user-id",
    finished_onboarding: true,
    cli_onboarding_enabled: false,
  });
  mockTrpc.organization.getOrganizations.query.mockResolvedValue([
    { org_id: "o1", name: "Org1", user_role: "OWNER" },
  ]);
  mockTrpc.user.updateProfile.mutate.mockResolvedValue(null);
  mockTrpc.user.trackCliOnboardingEvent.mutate.mockResolvedValue({ ok: true });
  mockTrpc.user.trackCliOnboardingPreAuthEvent.mutate.mockResolvedValue({ ok: true });
}

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

/** A SetupProvider whose install/remove always throw, for error-path tests. */
function throwingProvider(): providersModule.SetupProvider {
  return {
    name: () => "Broken Tool",
    id: () => "broken",
    supportsLocal: () => false,
    priority: () => 99,
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => false,
    globalConfigPath: () => join(tempDir, "broken.json"),
    install() {
      throw new Error("boom: provider failure");
    },
    remove() {
      throw new Error("boom: provider failure");
    },
  };
}

function makeCfg(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    deployment_id: "dep-123",
    deployment_name: "TestDeploy",
    api_key: "key-abc",
    ...overrides,
  });
}

function makeDeployment(overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: "d1",
    name: "Deploy1",
    description: "",
    provider_slug: "dosu_mcp",
    enabled: true,
    org_id: "o1",
    org_name: "Org1",
    space_id: "s1",
    ...overrides,
  };
}

function trackedCliOnboardingEvents() {
  return mockTrpc.user.trackCliOnboardingEvent.mutate.mock.calls.map(([input]) => input);
}

// ---------------------------------------------------------------------------
// 1. stepDetectTools — real providers, temp HOME
// ---------------------------------------------------------------------------

describe("stepDetectTools", () => {
  beforeEach(() => {
    setupTempEnv();
    vi.resetAllMocks();
    installSetupStepDefaults();
  });
  afterEach(teardownTempEnv);

  it("returns providers whose detect paths exist", () => {
    // Create Cursor detect path so it's "installed"; Claude Desktop's app
    // dir does not exist in the temp env, so it stays undetected.
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    // Mock allSetupProviders to return real providers built in our temp env
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => {
      return [CursorProvider(), ClaudeDesktopProvider()];
    });

    const detected = stepDetectTools();
    expect(detected.length).toBe(1);
    expect(detected[0].id()).toBe("cursor");
  });

  it("includes Claude Desktop when its app dir exists", () => {
    const desktop = ClaudeDesktopProvider();
    for (const detectPath of desktop.detectPaths()) {
      mkdirSync(detectPath, { recursive: true });
    }

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => {
      return [CursorProvider(), ClaudeDesktopProvider()];
    });

    const detected = stepDetectTools();
    expect(detected.map((p2) => p2.id())).toEqual(["claude-desktop"]);
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
    vi.resetAllMocks();
    installSetupStepDefaults();
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
    const broken = throwingProvider();
    const cfg = makeCfg();
    const selection: ToolSelection = {
      toInstall: [broken],
      toRemove: [],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("install");
    expect(results[0].error).toBeDefined();
    expect(results[0].error?.message).toContain("boom");
    // p.log.error should have been called
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Broken Tool"));
  });

  it("handles remove errors and records them in results", () => {
    const broken = throwingProvider();
    const cfg = makeCfg();
    const selection: ToolSelection = {
      toInstall: [],
      toRemove: [broken],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("remove");
    expect(results[0].error).toBeDefined();
    expect(results[0].error?.message).toContain("boom");
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Broken Tool"));
  });

  it("handles mixed install, remove, and skip in one call", () => {
    const cfg = makeCfg();
    const _cursor = CursorProvider();
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
    expect(installResult?.error).toBeUndefined();
    expect(removeResult).toBeDefined();
    expect(removeResult?.error).toBeUndefined();
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
    vi.resetAllMocks();
    installSetupStepDefaults();
  });
  afterEach(teardownTempEnv);

  it("logs configured tools count and paths for installs", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [{ provider: cursor, action: "install" }];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Cursor"));
    // The summary itself never prints extra messages.
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("logs removed tools count for removals", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [{ provider: cursor, action: "remove" }];

    stepShowSummary(results);

    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Removed from 1 agent"));
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("shows 'all configured' when only skipped results", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [{ provider: cursor, action: "skip" }];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("All agents already configured"),
    );
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("shows both install and remove summaries for mixed results", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "install" },
      { provider: opencode, action: "remove" },
    ];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Removed from 1 agent"));
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
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
  });

  it("prints no extra messages when only removals and no skips", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "remove" },
      { provider: opencode, action: "remove" },
    ];

    stepShowSummary(results);

    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Removed from 2 agent"));
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("does not show 'all configured' when installs and skips are mixed", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const results: ConfigResult[] = [
      { provider: cursor, action: "install" },
      { provider: opencode, action: "skip" },
    ];

    stepShowSummary(results);

    // Should show install summary, NOT "all configured"
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
    expect(p.log.success).not.toHaveBeenCalledWith(
      expect.stringContaining("All agents already configured"),
    );
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("prints nothing when results are empty", () => {
    stepShowSummary([]);

    expect(p.log.success).not.toHaveBeenCalled();
    expect(p.log.info).not.toHaveBeenCalled();
    expect(p.log.message).not.toHaveBeenCalled();
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
    vi.resetAllMocks();
    installSetupStepDefaults();
    installRemoteSetupDefaults();
    vi.mocked(p.isCancel).mockReturnValue(false);
    installMultiselectDefault();
    mockInstallSkill.mockResolvedValue({ success: true, sha: "test-sha" });
  });
  afterEach(teardownTempEnv);

  function setupAuthenticatedClient(overrides: Record<string, unknown> = {}) {
    const clientMethods = {
      doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
      refreshToken: vi.fn(),
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
      getDeployments: vi.fn().mockResolvedValue([makeDeployment()]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
      completeOnboarding: vi.fn().mockResolvedValue(undefined),
      // Default: github connect soft-skips (user not in git repo). Tests that
      // exercise it override.
      connectGithubRepo: vi.fn().mockResolvedValue({ skipped: true, reason: "repo_not_installed" }),
      ...overrides,
    };
    mockClient.mockImplementation(function () {
      return clientMethods as unknown as Client;
    });
    return clientMethods;
  }

  it("starts the OAuth flow without a confirm prompt and prints the login link", async () => {
    // No token in config (fresh state via temp dir)
    mockStartOAuthFlow.mockImplementation(async (_signal, _path, _params, _onAuthURL, options) => {
      options?.onAuthURL?.("https://app.dosu.dev/cli/auth?callback=x");
      return {
        browserOpened: true,
        token: { access_token: "tok", refresh_token: "ref", expires_in: 3600 },
      };
    });
    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.confirm).not.toHaveBeenCalledWith({ message: "Open browser to log in?" });
    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.any(Object),
      undefined,
      expect.objectContaining({ waitWithoutBrowser: true }),
    );
    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining(
        "If your browser doesn't open automatically, visit:\nhttps://app.dosu.dev/cli/auth?callback=x",
      ),
    );
  });

  it("logs curated OAuth callback errors during browser login", async () => {
    mockStartOAuthFlow.mockRejectedValue(
      new OAuthCallbackError("OAuth state expired", {
        errorCode: "bad_oauth_state",
        errorDescription: "OAuth state expired",
      }),
    );

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      "Authentication failed: OAuth state expired. Run `dosu login` again.",
    );
  });

  it("completes full flow with existing token and no tools", async () => {
    // Save a real config with token but no deployment — forces the picker.
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient();

    // Mock allSetupProviders to return nothing
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should warn about no tools
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No supported AI agents detected"),
    );

    // Config should have been saved with deployment info
    const savedCfg = loadConfig();
    expect(savedCfg.active_account?.target?.deployment_id).toBe("d1");
    expect(savedCfg.active_account?.target?.deployment_name).toBe("Deploy1");
  });

  it("completes full flow with tool install via real filesystem", async () => {
    // Save a real config with token but no deployment — forces the picker.
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient();

    // Create Cursor detect path
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);

    // User selects cursor in multiselect
    mockToolSelection(["cursor"]);

    await runSetup();

    // Verify the config was actually written to disk
    const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(cursorConfigPath)).toBe(true);
    const cursorConfig = loadJSONConfig(cursorConfigPath);
    expect(cursorConfig.mcpServers.dosu).toBeDefined();
    expect(cursorConfig.mcpServers.dosu.url).toContain("d1");

    // Verify summary was shown
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
    expect(mockStepConfigureAgentRules).toHaveBeenCalledWith(
      expect.objectContaining({ toInstall: [expect.objectContaining({})] }),
      [expect.objectContaining({ action: "install" })],
    );
  });

  it("runs OAuth flow and saves tokens to real config", async () => {
    // No pre-existing config (fresh temp dir), so needs login. No mode prompt anymore.
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockImplementation(async (_signal, _path, _params, _onAuthURL, options) => {
      options?.onAuthURL?.("https://app.test/cli/auth?callback=cb");
      return {
        browserOpened: true,
        token: { access_token: "oauth-tok", refresh_token: "oauth-ref", expires_in: 7200 },
      };
    });

    const clientMethods = setupAuthenticatedClient();
    clientMethods.createAPIKey.mockResolvedValue({ api_key: "minted-key" });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Real config on disk should have OAuth tokens
    const savedCfg = loadConfig();
    expect(savedCfg.active_account?.session.access_token).toBe("oauth-tok");
    expect(savedCfg.active_account?.session.refresh_token).toBe("oauth-ref");
    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining(
        "If your browser doesn't open automatically, visit:\nhttps://app.test/cli/auth?callback=cb",
      ),
    );
  });

  it("returns null when the OAuth flow yields no token", async () => {
    mockStartOAuthFlow.mockResolvedValue({ browserOpened: false });

    const result = await runSetup();

    expect(result).toBeUndefined();
    expect(loadConfig().active_account).toBeUndefined();
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
    expect(savedCfg.active_account?.target?.deployment_id).toBe("d2");
    expect(savedCfg.active_account?.target?.deployment_name).toBe("Deploy2");
  });

  it("clears OSS mode when re-running setup with a specific deployment", async () => {
    const cfg = makeCfg({
      mode: "oss",
      deployment_id: undefined,
      deployment_name: undefined,
    });
    saveConfig(cfg);

    const clientMethods = setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "Deploy2", org_id: "o1", org_name: "Org1" },
      ]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
    });

    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    CursorProvider().install(makeCfg({ mode: "oss", deployment_id: undefined }), true);
    const ossConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(ossConfig.mcpServers.dosu.url).toContain("/v1/mcp");
    expect(ossConfig.mcpServers.dosu.url).not.toContain("/deployments/");

    await runSetup({ deploymentID: "d2" });

    expect(clientMethods.getDeployments).toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("open-source libraries") }),
    );

    const savedCfg = loadConfig();
    expect(savedCfg.mode).toBeUndefined();
    expect(savedCfg.active_account?.target?.deployment_id).toBe("d2");
    expect(savedCfg.active_account?.target?.api_key).toBe("key-abc");

    const cursorConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(cursorConfig.mcpServers.dosu.url).toContain("/v1/mcp/deployments/d2");
    expect(cursorConfig.mcpServers.dosu.url).not.toBe(ossConfig.mcpServers.dosu.url);
  });

  it("creates new API key when existing one is invalid", async () => {
    const cfg = makeCfg({ api_key: "bad-key" });
    saveConfig(cfg);

    const _clientMethods = setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(false),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "fresh-key" }),
    });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("invalid"));

    // Config on disk should have fresh key
    const savedCfg = loadConfig();
    expect(savedCfg.active_account?.target?.api_key).toBe("fresh-key");
  });

  it("reinstalls configured tools when only the API key changes", async () => {
    // Use deployment_id "d1" to match the mock so deployment doesn't change
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    const cfg = makeCfg({ deployment_id: "d1", deployment_name: "Deploy1", api_key: "old-key" });
    saveConfig(cfg);
    CursorProvider().install(cfg, true);

    // The old key is "invalid", so the flow will mint a new one
    setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(false),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
    });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    // Cursor should have been reinstalled (not skipped) because api_key changed
    const cursorConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(cursorConfig.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("new-key");
  });

  it("reinstalls configured tools when setup is re-run with the same target", async () => {
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    const cfg = makeCfg({ deployment_id: "d1", deployment_name: "Deploy1", api_key: "key-abc" });
    saveConfig(cfg);

    const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
    saveJSONConfig(cursorConfigPath, {
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://stale.example/v1/mcp/deployments/old-deployment",
          headers: {
            "X-Dosu-API-Key": "stale-key",
          },
        },
      },
    });

    setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(true),
    });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    const cursorConfig = loadJSONConfig(cursorConfigPath);
    expect(cursorConfig.mcpServers.dosu.url).toContain("/v1/mcp/deployments/d1");
    expect(cursorConfig.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
  });

  it("shows error when OAuth fails", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockRejectedValue(new Error("browser timeout"));

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("browser timeout"));
  });

  it("auto-selects single org without prompting", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should not have shown org select since there's only one org
    expect(p.select).not.toHaveBeenCalled();
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Org1"));
  });

  it("prompts when multiple orgs exist", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
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
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockResolvedValue([]),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith("No organizations found for your account");
  });

  it("handles SessionExpiredError during org fetch", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    const { SessionExpiredError } = await import("../client/client");
    setupAuthenticatedClient({
      getOrgs: vi.fn().mockRejectedValue(new SessionExpiredError()),
    });

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("Session expired"));
  });

  it("handles org fetch error", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getOrgs: vi.fn().mockRejectedValue(new Error("network fail")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("network fail"));
  });

  it("prompts when multiple deployments exist for org", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
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

    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select an MCP" }));
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBe("d2");
  });

  it("returns early when no deployments for org", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi
        .fn()
        .mockResolvedValue([
          { deployment_id: "d1", name: "D1", org_id: "other", org_name: "Other" },
        ]),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("No MCPs found"));
  });

  it("handles deployment fetch error", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("timeout"));
  });

  it("handles API key creation failure", async () => {
    const cfg = makeCfg({ api_key: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      validateAPIKey: vi.fn().mockResolvedValue(false),
      createAPIKey: vi.fn().mockRejectedValue(new Error("rate limited")),
    });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });

  it("refreshes token when initial check returns 401", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
    setupAuthenticatedClient({
      doRequestRaw: vi
        .fn()
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
    vi.mocked(p.multiselect).mockResolvedValue(cancelSymbol as unknown as never);
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
    vi.mocked(p.select).mockResolvedValueOnce(cancelSymbol as unknown);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    // Should return early without saving deployment
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
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
    vi.mocked(p.select).mockResolvedValueOnce(cancelSymbol as unknown);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
  });

  it("shows an account hint when the requested MCP is inaccessible", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi
        .fn()
        .mockResolvedValue([{ deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" }]),
    });

    await runSetup({ deploymentID: "nonexistent" });

    expect(p.log.error).toHaveBeenCalledWith(
      "This MCP is not accessible to the current Dosu account.\n" +
        "Make sure you are logged in to the correct account. Run `dosu logout`, then try again.",
    );
  });

  it("handles resolve deployment fetch error", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockRejectedValue(new Error("gone")),
    });

    await runSetup({ deploymentID: "d1" });

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("gone"));
  });

  it("handles session verification failure (network error)", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      doRequestRaw: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    // Falls through to login (OAuth flow starts directly, no confirm prompt)
    mockStartOAuthFlow.mockResolvedValue({ browserOpened: false });

    await runSetup();

    expect(mockStartOAuthFlow).toHaveBeenCalled();
  });

  it("retries on transient backend error (502) instead of declaring session expired", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
    setupAuthenticatedClient({
      doRequestRaw: vi
        .fn()
        .mockResolvedValueOnce({ status: 502 }) // transient error
        .mockResolvedValueOnce({ status: 200 }), // succeeds after refresh
      refreshToken: mockRefreshToken,
    });

    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should have tried to refresh instead of immediately declaring "session expired"
    expect(mockRefreshToken).toHaveBeenCalled();
    // Should NOT have shown "Session expired" warning
    expect(p.log.warn).not.toHaveBeenCalledWith("Session expired.");
  });

  it("handles refresh succeeding but second verify failing", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient({
      doRequestRaw: vi
        .fn()
        .mockResolvedValueOnce({ status: 403 }) // initial check fails
        .mockResolvedValueOnce({ status: 500 }), // after refresh, still fails
      refreshToken: vi.fn().mockResolvedValue(undefined),
    });

    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith("Session expired.");
  });

  it("OSS mode skips org selection and fetches first deployment", async () => {
    const cfg = makeCfg({ mode: "oss", deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Should have saved deployment from fetchDeployments
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBe("d1");
    expect(saved.mode).toBe("oss");
  });

  it("OSS mode handles getDeployments failure and exits at API key step", async () => {
    const cfg = makeCfg({ mode: "oss", deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockRejectedValue(new Error("service unavailable")),
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith("No MCP available for API key creation");
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
    expect(p.outro).not.toHaveBeenCalled();
  });

  it("OSS mode exits early when no deployments are available", async () => {
    const cfg = makeCfg({ mode: "oss", deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi.fn().mockResolvedValue([]),
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith("No MCP available for API key creation");
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
    expect(p.outro).not.toHaveBeenCalled();
  });

  it("OSS mode shows OSS-specific outro message", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(p.outro).toHaveBeenCalledWith(expect.stringContaining("open-source libraries only"));
  });

  it("--mode oss flag switches cfg.mode to OSS and skips Cloud-only steps", async () => {
    saveConfig(makeCfg());
    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup({ mode: "oss" });

    const saved = loadConfig();
    expect(saved.mode).toBe("oss");
  });

  it("removes provider config when user deselects a previously configured tool", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();

    // Create detect paths for both cursor and opencode
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    mkdirSync(join(tempDir, ".config", "opencode"), { recursive: true });

    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [
      CursorProvider(),
      OpenCodeProvider(),
    ]);

    // Pre-configure both providers so isConfigured() returns true
    CursorProvider().install(cfg, true);
    OpenCodeProvider().install(cfg, true);

    // User deselects opencode but keeps cursor
    mockToolSelection(["cursor"]);

    await runSetup();

    // OpenCode should have been removed (configured + deselected)
    const opencodeConfig = loadJSONConfig(join(tempDir, ".config", "opencode", "opencode.json"));
    expect(opencodeConfig.mcp?.dosu).toBeUndefined();

    // Cursor config should still have dosu entry (was skipped)
    const cursorConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(cursorConfig.mcpServers?.dosu).toBeDefined();

    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Removed from 1 agent"));
  });

  it("OSS mode configures MCP but never offers the audit handoff", async () => {
    // The audit acts on the user's own repo, so it's cloud-mode only.
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Configured 1 agent"));
    expect(p.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Kick off the codebase audit in Claude Code now?" }),
    );
  });

  it("installs the skill automatically for the selected agent", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(mockInstallSkill).toHaveBeenCalledWith(["cursor"], { quiet: true });
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Skill ready for 1 agent"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("/skills/cursor/dosu"));
  });

  it("does not install the skill when no agent is selected", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection([]);

    await runSetup();

    expect(mockInstallSkill).not.toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalledWith(expect.stringContaining("open-source libraries only"));
  });

  it("installs the selected agent skill in OSS mode", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(mockInstallSkill).toHaveBeenCalledWith(["cursor"], { quiet: true });
  });

  it("goes directly to agent selection without a component-selection prompt", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    const messages = vi
      .mocked(p.multiselect)
      .mock.calls.map(([args]) => String((args as { message?: string }).message ?? ""));
    expect(messages).toEqual(["Select agents — tick to configure, untick to remove"]);
    expect(messages.some((message) => message.includes("Dosu will set"))).toBe(false);
  });

  it("automatically updates AGENTS.md after configuring an agent in a git work tree", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mockInGitWorkTree.mockReturnValue(true);
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(mockStepUpdateAgentsMd).toHaveBeenCalledTimes(1);

    const completed = trackedCliOnboardingEvents().find(
      (e) => e.event === "cli_onboarding_completed",
    );
    expect(completed?.properties.completed_agents_md).toBe(true);
  });

  it("does not update AGENTS.md when no agent was configured", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mockInGitWorkTree.mockReturnValue(true);
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection([]);

    await runSetup();

    expect(mockStepUpdateAgentsMd).not.toHaveBeenCalled();
  });

  it("does not update AGENTS.md outside a git work tree", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(mockStepUpdateAgentsMd).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. runInstallSkill — focused unit tests
// ---------------------------------------------------------------------------

describe("runInstallSkill", () => {
  beforeEach(() => {
    setupTempEnv();
    vi.resetAllMocks();
    installSetupStepDefaults();
    installRemoteSetupDefaults();
    vi.mocked(p.isCancel).mockReturnValue(false);
    installMultiselectDefault();
  });
  afterEach(teardownTempEnv);

  it("calls installSkill and returns true on success", async () => {
    mockInstallSkill.mockResolvedValue({ success: true, sha: "abc" });

    const result = await runInstallSkill([ClaudeProvider()]);
    const spinner = vi.mocked(p.spinner).mock.results[0]?.value;

    expect(result).toBe(true);
    expect(spinner?.start).toHaveBeenCalledWith("Installing skill for 1 agent");
    expect(spinner?.clear).toHaveBeenCalledOnce();
    expect(mockInstallSkill).toHaveBeenCalledWith(["claude"], { quiet: true });
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Skill ready for 1 agent"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Claude Code"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("/skills/claude/dosu"));
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("(symlink)"));
  });

  it("uses plural loading copy for multiple selected agents", async () => {
    mockInstallSkill.mockResolvedValue({ success: true });

    await runInstallSkill([ClaudeProvider(), CursorProvider()]);
    const spinner = vi.mocked(p.spinner).mock.results[0]?.value;

    expect(spinner?.start).toHaveBeenCalledWith("Installing skill for 2 agents");
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Skill ready for 2 agent"));
  });

  it("returns false and logs error when installSkill reports failure", async () => {
    mockInstallSkill.mockResolvedValue({ success: false });

    const result = await runInstallSkill([ClaudeProvider()]);
    const spinner = vi.mocked(p.spinner).mock.results[0]?.value;

    expect(result).toBe(false);
    expect(spinner?.start).toHaveBeenCalledWith("Installing skill for 1 agent");
    expect(spinner?.clear).toHaveBeenCalledOnce();
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to install skill"));
  });

  it("returns false and logs error when installSkill throws", async () => {
    mockInstallSkill.mockRejectedValue(new Error("boom"));

    const result = await runInstallSkill([ClaudeProvider()]);
    const spinner = vi.mocked(p.spinner).mock.results[0]?.value;

    expect(result).toBe(false);
    expect(spinner?.start).toHaveBeenCalledWith("Installing skill for 1 agent");
    expect(spinner?.clear).toHaveBeenCalledOnce();
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

// ---------------------------------------------------------------------------
// 7. Checkpoint-aware resume (M1)
// ---------------------------------------------------------------------------

describe("runSetup checkpoint behavior", () => {
  const mockClient = vi.mocked(Client);
  const mockStartOAuthFlow = vi.mocked(startOAuthFlow);

  beforeEach(() => {
    setupTempEnv();
    vi.resetAllMocks();
    installSetupStepDefaults();
    installRemoteSetupDefaults();
    vi.mocked(p.isCancel).mockReturnValue(false);
    installMultiselectDefault();
    mockInstallSkill.mockResolvedValue({ success: true, sha: "test-sha" });
  });
  afterEach(teardownTempEnv);

  function setupAuthed(overrides: Record<string, unknown> = {}) {
    const methods = {
      doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
      refreshToken: vi.fn(),
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
      getDeployments: vi.fn().mockResolvedValue([makeDeployment()]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
      completeOnboarding: vi.fn().mockResolvedValue(undefined),
      // Default: github connect soft-skips (user not in git repo). Tests that
      // exercise it override.
      connectGithubRepo: vi.fn().mockResolvedValue({ skipped: true, reason: "repo_not_installed" }),
      ...overrides,
    };
    mockClient.mockImplementation(function () {
      return methods as unknown as Client;
    });
    return methods;
  }

  it("does not prompt for mode (mode selection UI is gone)", async () => {
    // Fresh config, no checkpoint. User declines login so we exit early,
    // but any p.select call must NOT have been a mode prompt.
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    const calls = vi.mocked(p.select).mock.calls;
    for (const [args] of calls) {
      expect(String(args.message).toLowerCase()).not.toContain("mode");
    }
  });

  it("does not offer the audit handoff when the user selects no agents", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection([]);

    await runSetup();

    expect(p.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Kick off the codebase audit in Claude Code now?" }),
    );
  });

  it("does not offer the audit handoff when no AI agents are detected", async () => {
    // User ticked MCP but has no supported agents installed. stepConfigureMcpTools
    // returns an empty array (nothing to configure), so the handoff would be useless.
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No supported AI agents detected"),
    );
    expect(p.confirm).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Kick off the codebase audit in Claude Code now?" }),
    );
  });

  it("persists a fresh token after successful authentication", async () => {
    // Fresh config (no token yet) → user authenticates → token is saved.
    saveConfig(
      makeCfg({
        access_token: "",
        refresh_token: "",
        expires_at: 0,
      }),
    );
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-fresh", refresh_token: "ref-fresh", expires_in: 3600 },
    });
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.session.access_token).toBe("tok-fresh");
    expect(saved.active_account?.session.refresh_token).toBe("ref-fresh");
  });

  it("mints a new API key when the existing one is invalid", async () => {
    saveConfig(makeCfg({ api_key: undefined }));
    const methods = setupAuthed();
    methods.validateAPIKey.mockResolvedValue(false);
    methods.createAPIKey.mockResolvedValue({ api_key: "fresh-key" });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.target?.api_key).toBe("fresh-key");
  });

  it("does not mark onboarding complete server-side — the web wizard owns that", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockTrpc.user.updateProfile.mutate).not.toHaveBeenCalled();
  });

  it("tracks completion when at least one valuable onboarding action succeeds", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(trackedCliOnboardingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cli_onboarding_skill_installed" }),
        expect.objectContaining({
          event: "cli_onboarding_completed",
          properties: expect.objectContaining({
            completed_mcp: true,
            completed_skill: true,
          }),
        }),
      ]),
    );
  });

  it("does not call updateProfile during ordinary cloud setup", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockTrpc.user.updateProfile.mutate).not.toHaveBeenCalled();
  });

  it("keeps ordinary setup free of GitHub when the remote profile is already onboarded", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStepConnectGitHubRepo).not.toHaveBeenCalled();
  });

  it("hands first-run users to the /cli/auth handshake even when the legacy CLI flag is disabled", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.objectContaining({ intent: "setup" }),
      undefined,
      expect.objectContaining({ waitWithoutBrowser: true }),
    );
    expect(mockStepConnectGitHubRepo).not.toHaveBeenCalled();
  });

  it("saves the freshly minted session from the web onboarding handback", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-minted", refresh_token: "ref-minted", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.session.access_token).toBe("tok-minted");
    expect(saved.active_account?.session.refresh_token).toBe("ref-minted");
  });

  it("aborts and tracks failure when the web onboarding handoff does not complete", async () => {
    saveConfig(makeCfg());
    const methods = setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockStartOAuthFlow.mockRejectedValue(new Error("timed out"));
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // The timeout guidance names the likeliest cause (account mismatch) and
    // its cure — never a bare "go finish in the browser" loop.
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("`dosu logout`"));
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("re-run `dosu setup`"));
    expect(trackedCliOnboardingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "cli_onboarding_failed",
          properties: expect.objectContaining({ reason: "web_onboarding_incomplete" }),
        }),
      ]),
    );
    // Never reached deployment binding or agent selection.
    expect(methods.getDeployments).not.toHaveBeenCalled();
    expect(p.multiselect).not.toHaveBeenCalled();
  });

  it("re-resolves everything when the handshake hands back a different account", async () => {
    // The twin-account incident shape: the CLI held account A's session and
    // stale target; the browser is signed in as account B. The handshake
    // returns B's minted session — the stale target must be dropped and B's
    // MCP bound, with a fresh API key (never A's).
    saveConfig(
      makeCfg({
        access_token: "account-a-token",
        refresh_token: "account-a-refresh",
        deployment_id: "account-a-deployment",
        deployment_name: "Account A MCP",
        api_key: "account-a-key",
        org_id: "account-a-org",
        space_id: "account-a-space",
      }),
    );
    const methods = setupAuthed({
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "account-b-org", name: "Account B Org" }]),
      getDeployments: vi.fn().mockResolvedValue([
        makeDeployment({
          deployment_id: "account-b-deployment",
          org_id: "account-b-org",
          org_name: "Account B Org",
          space_id: "account-b-space",
        }),
      ]),
    });
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "account-a-user",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "account-b-user",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: {
        access_token: "account-b-token",
        refresh_token: "account-b-refresh",
        expires_in: 3600,
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.user_id).toBe("account-b-user");
    expect(saved.active_account?.session.access_token).toBe("account-b-token");
    expect(saved.active_account?.session.refresh_token).toBe("account-b-refresh");
    expect(saved.active_account?.target?.org_id).toBe("account-b-org");
    expect(saved.active_account?.target?.space_id).toBe("account-b-space");
    expect(saved.active_account?.target?.deployment_id).toBe("account-b-deployment");
    expect(saved.active_account?.target?.api_key).toBe("new-key");
    expect(methods.validateAPIKey).not.toHaveBeenCalled();
  });

  it("never runs the terminal GitHub step during first-run onboarding", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStepConnectGitHubRepo).not.toHaveBeenCalled();
  });

  it("completes a fresh first-run in a single browser trip (wizard rides the auth hop)", async () => {
    // Fresh config → the auth hop itself carries `intent=setup`, so the web
    // side routes the wizard inside that same trip. There is no second
    // browser flow and no tab-steering machinery.
    saveConfig(makeCfg({ access_token: "", refresh_token: "", expires_at: 0 }));
    setupAuthed();
    // By the time the CLI queries its context, the browser-side wizard has
    // already finished — the flag comes back true.
    mockStartOAuthFlow.mockResolvedValueOnce({
      browserOpened: true,
      token: { access_token: "tok-auth", refresh_token: "ref-auth", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStartOAuthFlow).toHaveBeenCalledTimes(1);
    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.objectContaining({ intent: "setup" }),
      undefined,
      expect.objectContaining({ timeoutMs: 30 * 60 * 1000 }),
    );
    expect(p.outro).toHaveBeenCalled();
  });

  it("honors --deployment over the web onboarding handoff for unfinished profiles", async () => {
    // `--deployment` is an explicit escape hatch: even a first-run profile
    // must be wired straight to the requested deployment, never silently
    // rerouted through the wizard and auto-bound elsewhere.
    saveConfig(makeCfg({ deployment_id: undefined, deployment_name: undefined }));
    setupAuthed({
      getDeployments: vi
        .fn()
        .mockResolvedValue([makeDeployment({ deployment_id: "dep-explicit" })]),
    });
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup({ deploymentID: "dep-explicit" });

    // No web-onboarding handoff was started (no browser flow at all — the
    // session was already valid), and the explicit deployment was bound.
    expect(mockStartOAuthFlow).not.toHaveBeenCalled();
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBe("dep-explicit");
  });
});

// ---------------------------------------------------------------------------
// 8. Additional branch coverage for runSetup error/edge paths
// ---------------------------------------------------------------------------

describe("runSetup additional branches", () => {
  const mockClient = vi.mocked(Client);

  beforeEach(() => {
    setupTempEnv();
    vi.resetAllMocks();
    installSetupStepDefaults();
    installRemoteSetupDefaults();
    vi.mocked(p.isCancel).mockReturnValue(false);
    installMultiselectDefault();
    mockInstallSkill.mockResolvedValue({ success: true, sha: "test-sha" });
  });
  afterEach(teardownTempEnv);

  function setupAuthed(overrides: Record<string, unknown> = {}) {
    const methods = {
      doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
      refreshToken: vi.fn(),
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
      getDeployments: vi.fn().mockResolvedValue([makeDeployment()]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
      ...overrides,
    };
    mockClient.mockImplementation(function () {
      return methods as unknown as Client;
    });
    return methods;
  }

  it("aborts when the cloud setup context fails to load (profile has no user_id)", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    // Profile without a user_id → resolveCloudSetupContext returns null.
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: null,
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith("Could not load your profile.");
    // Never advanced to agent selection / outro.
    expect(p.outro).not.toHaveBeenCalled();
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_failed" &&
          e.properties?.reason === "cloud_setup_context_failed",
      ),
    ).toBe(true);
  });

  it("aborts when the cloud setup context query throws", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockRejectedValue(new Error("trpc down"));
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not load your onboarding state"),
    );
    expect(p.outro).not.toHaveBeenCalled();
  });

  it("aborts when the handshake account has no organizations", async () => {
    saveConfig(makeCfg());
    setupAuthed({ getOrgs: vi.fn().mockResolvedValue([]) });
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "user-b",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    vi.mocked(startOAuthFlow).mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith("No organizations found for your account");
    expect(p.outro).not.toHaveBeenCalled();
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_failed" &&
          e.properties?.reason === "deployment_resolution_failed",
      ),
    ).toBe(true);
  });

  it("aborts when the handshake account's org has no MCPs", async () => {
    saveConfig(makeCfg());
    // Deployments exist but none belong to the handshake account's org.
    setupAuthed({
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "org-b", name: "Org B" }]),
      getDeployments: vi
        .fn()
        .mockResolvedValue([makeDeployment({ deployment_id: "dep-other", org_id: "other-org" })]),
    });
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "user-b",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    vi.mocked(startOAuthFlow).mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("No MCPs found for Org B"));
    expect(p.outro).not.toHaveBeenCalled();
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_failed" &&
          e.properties?.reason === "deployment_resolution_failed",
      ),
    ).toBe(true);
  });

  it("asks instead of guessing when the org has several deployments but no dosu_mcp", async () => {
    // The old flow silently grabbed the first deployment regardless of slug;
    // with repo-deployments in the mix that guess is usually wrong. When no
    // single MCP disambiguates, show the picker.
    saveConfig(makeCfg());
    setupAuthed({
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "org-b", name: "Org B" }]),
      getDeployments: vi.fn().mockResolvedValue([
        makeDeployment({
          deployment_id: "dep-x",
          org_id: "org-b",
          provider_slug: "some_other_provider",
        }),
        makeDeployment({
          deployment_id: "dep-y",
          org_id: "org-b",
          provider_slug: "github",
        }),
      ]),
    });
    vi.mocked(p.select).mockResolvedValue("dep-x");
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "user-b",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    vi.mocked(startOAuthFlow).mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select an MCP" }));
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBe("dep-x");
  });

  it("does not emit the removed component-selection telemetry event", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockInstallSkill).not.toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalled();
    expect(trackedCliOnboardingEvents().map((event) => event.event)).not.toContain(
      "cli_onboarding_options_selected",
    );
  });

  it("returns early when the MCP tool selection is cancelled", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);

    const cancelSymbol = Symbol("cancel");
    vi.mocked(p.multiselect).mockResolvedValue(cancelSymbol as unknown as never);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    expect(p.outro).not.toHaveBeenCalled();
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_cancelled" &&
          e.properties?.reason === "mcp_selection_cancelled",
      ),
    ).toBe(true);
  });

  it("switches mode from OSS to Cloud when --mode cloud is passed over an OSS config", async () => {
    saveConfig(makeCfg({ mode: "oss" }));
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup({ mode: "cloud" });

    const saved = loadConfig();
    expect(saved.mode).toBeUndefined();
  });

  it("continues to the outro when the skill install reports failure", async () => {
    // skillCompleted is false → the `if (skillCompleted)` tracking branch is
    // skipped, but the flow still completes (MCP/docs unaffected).
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);
    mockInstallSkill.mockResolvedValue({ success: false });

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to install skill"));
    const skillEvents = trackedCliOnboardingEvents().map((e) => e.event);
    expect(skillEvents).not.toContain("cli_onboarding_skill_installed");
  });

  it("neither installs nor removes a detected tool that is unconfigured and left unticked", async () => {
    // Cursor is detected but not configured, so it starts unticked. The default
    // multiselect leaves it unticked → it lands in neither toInstall nor
    // toRemove (the else arm of `else if (isConfigured)`).
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    // Accept the agent selection's initial values (none, since unconfigured).
    installMultiselectDefault();

    await runSetup();

    // Nothing written to disk for cursor (not installed, not removed).
    expect(existsSync(join(tempDir, ".cursor", "mcp.json"))).toBe(false);
  });

  it("returns no org when the org selection resolves to an unknown id", async () => {
    // p.select returns a value that doesn't match any org → `orgs.find(...) ??
    // null` takes the null arm and the deployment never gets saved.
    saveConfig(makeCfg({ deployment_id: undefined, deployment_name: undefined }));
    setupAuthed({
      getOrgs: vi.fn().mockResolvedValue([
        { org_id: "o1", name: "Org1" },
        { org_id: "o2", name: "Org2" },
      ]),
    });
    vi.mocked(p.select).mockResolvedValueOnce("does-not-exist");
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
    expect(p.outro).not.toHaveBeenCalled();
  });

  it("returns no deployment when the MCP selection resolves to an unknown id", async () => {
    // p.select returns a value that matches no deployment → `deployments.find(...)
    // ?? null` takes the null arm.
    saveConfig(makeCfg({ deployment_id: undefined, deployment_name: undefined }));
    setupAuthed({
      getDeployments: vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "D2", org_id: "o1", org_name: "Org1" },
      ]),
    });
    vi.mocked(p.select).mockResolvedValueOnce("nope");
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBeUndefined();
    expect(p.outro).not.toHaveBeenCalled();
  });

  it("tracks MCP configuration after the setup handshake hands back", async () => {
    // First-run: the browser handshake hands back, then the MCP tool
    // configuration still runs (and is tracked) in the terminal.
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    vi.mocked(startOAuthFlow).mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-web", refresh_token: "ref-web", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    const events = trackedCliOnboardingEvents().map((input) => input.event);
    expect(events).toContain("cli_onboarding_mcp_configured");
    expect(events).toContain("cli_onboarding_completed");
  });
});

// ---------------------------------------------------------------------------
// 9. Single-handshake protocol: /cli/auth owns onboarding routing.
//
// The CLI no longer decides "first run" by itself and never deep-links a web
// product page: it expresses `intent=setup` on the ONE browser entry
// (/cli/auth) and the web routes by the *browser* user's state. The callback
// always comes back — with a session for whoever is really in the browser.
// ---------------------------------------------------------------------------

const SETUP_HANDSHAKE_TIMEOUT_MS = 30 * 60 * 1000;

describe("runSetup single-handshake protocol", () => {
  const mockClient = vi.mocked(Client);
  const mockStartOAuthFlow = vi.mocked(startOAuthFlow);

  beforeEach(() => {
    setupTempEnv();
    vi.resetAllMocks();
    installSetupStepDefaults();
    installRemoteSetupDefaults();
    vi.mocked(p.isCancel).mockReturnValue(false);
    installMultiselectDefault();
    mockInstallSkill.mockResolvedValue({ success: true, sha: "test-sha" });
  });
  afterEach(() => {
    process.exitCode = undefined;
    teardownTempEnv();
  });

  function setupAuthed(overrides: Record<string, unknown> = {}) {
    const methods = {
      doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
      refreshToken: vi.fn(),
      getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
      getDeployments: vi.fn().mockResolvedValue([makeDeployment()]),
      validateAPIKey: vi.fn().mockResolvedValue(true),
      createAPIKey: vi.fn().mockResolvedValue({ api_key: "new-key" }),
      ...overrides,
    };
    mockClient.mockImplementation(function () {
      return methods as unknown as Client;
    });
    return methods;
  }

  function firstRunThenOnboarded() {
    // CLI-session user is not onboarded; the account the browser hands back
    // is a different, already-onboarded one (the twin-account incident).
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "user-b",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: {
        access_token: "tok-b",
        refresh_token: "ref-b",
        expires_in: 3600,
        email: "b@example.com",
      },
    });
  }

  it("hands a first-run user to /cli/auth with intent=setup and a 30-minute window", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    firstRunThenOnboarded();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.objectContaining({ intent: "setup" }),
      undefined,
      expect.objectContaining({
        waitWithoutBrowser: true,
        timeoutMs: SETUP_HANDSHAKE_TIMEOUT_MS,
      }),
    );
    const paths = mockStartOAuthFlow.mock.calls.map((call) => call[1]);
    expect(paths).not.toContain("/onboarding/connections");
  });

  it("rebinds to the account the browser handed back (cross-account self-heal)", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    firstRunThenOnboarded();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.user_id).toBe("user-b");
    expect(saved.active_account?.session.access_token).toBe("tok-b");
    // The wizard creates one repo-deployment per connected repo — the MCP
    // deployment must still be auto-bound without an interactive picker.
    expect(saved.active_account?.target?.deployment_id).toBe("d1");
    expect(p.outro).toHaveBeenCalled();
  });

  it("auto-binds the single dosu_mcp deployment even among repo deployments", async () => {
    saveConfig(makeCfg());
    setupAuthed({
      getDeployments: vi
        .fn()
        .mockResolvedValue([
          makeDeployment({ deployment_id: "repo-1", provider_slug: "github", name: "my-repo" }),
          makeDeployment(),
          makeDeployment({ deployment_id: "repo-2", provider_slug: "gitlab", name: "my-lib" }),
        ]),
    });
    firstRunThenOnboarded();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.select).not.toHaveBeenCalled();
    const saved = loadConfig();
    expect(saved.active_account?.target?.deployment_id).toBe("d1");
  });

  it("surfaces the browser's real reason when the handshake calls back with an error", async () => {
    // An `?error=` callback is an ANSWER, not silence: show the web side's
    // message instead of the generic "didn't hear back" + logout advice.
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: false,
    });
    const { OAuthCallbackError } = await import("../auth/errors");
    mockStartOAuthFlow.mockRejectedValue(
      new OAuthCallbackError("cli_mint_failed", {
        error: "cli_mint_failed",
        errorDescription: "The authentication service rejected the request",
      }),
    );
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.error).toHaveBeenCalledWith(
      expect.stringContaining("The authentication service rejected the request"),
    );
    expect(p.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Didn't hear back"));
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_failed" &&
          e.properties?.reason === "web_onboarding_incomplete",
      ),
    ).toBe(true);
  });

  it("keeps the same account's stored target after the handshake (everyday semantics)", async () => {
    // The sibling branch of the cross-account rebind above: when the SAME
    // account comes back (now onboarded), the stored deployment is
    // deliberately reused — no picker, no re-resolution. Note: the token must
    // be JWT-shaped so replaceLoginSession can see it is the same user.
    saveConfig(makeCfg());
    setupAuthed();
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "test-user-id" })).toString("base64url");
    mockTrpc.user.getCliOnboardingContext.query
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: false,
        cli_onboarding_enabled: false,
      })
      .mockResolvedValueOnce({
        user_id: "test-user-id",
        finished_onboarding: true,
        cli_onboarding_enabled: false,
      });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: {
        access_token: `${header}.${payload}.signature`,
        refresh_token: "ref-same",
        expires_in: 3600,
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.active_account?.user_id).toBe("test-user-id");
    expect(saved.active_account?.target?.deployment_id).toBe("dep-123");
    expect(p.select).not.toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalled();
  });

  it("aborts once with guidance when the handshake returns a still-not-onboarded account", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: false,
    });
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: { access_token: "tok-x", refresh_token: "ref-x", expires_in: 3600 },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    // Exactly one browser trip — never a handshake loop.
    expect(mockStartOAuthFlow).toHaveBeenCalledTimes(1);
    expect(p.outro).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(
      trackedCliOnboardingEvents().some(
        (e) =>
          e.event === "cli_onboarding_failed" &&
          e.properties?.reason === "onboarding_incomplete_after_handshake",
      ),
    ).toBe(true);
  });

  it("sends intent=setup on the first browser hop for cloud mode", async () => {
    // No stored session at all → stepAuthenticate goes to the browser.
    setupAuthed();
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: {
        access_token: "tok-fresh",
        refresh_token: "ref-fresh",
        expires_in: 3600,
        email: "fresh@example.com",
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.objectContaining({ intent: "setup" }),
      undefined,
      expect.objectContaining({ timeoutMs: SETUP_HANDSHAKE_TIMEOUT_MS }),
    );
  });

  it("keeps the OSS first hop free of the setup intent", async () => {
    setupAuthed();
    // OSS mode never queries the cloud profile, so the account identity must
    // come from the JWT itself (as it does with real tokens).
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "oss-user" })).toString("base64url");
    mockStartOAuthFlow.mockResolvedValue({
      browserOpened: true,
      token: {
        access_token: `${header}.${payload}.signature`,
        refresh_token: "ref-oss",
        expires_in: 3600,
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup({ mode: "oss" });

    const [, , params] = mockStartOAuthFlow.mock.calls[0];
    expect(params).not.toHaveProperty("intent");
  });

  it("keeps the setup flow's only web-app path /cli/auth (source contract)", () => {
    // The 2026-08-05 deadlock began with the CLI deep-linking a web product
    // page whose middleware owed it nothing. The setup flow may only ever
    // link the protocol endpoint.
    const source = readFileSync(new URL("./flow.ts", import.meta.url), "utf8");
    expect(source).not.toContain("/onboarding/");
  });
});
