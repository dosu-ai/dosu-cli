import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  skillCommand: vi.fn(),
}));

const { mockStepConnectGitHubRepo, mockStepImportGitHubDocs } = vi.hoisted(() => ({
  mockStepConnectGitHubRepo: vi.fn(),
  mockStepImportGitHubDocs: vi.fn(),
}));
vi.mock("./github-step", () => ({
  stepConnectGitHubRepo: (...args: unknown[]) => mockStepConnectGitHubRepo(...args),
}));
vi.mock("./github-doc-import-step", () => ({
  stepImportGitHubDocs: (...args: unknown[]) => mockStepImportGitHubDocs(...args),
}));

import * as p from "@clack/prompts";
import { OAuthCallbackError } from "../auth/errors";
import { startOAuthFlow } from "../auth/flow";
import type { TokenResponse } from "../auth/server";
import { Client } from "../client/client";
import type { Config } from "../config/config";
import { loadConfig, MODE_OSS, saveConfig } from "../config/config";
import { loadJSONConfig, saveJSONConfig } from "../mcp/config-helpers";
import * as providersModule from "../mcp/providers";
import { ClaudeDesktopProvider } from "../mcp/providers/claude-desktop";
import { CursorProvider } from "../mcp/providers/cursor";
import { OpenCodeProvider } from "../mcp/providers/opencode";
import {
  type ConfigResult,
  isStdioOnly,
  runInstallSkill,
  runSetup,
  showTryItOutPrompt,
  stepConfigureTools,
  stepDetectTools,
  stepShowSummary,
  type ToolSelection,
} from "./flow";

/**
 * Default p.multiselect behaviour: auto-accept the initialValues for the
 * one-shot confirm step (`stepOneShotConfirm`) AND the tool-selection step.
 * Tests that want to override tool selection use `mockToolSelection()` below.
 */
function installMultiselectDefault() {
  vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
    const o = opts as { message: string; initialValues?: unknown[] };
    return (o.initialValues ?? []) as unknown as never;
  });
}

/**
 * Override tool selection with a specific set of provider IDs while still
 * auto-accepting the upfront one-shot confirm. Use instead of
 * `vi.mocked(p.multiselect).mockResolvedValue(...)`.
 */
function mockToolSelection(selection: string[]) {
  vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
    const o = opts as { message: string; initialValues?: unknown[] };
    const msg = String(o.message ?? "").toLowerCase();
    if (msg.includes("dosu will set")) {
      return (o.initialValues ?? []) as unknown as never;
    }
    return selection as unknown as never;
  });
}

function installSetupStepDefaults() {
  mockStepConnectGitHubRepo.mockResolvedValue({ advance: false, has_connected_repo: false });
  mockStepImportGitHubDocs.mockResolvedValue({ advance: false });
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
    vi.resetAllMocks();
    installSetupStepDefaults();
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
    expect(results[0].error?.message).toContain("stdio");
    // p.log.error should have been called
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Claude Desktop"));
  });

  it("handles remove errors and records them in results", () => {
    const claudeDesktop = ClaudeDesktopProvider();
    const cfg = makeCfg();
    // ClaudeDesktopProvider.remove() always throws
    const selection: ToolSelection = {
      toInstall: [],
      toRemove: [claudeDesktop],
      skipped: [],
    };

    const results = stepConfigureTools(cfg, selection);

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("remove");
    expect(results[0].error).toBeDefined();
    expect(results[0].error?.message).toContain("stdio");
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Claude Desktop"));
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
    // "Try it out" moved to showTryItOutPrompt at end of runSetup.
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("logs removed tools count for removals", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [{ provider: cursor, action: "remove" }];

    stepShowSummary(results);

    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Removed from 1 agent"));
    // No "Try it out" when only removals
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("shows 'all configured' when only skipped results", () => {
    const cursor = CursorProvider();
    const results: ConfigResult[] = [{ provider: cursor, action: "skip" }];

    stepShowSummary(results);

    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("All agents already configured"),
    );
    // "Try it out" moved to showTryItOutPrompt at end of runSetup.
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

  it("does not show 'Try it out' when only removals and no skips", () => {
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
    // "Try it out" moved to showTryItOutPrompt at end of runSetup.
    expect(p.log.message).not.toHaveBeenCalled();
  });

  it("does not show 'Try it out' or 'all configured' when results are empty", () => {
    stepShowSummary([]);

    expect(p.log.success).not.toHaveBeenCalled();
    expect(p.log.info).not.toHaveBeenCalled();
    expect(p.log.message).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4b. showTryItOutPrompt — pure, just inspects the message string
// ---------------------------------------------------------------------------

describe("showTryItOutPrompt", () => {
  beforeEach(() => {
    vi.mocked(p.log.message).mockClear();
  });

  it("suggests querying imported docs when docsImported is true", () => {
    showTryItOutPrompt({ docsImported: true, hasAgentsMd: true });

    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining("summarize the most important docs"),
    );
    expect(p.log.message).not.toHaveBeenCalledWith(expect.stringContaining("host my AGENTS.md"));
  });

  it("suggests hosting AGENTS.md when the file exists and no docs were imported", () => {
    showTryItOutPrompt({ docsImported: false, hasAgentsMd: true });

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("host my AGENTS.md"));
  });

  it("suggests drafting AGENTS.md when neither docs are imported nor the file exists", () => {
    showTryItOutPrompt({ docsImported: false, hasAgentsMd: false });

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("draft an AGENTS.md"));
    expect(p.log.message).not.toHaveBeenCalledWith(expect.stringContaining("host my AGENTS.md"));
  });

  it("uses the OSS prompt regardless of other flags", () => {
    showTryItOutPrompt({ mode: MODE_OSS, docsImported: true, hasAgentsMd: true });

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("open source library"));
    expect(p.log.message).not.toHaveBeenCalledWith(
      expect.stringContaining("summarize the most important docs"),
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
    mockClient.mockImplementation(() => clientMethods as unknown as Client);
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
    vi.mocked(p.confirm).mockResolvedValue(cancelSymbol as unknown as boolean);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    expect(mockStartOAuthFlow).not.toHaveBeenCalled();
  });

  it("logs curated OAuth callback errors during browser login", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
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
    expect(savedCfg.deployment_id).toBe("d1");
    expect(savedCfg.deployment_name).toBe("Deploy1");
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
  });

  it("runs OAuth flow and saves tokens to real config", async () => {
    // No pre-existing config (fresh temp dir), so needs login. No mode prompt anymore.
    vi.mocked(p.confirm).mockResolvedValue(true);
    mockStartOAuthFlow.mockResolvedValue({
      access_token: "oauth-tok",
      refresh_token: "oauth-ref",
      expires_in: 7200,
    } as TokenResponse);

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
    expect(savedCfg.deployment_id).toBe("d2");
    expect(savedCfg.api_key).toBe("key-abc");

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
    expect(savedCfg.api_key).toBe("fresh-key");
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
    expect(saved.deployment_id).toBe("d2");
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
    // Cancel only the tool-selection multiselect; accept the one-shot confirm.
    vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
      const o = opts as { message: string; initialValues?: unknown[] };
      if (
        String(o.message ?? "")
          .toLowerCase()
          .includes("dosu will set")
      ) {
        return (o.initialValues ?? []) as unknown as never;
      }
      return cancelSymbol as unknown as never;
    });
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
    vi.mocked(p.select).mockResolvedValueOnce(cancelSymbol as unknown);
    vi.mocked(p.isCancel).mockImplementation((val) => val === cancelSymbol);

    await runSetup();

    const saved = loadConfig();
    expect(saved.deployment_id).toBeUndefined();
  });

  it("shows deployment not found error", async () => {
    const cfg = makeCfg({ deployment_id: undefined, deployment_name: undefined });
    saveConfig(cfg);

    setupAuthenticatedClient({
      getDeployments: vi
        .fn()
        .mockResolvedValue([{ deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" }]),
    });

    await runSetup({ deploymentID: "nonexistent" });

    expect(p.log.error).toHaveBeenCalledWith("MCP nonexistent not found");
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

    // Falls through to login prompt
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runSetup();

    // Should have asked to login
    expect(p.confirm).toHaveBeenCalled();
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
    expect(saved.deployment_id).toBe("d1");
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
    expect(saved.deployment_id).toBeUndefined();
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
    expect(saved.deployment_id).toBeUndefined();
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

  it("OSS mode stepShowSummary uses OSS-specific prompt", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup();

    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("Dosu help"));
  });

  it("installs skill automatically when the one-shot confirm leaves it ticked", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockInstallSkill).toHaveBeenCalled();
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Skill installed"));
  });

  it("does not install skill when the one-shot confirm unticks it", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    // Override the one-shot confirm to deselect the skill item.
    vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
      const o = opts as { message: string; initialValues?: unknown[] };
      if (
        String(o.message ?? "")
          .toLowerCase()
          .includes("dosu will set")
      ) {
        return ["configureMcp"] as unknown as never;
      }
      return (o.initialValues ?? []) as unknown as never;
    });

    await runSetup();

    expect(mockInstallSkill).not.toHaveBeenCalled();
    expect(p.outro).toHaveBeenCalledWith(expect.stringContaining("open-source libraries only"));
  });

  it("installs skill in OSS mode when the one-shot confirm leaves it ticked", async () => {
    const cfg = makeCfg({ mode: "oss" });
    saveConfig(cfg);

    setupAuthenticatedClient();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockInstallSkill).toHaveBeenCalled();
  });

  it("shows the GitHub docs import label in the one-shot confirm", async () => {
    const cfg = makeCfg();
    saveConfig(cfg);

    setupAuthenticatedClient();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const oneShotCall = vi
      .mocked(p.multiselect)
      .mock.calls.find(([args]) =>
        String((args as { message?: string }).message ?? "").includes("Dosu will set"),
      );
    const options = (oneShotCall?.[0] as { options: Array<{ label: string }> }).options;
    expect(options.map((option) => String(option.label))).toEqual(
      expect.arrayContaining([expect.stringContaining("Import docs from GitHub")]),
    );
    expect(options.map((option) => String(option.label))).toEqual(
      expect.arrayContaining([expect.stringContaining("Keep them up to date")]),
    );
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

    const result = await runInstallSkill();

    expect(result).toBe(true);
    expect(mockInstallSkill).toHaveBeenCalled();
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Skill installed"));
  });

  it("returns false and logs error when installSkill reports failure", async () => {
    mockInstallSkill.mockResolvedValue({ success: false });

    const result = await runInstallSkill();

    expect(result).toBe(false);
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to install skill"));
  });

  it("returns false and logs error when installSkill throws", async () => {
    mockInstallSkill.mockRejectedValue(new Error("boom"));

    const result = await runInstallSkill();

    expect(result).toBe(false);
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
    mockClient.mockImplementation(() => methods as unknown as Client);
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

  it("does not show the 'Try it out' prompt when the user unticks MCP", async () => {
    // If the user deselects both "Install Dosu MCP" and "Install Dosu skill"
    // from the one-shot confirm, nothing was configured this run, so the
    // paste-into-your-agent tip would be noise.
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    // Override the one-shot confirm to return an empty selection.
    vi.mocked(p.multiselect).mockImplementation(async (opts: unknown) => {
      const o = opts as { message: string };
      if (
        String(o.message ?? "")
          .toLowerCase()
          .includes("dosu will set")
      ) {
        return [] as unknown as never;
      }
      return [] as unknown as never;
    });

    await runSetup();

    expect(p.log.message).not.toHaveBeenCalledWith(expect.stringContaining("Try it out"));
  });

  it("does not show the 'Try it out' prompt when no AI agents are detected", async () => {
    // User ticked MCP but has no supported agents installed. stepConfigureMcpTools
    // returns an empty array (nothing to configure), so the tip would be useless.
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No supported AI agents detected"),
    );
    expect(p.log.message).not.toHaveBeenCalledWith(expect.stringContaining("Try it out"));
  });

  it("--yes accepts the default MCP setup choice", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);
    mockToolSelection(["cursor"]);

    await runSetup({ yes: true, skipSkill: true, skipGitHub: true });

    const cursorConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(cursorConfig.mcpServers.dosu).toBeDefined();
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
      access_token: "tok-fresh",
      refresh_token: "ref-fresh",
      expires_in: 3600,
    } as TokenResponse);
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    const saved = loadConfig();
    expect(saved.access_token).toBe("tok-fresh");
    expect(saved.refresh_token).toBe("ref-fresh");
  });

  it("supports agent-mediated login and explicit tool configuration", async () => {
    saveConfig(
      makeCfg({
        access_token: "",
        refresh_token: "",
        expires_at: 0,
        deployment_id: undefined,
        deployment_name: undefined,
      }),
    );
    mockStartOAuthFlow.mockResolvedValue({
      access_token: "tok-agent",
      refresh_token: "ref-agent",
      expires_in: 3600,
    } as TokenResponse);
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockImplementation(() => [CursorProvider()]);

    await runSetup({
      yes: true,
      openBrowser: false,
      toolIDs: ["cursor"],
      skipSkill: true,
      skipGitHub: true,
    });

    expect(p.confirm).not.toHaveBeenCalled();
    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      expect.any(Object),
      expect.objectContaining({ openBrowser: false }),
    );
    expect(p.multiselect).not.toHaveBeenCalled();
    expect(mockInstallSkill).not.toHaveBeenCalled();

    const cursorConfig = loadJSONConfig(join(tempDir, ".cursor", "mcp.json"));
    expect(cursorConfig.mcpServers.dosu).toBeDefined();
    expect(loadConfig().access_token).toBe("tok-agent");
  });

  it("mints a new API key when the existing one is invalid", async () => {
    saveConfig(makeCfg({ api_key: undefined }));
    const methods = setupAuthed();
    methods.validateAPIKey.mockResolvedValue(false);
    methods.createAPIKey.mockResolvedValue({ api_key: "fresh-key" });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    await runSetup();

    const saved = loadConfig();
    expect(saved.api_key).toBe("fresh-key");
  });

  it("marks remote onboarding complete at the end of first-run cloud onboarding", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({ advance: true, has_connected_repo: false });
    mockStepImportGitHubDocs.mockResolvedValue({ advance: true });

    await runSetup();

    expect(mockTrpc.user.updateProfile.mutate).toHaveBeenCalledTimes(1);
    expect(mockTrpc.user.updateProfile.mutate).toHaveBeenCalledWith({
      user_id: "test-user-id",
      finished_onboarding: true,
    });
  });

  it("tracks completion when at least one valuable onboarding action succeeds", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(trackedCliOnboardingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cli_onboarding_skill_installed" }),
        expect.objectContaining({
          event: "cli_onboarding_completed",
          properties: expect.objectContaining({
            completed_mcp: false,
            completed_skill: true,
            imported_docs: false,
          }),
        }),
      ]),
    );
  });

  it("tracks docs import as activation during first-run onboarding", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({
      advance: true,
      has_connected_repo: true,
      created_data_source_ids: ["ds-1"],
    });
    mockStepImportGitHubDocs.mockResolvedValue({
      advance: true,
      imported: true,
      imported_count: 3,
      failed_count: 0,
      task_id: "task-1",
    });

    await runSetup();

    expect(trackedCliOnboardingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "cli_onboarding_github_connected" }),
        expect.objectContaining({
          event: "cli_onboarding_docs_imported",
          properties: expect.objectContaining({ imported_count: 3, task_id: "task-1" }),
        }),
        expect.objectContaining({
          event: "cli_onboarding_activated",
          properties: expect.objectContaining({ imported_count: 3 }),
        }),
        expect.objectContaining({
          event: "cli_onboarding_completed",
          properties: expect.objectContaining({ imported_docs: true }),
        }),
      ]),
    );
  });

  it("does not track activation when docs import is only queued", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({
      advance: true,
      has_connected_repo: true,
      created_data_source_ids: ["ds-1"],
    });
    mockStepImportGitHubDocs.mockResolvedValue({
      advance: true,
      imported: false,
      imported_count: 0,
      queued: true,
      task_id: "task-1",
    });

    await runSetup();

    const events = trackedCliOnboardingEvents().map((input) => input.event);
    expect(events).not.toContain("cli_onboarding_docs_imported");
    expect(events).not.toContain("cli_onboarding_activated");
    expect(trackedCliOnboardingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "cli_onboarding_completed",
          properties: expect.objectContaining({
            completed_skill: true,
            imported_docs: false,
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

  it("warns but does not throw when remote onboarding completion fails", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockTrpc.user.updateProfile.mutate.mockRejectedValueOnce(new Error("503 Service Unavailable"));
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({ advance: true, has_connected_repo: false });
    mockStepImportGitHubDocs.mockResolvedValue({ advance: true });

    await runSetup();

    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not mark onboarding complete"),
    );
  });

  it("keeps ordinary setup free of GitHub when the remote profile is already onboarded", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStepConnectGitHubRepo).not.toHaveBeenCalled();
    expect(mockStepImportGitHubDocs).not.toHaveBeenCalled();
  });

  it("keeps setup free of GitHub when onboarding is incomplete but the CLI flag is disabled", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: false,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    await runSetup();

    expect(mockStepConnectGitHubRepo).not.toHaveBeenCalled();
    expect(mockStepImportGitHubDocs).not.toHaveBeenCalled();
    expect(mockTrpc.user.updateProfile.mutate).not.toHaveBeenCalled();
  });

  it("binds first-run onboarding to the owner org instead of stale local config", async () => {
    saveConfig(
      makeCfg({
        deployment_id: "old-dep",
        deployment_name: "Old Deploy",
        org_id: "old-org",
        space_id: "old-space",
      }),
    );
    setupAuthed({
      getDeployments: vi.fn().mockResolvedValue([
        makeDeployment({
          deployment_id: "dep-old",
          org_id: "old-org",
          org_name: "Old Org",
          space_id: "space-old",
        }),
        makeDeployment({
          deployment_id: "dep-owner",
          org_id: "owner-org",
          org_name: "Owner Org",
          space_id: "space-owner",
        }),
      ]),
    });
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    mockTrpc.organization.getOrganizations.query.mockResolvedValue([
      { org_id: "owner-org", name: "Owner Org", user_role: "OWNER" },
    ]);
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({ advance: true, has_connected_repo: false });
    mockStepImportGitHubDocs.mockResolvedValue({ advance: true });

    await runSetup();

    const saved = loadConfig();
    expect(saved.org_id).toBe("owner-org");
    expect(saved.space_id).toBe("space-owner");
    expect(saved.deployment_id).toBe("dep-owner");
  });

  it("always starts the GitHub step from repo selection during first-run onboarding", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({
      advance: true,
      has_connected_repo: true,
      deployment_id: "dep-github",
      space_id: "space-1",
    });
    mockStepImportGitHubDocs.mockResolvedValue({ advance: true });

    await runSetup();

    expect(mockStepConnectGitHubRepo).toHaveBeenCalledTimes(1);
    expect(mockStepImportGitHubDocs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ waitForFreshDocs: true }),
    );
  });

  it("does not wait for fresh docs when no repo was connected in this run", async () => {
    saveConfig(makeCfg());
    setupAuthed();
    mockTrpc.user.getCliOnboardingContext.query.mockResolvedValue({
      user_id: "test-user-id",
      finished_onboarding: false,
      cli_onboarding_enabled: true,
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);
    mockStepConnectGitHubRepo.mockResolvedValue({
      advance: true,
      has_connected_repo: false,
    });
    mockStepImportGitHubDocs.mockResolvedValue({ advance: true });

    await runSetup();

    expect(mockStepImportGitHubDocs).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ waitForFreshDocs: false }),
    );
  });
});
