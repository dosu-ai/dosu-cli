import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type FlatTestConfig,
  makeTestConfig,
  testAccessTokenFor,
  testSession,
  testTarget,
} from "../config/config.test-utils";
import type { SetupProvider } from "../mcp/providers";
import { VERSION } from "../version/version";

const {
  mockMintTicket,
  mockExchangeTicket,
  mockLoadConfig,
  mockSaveConfig,
  mockAllSetupProviders,
  mockClient,
  mockClientConstructor,
  mockFetchDosuRule,
  mockInstallRuleForAgent,
  mockIsRuleAgent,
  mockInstallSkill,
  mockSkillAgentIDsForProviders,
  mockInGitWorkTree,
  mockUpsertDosuAgentsSection,
  mockRequireProjectRoot,
  mockInstallProjectInstructions,
  mockResolveProjectProof,
  mockRunProjectScopeMigration,
} = vi.hoisted(() => {
  return {
    mockMintTicket: vi.fn(),
    mockExchangeTicket: vi.fn(),
    mockLoadConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockAllSetupProviders: vi.fn(),
    mockClient: {
      doRequestRaw: vi.fn(),
      refreshToken: vi.fn(),
      getDeployments: vi.fn(),
      validateAPIKey: vi.fn(),
      createAPIKey: vi.fn(),
    },
    mockClientConstructor: vi.fn(),
    mockFetchDosuRule: vi.fn(),
    mockInstallRuleForAgent: vi.fn(),
    mockIsRuleAgent: vi.fn(),
    mockInstallSkill: vi.fn(),
    mockSkillAgentIDsForProviders: vi.fn(),
    mockInGitWorkTree: vi.fn(),
    mockUpsertDosuAgentsSection: vi.fn(),
    mockRequireProjectRoot: vi.fn(),
    mockInstallProjectInstructions: vi.fn(),
    mockResolveProjectProof: vi.fn(),
    mockRunProjectScopeMigration: vi.fn(),
  };
});

vi.mock("../auth/ticket", () => ({
  mintTicket: mockMintTicket,
  exchangeTicket: mockExchangeTicket,
}));

vi.mock("../mcp/project-credential-store", () => ({
  saveProjectMcpCredential: vi.fn(),
  readProjectMcpCredential: vi.fn(),
}));

const { mockPreflightProjectProxy } = vi.hoisted(() => ({
  mockPreflightProjectProxy: vi.fn(),
}));
vi.mock("../mcp/project-proxy-preflight", () => ({
  preflightProjectProxy: (...args: unknown[]) => mockPreflightProjectProxy(...args),
}));

vi.mock("../migration", () => ({
  resolveProjectProof: (...args: unknown[]) => mockResolveProjectProof(...args),
}));

const { mockResolveProjectPinnedTarget } = vi.hoisted(() => ({
  mockResolveProjectPinnedTarget: vi.fn(),
}));
vi.mock("../setup/project-target", () => ({
  resolveProjectPinnedTarget: (...args: unknown[]) => mockResolveProjectPinnedTarget(...args),
}));

vi.mock("../config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config")>()),
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}));

vi.mock("../mcp/providers", () => ({
  allSetupProviders: mockAllSetupProviders,
}));

vi.mock("../rules/installer", () => ({
  fetchDosuRule: mockFetchDosuRule,
  installRuleForAgent: mockInstallRuleForAgent,
  isRuleAgent: mockIsRuleAgent,
}));

vi.mock("../commands/skill", () => ({
  installSkill: mockInstallSkill,
  skillAgentIDsForProviders: mockSkillAgentIDsForProviders,
}));

vi.mock("../setup/agents-md-step", () => ({
  inGitWorkTree: mockInGitWorkTree,
  upsertDosuAgentsSection: mockUpsertDosuAgentsSection,
}));

vi.mock("../setup/project-root", () => ({
  requireProjectRoot: mockRequireProjectRoot,
}));

vi.mock("../setup/project-scope-migration", () => ({
  runProjectScopeMigration: (...args: unknown[]) => mockRunProjectScopeMigration(...args),
}));

vi.mock("../setup/project-instructions", () => ({
  installProjectInstructions: mockInstallProjectInstructions,
  providerUsesProjectInstructions: (providerID: string) => providerID !== "mcporter",
}));

vi.mock("../client/client", () => ({
  Client: vi.fn().mockImplementation(function (cfg: unknown) {
    mockClientConstructor(cfg);
    return mockClient;
  }),
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test.log"),
  },
}));

import { buildResumeCommand, listAgentSupportedToolIDs, runAgentSetup } from "./flow";

function makeProvider(id: string, opts: Partial<SetupProvider> = {}): SetupProvider {
  return {
    id: () => id,
    name: () => opts.name?.() ?? `Tool ${id}`,
    supportsLocal: () => true,
    install: vi.fn(),
    remove: vi.fn(),
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => false,
    globalConfigPath: () => `/tmp/${id}/mcp.json`,
    projectConfigPath: (root) => `${root}/.${id}/mcp.json`,
    isProjectConfigured: () => false,
    priority: () => 0,
    ...opts,
  };
}

const baseCfg: FlatTestConfig = {
  access_token: "",
  refresh_token: "",
  expires_at: 0,
};
const makeBaseConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...baseCfg, ...overrides });
const ticketAccessToken = testAccessTokenFor("ticket-user");

describe("buildResumeCommand", () => {
  it("includes --tool and --login-ticket and uses the npx invocation", () => {
    const cmd = buildResumeCommand("claude", "tkt-1");
    expect(cmd).toBe("npx @dosu/cli@latest setup --agent --tool claude --login-ticket tkt-1");
  });

  it("appends --deployment when provided", () => {
    const cmd = buildResumeCommand("cursor", "tkt-2", "dep-9");
    expect(cmd).toBe(
      "npx @dosu/cli@latest setup --agent --tool cursor --login-ticket tkt-2 --deployment dep-9",
    );
  });

  it("preserves an explicit mode in the resume command", () => {
    const cmd = buildResumeCommand("codex", "tkt-3", undefined, "oss");
    expect(cmd).toBe(
      "npx @dosu/cli@latest setup --agent --tool codex --login-ticket tkt-3 --mode oss",
    );
  });
});

describe("listAgentSupportedToolIDs", () => {
  it("lists only providers with an official project MCP scope", () => {
    mockAllSetupProviders.mockReturnValue([
      makeProvider("claude"),
      makeProvider("claude-desktop", { supportsLocal: () => false }),
      makeProvider("cursor"),
    ]);

    expect(listAgentSupportedToolIDs()).toEqual(["claude", "cursor"]);
  });
});

describe("runAgentSetup", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let claudeProvider: SetupProvider;
  let desktopProvider: SetupProvider;

  function emittedEvents(): Array<Record<string, unknown>> {
    return logSpy.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMintTicket.mockReset();
    mockExchangeTicket.mockReset();
    mockLoadConfig.mockReset();
    mockSaveConfig.mockReset();
    mockAllSetupProviders.mockReset();
    mockClientConstructor.mockReset();
    mockFetchDosuRule.mockReset();
    mockInstallRuleForAgent.mockReset();
    mockIsRuleAgent.mockReset();
    mockInstallSkill.mockReset();
    mockSkillAgentIDsForProviders.mockReset();
    mockInGitWorkTree.mockReset();
    mockUpsertDosuAgentsSection.mockReset();
    mockRequireProjectRoot.mockReset();
    mockInstallProjectInstructions.mockReset();
    mockResolveProjectProof.mockReset();
    mockRunProjectScopeMigration.mockReset();
    mockPreflightProjectProxy.mockReset();
    mockResolveProjectPinnedTarget.mockReset();
    for (const fn of Object.values(mockClient)) fn.mockReset();

    claudeProvider = makeProvider("claude", { name: () => "Claude Code" });
    desktopProvider = makeProvider("claude-desktop", {
      name: () => "Claude Desktop",
      supportsLocal: () => false,
    });

    mockAllSetupProviders.mockReturnValue([claudeProvider, desktopProvider]);
    mockLoadConfig.mockReturnValue(makeBaseConfig());
    mockFetchDosuRule.mockResolvedValue("canonical rule\n");
    mockIsRuleAgent.mockImplementation((agent: string) => agent === "claude");
    mockInstallRuleForAgent.mockImplementation((agent: string) => ({
      agent,
      action: "created",
      path: `/tmp/${agent}/rules/dosu.md`,
    }));
    mockSkillAgentIDsForProviders.mockImplementation((agents: string[]) =>
      agents.includes("claude") ? ["claude-code"] : [],
    );
    mockInstallSkill.mockResolvedValue({ success: true, sha: "skill-sha" });
    mockInGitWorkTree.mockReturnValue(false);
    mockUpsertDosuAgentsSection.mockReturnValue({
      action: "created",
      path: "/tmp/repo/AGENTS.md",
    });
    mockRequireProjectRoot.mockReturnValue("/tmp/repo");
    mockInstallProjectInstructions.mockReturnValue({
      agentsMd: { action: "created", path: "/tmp/repo/AGENTS.md" },
      adapters: [{ provider: "claude", action: "created", path: "/tmp/repo/CLAUDE.md" }],
    });
    mockResolveProjectProof.mockReturnValue({
      ok: true,
      proof: { root: "/tmp/repo", cwd: "/tmp/repo" },
    });
    mockRunProjectScopeMigration.mockReturnValue({
      ok: true,
      cleanupAttempted: true,
      runtimeVerified: true,
      receiptRoot: "/tmp/dosu-migration-receipts",
      counts: { removed: 0, not_found: 3, preserved: 0, failed: 0, total: 3 },
      warnings: [],
    });
    mockPreflightProjectProxy.mockResolvedValue({ ok: true, reason: "initialize_ok" });
    mockResolveProjectPinnedTarget.mockReturnValue({ ok: true, providers: [] });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits unknown_tool error and exits 2 when tool id is invalid", async () => {
    const code = await runAgentSetup({ tool: "nope" });

    expect(code).toBe(2);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "setup",
        status: "error",
        reason: "unknown_tool",
        agent_next_steps: expect.stringContaining("'nope' is not"),
      }),
    ]);
  });

  it("mints a ticket and emits need_user_action when not authenticated", async () => {
    mockMintTicket.mockResolvedValue({
      ticket: "tkt-1",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-1",
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    const events = emittedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      step: "auth",
      status: "need_user_action",
      ticket: "tkt-1",
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-1",
      resume_command: "npx @dosu/cli@latest setup --agent --tool claude --login-ticket tkt-1",
    });
  });

  it("redeems the ticket, picks the lone deployment, mints an API key, installs MCP", async () => {
    mockInGitWorkTree.mockReturnValue(true);
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
      email: "user@example.com",
    });
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-1",
        name: "acme/main",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({
      api_key: "sk_user_x",
      id: "k1",
      name: "dosu-cli",
      key_prefix: "sk_user_x",
    });

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt-good" });

    expect(code).toBe(0);
    const events = emittedEvents();
    expect(events.map((e) => e.step)).toEqual([
      "auth",
      "deployment",
      "api_key",
      "mcp_install",
      "rule_install",
      "skill_install",
      "legacy_migration",
      "done",
    ]);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalled();
    const lastSave = mockSaveConfig.mock.calls.at(-1)?.[0];
    expect(testSession(lastSave).access_token).toBe(ticketAccessToken);
    expect(testTarget(lastSave).api_key).toBe("sk_user_x");
    expect(testTarget(lastSave).deployment_id).toBe("dep-1");
    expect(events.at(-1)).toMatchObject({
      step: "done",
      status: "ok",
      agent_next_steps: expect.stringMatching(/Claude Code.*dosu status --json/),
    });
    expect(events.at(-2)).toMatchObject({
      step: "legacy_migration",
      status: "ok",
      receipt_root: "/tmp/dosu-migration-receipts",
      counts: { removed: 0, not_found: 3, preserved: 0, failed: 0, total: 3 },
    });
    expect(JSON.stringify(events)).not.toContain("sk_user_x");
    expect(mockInstallProjectInstructions).toHaveBeenCalledWith({
      projectRoot: "/tmp/repo",
      providerIDs: ["claude"],
      content: "canonical rule\n",
    });
    expect(mockInstallSkill).toHaveBeenCalledWith(["claude"], {
      quiet: true,
      projectRoot: "/tmp/repo",
    });
    expect(mockResolveProjectProof).toHaveBeenCalledWith("/tmp/repo");
    expect(mockRunProjectScopeMigration).toHaveBeenCalledWith({
      project: { root: "/tmp/repo", cwd: "/tmp/repo" },
      providerIDs: ["claude"],
      proxy: { packageVersion: VERSION, deploymentID: "dep-1" },
      instructionContent: "canonical rule\n",
      runtimeVerified: true,
    });
    const preflightOrder = mockPreflightProjectProxy.mock.invocationCallOrder[0];
    const mcpOrder = (claudeProvider.install as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const instructionOrder = mockInstallProjectInstructions.mock.invocationCallOrder[0];
    const skillOrder = mockInstallSkill.mock.invocationCallOrder[0];
    const migrationOrder = mockRunProjectScopeMigration.mock.invocationCallOrder[0];
    expect(preflightOrder).toBeLessThan(mcpOrder);
    expect(mcpOrder).toBeLessThan(instructionOrder);
    expect(instructionOrder).toBeLessThan(skillOrder);
    expect(skillOrder).toBeLessThan(migrationOrder);
  });

  it("errors with multiple_deployments when the user has more than one dosu_mcp", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-1",
        name: "acme/main",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
      {
        deployment_id: "dep-2",
        name: "acme/staging",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-2",
      },
    ]);

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "multiple_deployments",
      candidates: [
        { deployment_id: "dep-1", name: "acme/main", org_id: "org-1", org_name: "acme" },
        { deployment_id: "dep-2", name: "acme/staging", org_id: "org-1", org_name: "acme" },
      ],
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("auto-picks the lone dosu_mcp when other non-MCP deployments coexist", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
      email: "user@example.com",
    });
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-chat",
        name: "In-App Chat",
        description: "",
        provider_slug: "dosu_app",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
      {
        deployment_id: "dep-mcp",
        name: "acme/main",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-2",
      },
      {
        deployment_id: "dep-kb",
        name: "Knowledge Base",
        description: "",
        provider_slug: "dosu_knowledge_store",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-3",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({
      api_key: "sk_user_z",
      id: "k3",
      name: "dosu-cli",
      key_prefix: "sk_user_z",
    });

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt-good" });

    expect(code).toBe(0);
    const events = emittedEvents();
    const depEvent = events.find((e) => e.step === "deployment");
    expect(depEvent).toMatchObject({
      step: "deployment",
      status: "ok",
      deployment_id: "dep-mcp",
      name: "acme/main",
    });
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
  });

  it("errors with no_mcp_deployment when account has deployments but none are MCP", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-chat",
        name: "In-App Chat",
        description: "",
        provider_slug: "dosu_app",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
      {
        deployment_id: "dep-gh",
        name: "acme/repo",
        description: "",
        provider_slug: "github",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-2",
      },
    ]);

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "no_mcp_deployment",
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("emits expired status when the ticket is no longer valid", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "expired" });

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "auth",
        status: "error",
        reason: "ticket_expired",
      }),
    ]);
  });

  it("emits pending when ticket exists but user has not signed in yet", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "pending" });

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(0);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "auth",
        status: "pending",
      }),
    ]);
  });

  it("uses --deployment when supplied", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-A",
        name: "acme/main",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
      {
        deployment_id: "dep-B",
        name: "acme/staging",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-2",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({
      api_key: "sk_user_y",
      id: "k2",
      name: "dosu-cli",
      key_prefix: "sk_user_y",
    });

    const code = await runAgentSetup({ tool: "claude", deploymentID: "dep-B" });

    expect(code).toBe(0);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, desktopProvider],
      "/tmp/repo",
      { mode: "cloud", deploymentID: "dep-B" },
      ["claude"],
    );
    const events = emittedEvents();
    const depEvent = events.find((e) => e.step === "deployment");
    expect(depEvent).toMatchObject({
      step: "deployment",
      status: "ok",
      deployment_id: "dep-B",
      name: "acme/staging",
    });
  });

  it("errors when --deployment refers to an inaccessible deployment", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockResolvedValue([]);

    const code = await runAgentSetup({
      tool: "claude",
      loginTicket: "tkt",
      deploymentID: "dep-X",
    });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "not_found",
      agent_next_steps:
        "The requested MCP is not accessible to the current Dosu account. " +
        "Make sure the user is logged in to the correct account. " +
        "Run 'dosu logout', then retry setup.",
    });
  });

  it("emits fetch_failed when loading deployments throws while resolving --deployment", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockRejectedValue(new Error("api down"));

    const code = await runAgentSetup({
      tool: "claude",
      loginTicket: "tkt",
      deploymentID: "dep-X",
    });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "fetch_failed",
      agent_next_steps: expect.stringContaining("api down"),
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("emits fetch_failed when auto-resolving deployments throws", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockRejectedValue("boom");

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "fetch_failed",
      agent_next_steps: expect.stringContaining("boom"),
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("emits no_deployments when the account has no deployments at all", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
      refresh_token: "ref",
      expires_in: 3600,
    });
    mockClient.getDeployments.mockResolvedValue([]);

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "deployment",
      status: "error",
      reason: "no_deployments",
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("reuses a deployment already locked in from a previous run", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({
      api_key: "sk_user_locked",
      id: "k9",
      name: "dosu-cli",
      key_prefix: "sk_user_locked",
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    const events = emittedEvents();
    const depEvent = events.find((e) => e.step === "deployment");
    expect(depEvent).toMatchObject({
      step: "deployment",
      status: "ok",
      deployment_id: "dep-locked",
      name: "acme/locked",
    });
    // Deployment was reused, not re-fetched.
    expect(mockClient.getDeployments).not.toHaveBeenCalled();
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
  });

  it("prefers the exact project-pinned deployment over another globally active target", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-global-b",
        deployment_name: "acme/global-b",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-project-a",
        name: "acme/project-a",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({ api_key: "key-a" });
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: true,
      providers: ["claude"],
      target: { deploymentID: "dep-project-a" },
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    expect(emittedEvents().find((event) => event.step === "deployment")).toMatchObject({
      deployment_id: "dep-project-a",
    });
    expect(claudeProvider.install).toHaveBeenCalledWith(
      expect.objectContaining({
        active_account: expect.objectContaining({
          target: expect.objectContaining({ deployment_id: "dep-project-a" }),
        }),
      }),
      false,
      { projectRoot: "/tmp/repo", allowProjectRetarget: false },
    );
    expect(mockRunProjectScopeMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        providerIDs: ["claude"],
        proxy: { packageVersion: VERSION, deploymentID: "dep-project-a" },
        runtimeVerified: true,
      }),
    );
  });

  it("fails closed on conflicting pins from any project-supported provider", async () => {
    const undetectedCodex = makeProvider("codex", { isInstalled: () => false });
    mockAllSetupProviders.mockReturnValue([claudeProvider, undetectedCodex, desktopProvider]);
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-global",
        deployment_name: "acme/global",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: false,
      reason: "conflicting_project_targets",
      providers: ["claude", "codex"],
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, undetectedCodex, desktopProvider],
      "/tmp/repo",
    );
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "project_target",
      status: "error",
      reason: "conflicting_project_targets",
      providers: ["claude", "codex"],
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
    expect(mockPreflightProjectProxy).not.toHaveBeenCalled();
  });

  it("fails on an ambiguous project entry before ticket redemption or session verification", async () => {
    mockLoadConfig.mockReturnValue(makeBaseConfig());
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: false,
      reason: "ambiguous_project_config",
      providers: ["claude"],
      paths: ["/tmp/repo/.mcp.json"],
    });

    const code = await runAgentSetup({
      tool: "claude",
      loginTicket: "ticket-must-not-be-redeemed",
    });

    expect(code).toBe(1);
    expect(mockExchangeTicket).not.toHaveBeenCalled();
    expect(mockClient.doRequestRaw).not.toHaveBeenCalled();
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "project_target",
      status: "error",
      reason: "ambiguous_project_config",
      providers: ["claude"],
      paths: ["/tmp/repo/.mcp.json"],
    });
  });

  it("rejects an explicit OSS split-brain in an undetected client before authentication", async () => {
    const undetectedCodex = makeProvider("codex", { isInstalled: () => false });
    mockAllSetupProviders.mockReturnValue([claudeProvider, undetectedCodex, desktopProvider]);
    mockLoadConfig.mockReturnValue(makeBaseConfig());
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: false,
      reason: "requested_project_target_conflict",
      providers: ["codex"],
      paths: ["/tmp/repo/.codex/config.toml"],
    });

    const code = await runAgentSetup({ tool: "claude", mode: "oss" });

    expect(code).toBe(1);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, undetectedCodex, desktopProvider],
      "/tmp/repo",
      { mode: "oss" },
      ["claude"],
    );
    expect(mockMintTicket).not.toHaveBeenCalled();
    expect(mockClient.doRequestRaw).not.toHaveBeenCalled();
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("passes the exact OSS project proxy expectation to legacy migration", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-global",
        deployment_name: "acme/global",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: true,
      providers: ["claude"],
      target: { oss: true },
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    expect(claudeProvider.install).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "oss" }),
      false,
      { projectRoot: "/tmp/repo", allowProjectRetarget: false },
    );
    expect(mockRunProjectScopeMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { packageVersion: VERSION, oss: true },
        runtimeVerified: true,
      }),
    );
  });

  it("honors an explicit OSS mode and authorizes that project retarget", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-cloud",
        deployment_name: "acme/cloud",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);

    const code = await runAgentSetup({ tool: "claude", mode: "oss" });

    expect(code).toBe(0);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, desktopProvider],
      "/tmp/repo",
      { mode: "oss" },
      ["claude"],
    );
    expect(claudeProvider.install).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "oss" }),
      false,
      { projectRoot: "/tmp/repo", allowProjectRetarget: true },
    );
    expect(mockRunProjectScopeMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { packageVersion: VERSION, oss: true },
        runtimeVerified: true,
      }),
    );
  });

  it("honors an explicit cloud mode when the saved mode is OSS", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-cloud",
        deployment_name: "acme/cloud",
        api_key: "sk_existing",
        mode: "oss",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);

    const code = await runAgentSetup({ tool: "claude", mode: "cloud" });

    expect(code).toBe(0);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, desktopProvider],
      "/tmp/repo",
      { mode: "cloud", deploymentID: "dep-cloud" },
      ["claude"],
    );
    expect(claudeProvider.install).toHaveBeenCalledWith(
      expect.not.objectContaining({ mode: "oss" }),
      false,
      { projectRoot: "/tmp/repo", allowProjectRetarget: true },
    );
    expect(mockRunProjectScopeMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: { packageVersion: VERSION, deploymentID: "dep-cloud" },
        runtimeVerified: true,
      }),
    );
  });

  it("uses the Cloud picker instead of recovering a selected client's old OSS pin", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        api_key: "sk_existing",
        mode: "oss",
      }),
    );
    mockResolveProjectPinnedTarget.mockReturnValue({
      ok: true,
      providers: ["claude"],
    });
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-cloud-picked",
        name: "acme/cloud-picked",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(true);

    const code = await runAgentSetup({ tool: "claude", mode: "cloud" });

    expect(code).toBe(0);
    expect(mockResolveProjectPinnedTarget).toHaveBeenCalledWith(
      [claudeProvider, desktopProvider],
      "/tmp/repo",
      { mode: "cloud", deploymentID: undefined },
      ["claude"],
    );
    expect(mockClient.getDeployments).toHaveBeenCalled();
    expect(claudeProvider.install).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: undefined,
        active_account: expect.objectContaining({
          target: expect.objectContaining({ deployment_id: "dep-cloud-picked" }),
        }),
      }),
      false,
      { projectRoot: "/tmp/repo", allowProjectRetarget: true },
    );
  });

  it("reuses a still-valid API key without minting a new one", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    const events = emittedEvents();
    const keyEvent = events.find((e) => e.step === "api_key");
    expect(keyEvent).toMatchObject({ step: "api_key", reused: true });
    expect(mockClient.createAPIKey).not.toHaveBeenCalled();
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
  });

  it("emits create_failed when minting the API key throws", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockRejectedValue(new Error("key service down"));

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "api_key",
      status: "error",
      reason: "create_failed",
      agent_next_steps: expect.stringContaining("key service down"),
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("fails before project writes when the exact proxy cannot initialize", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockPreflightProjectProxy.mockResolvedValue({ ok: false, reason: "timeout" });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "mcp_preflight",
      status: "error",
      reason: "timeout",
      agent_next_steps: expect.stringContaining("no project files"),
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
    expect(mockInstallProjectInstructions).not.toHaveBeenCalled();
    expect(mockInstallSkill).not.toHaveBeenCalled();
  });

  it("emits install_failed when the provider install throws", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    (claudeProvider.install as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("disk full");
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "mcp_install",
      status: "error",
      reason: "install_failed",
      agent_next_steps: expect.stringContaining("disk full"),
    });
    expect(mockInstallRuleForAgent).not.toHaveBeenCalled();
    expect(mockInstallSkill).not.toHaveBeenCalled();
  });

  it("reports a rule failure after preserving the installed MCP configuration", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockInstallProjectInstructions.mockImplementation(() => {
      throw new Error("rule directory is read-only");
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "rule_install",
      status: "error",
      reason: "install_failed",
      agent_next_steps: expect.stringContaining("idempotent"),
    });
    expect(mockInstallSkill).not.toHaveBeenCalled();
  });

  it("reports a skill failure after preserving the MCP and rule installation", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockInstallSkill.mockResolvedValue({ success: false });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(mockInstallProjectInstructions).toHaveBeenCalledTimes(1);
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "skill_install",
      status: "error",
      reason: "install_failed",
      agent_next_steps: expect.stringContaining("idempotent"),
    });
    expect(mockRunProjectScopeMigration).not.toHaveBeenCalled();
  });

  it("fails closed and reports receipt counts when safe legacy migration cannot finish", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockRunProjectScopeMigration.mockReturnValue({
      ok: false,
      cleanupAttempted: true,
      runtimeVerified: true,
      reason: "migration_failed",
      receiptRoot: "/tmp/dosu-migration-receipts/run-1",
      counts: { removed: 1, not_found: 2, preserved: 1, failed: 1, total: 5 },
      warnings: ["ambiguous legacy entry preserved"],
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(mockInstallProjectInstructions).toHaveBeenCalledTimes(1);
    expect(mockInstallSkill).toHaveBeenCalledTimes(1);
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "legacy_migration",
      status: "error",
      reason: "migration_failed",
      receipt_root: "/tmp/dosu-migration-receipts/run-1",
      counts: { removed: 1, not_found: 2, preserved: 1, failed: 1, total: 5 },
      agent_next_steps: expect.stringContaining("1 proven global item(s) were already backed up"),
    });
    expect(emittedEvents().some((event) => event.step === "done")).toBe(false);
    expect(JSON.stringify(emittedEvents())).not.toContain("sk_existing");
  });

  it("preserves globals when the project cannot be re-proven after bundle installation", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockResolveProjectProof.mockReturnValue({ ok: false, reason: "git_probe_failed" });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(mockRunProjectScopeMigration).not.toHaveBeenCalled();
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "legacy_migration",
      status: "error",
      reason: "project_reverification_failed",
      project_reason: "git_probe_failed",
      receipt_root: null,
      counts: { removed: 0, not_found: 0, preserved: 0, failed: 0, total: 0 },
    });
    expect(emittedEvents().some((event) => event.step === "done")).toBe(false);
  });

  it("reports a project instruction failure before attempting the skill", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: ticketAccessToken,
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 200 }));
    mockClient.validateAPIKey.mockResolvedValue(true);
    mockInstallProjectInstructions.mockImplementation(() => {
      throw new Error("AGENTS.md is read-only");
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(mockInstallProjectInstructions).toHaveBeenCalledTimes(1);
    expect(mockInstallSkill).not.toHaveBeenCalled();
    expect(emittedEvents().at(-1)).toMatchObject({
      step: "rule_install",
      status: "error",
      reason: "install_failed",
      agent_next_steps: expect.stringContaining("idempotent"),
    });
  });

  it("redeems a ticket whose response omits optional session fields", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: ticketAccessToken,
    });
    mockClient.getDeployments.mockResolvedValue([
      {
        deployment_id: "dep-1",
        name: "acme/main",
        description: "",
        provider_slug: "dosu_mcp",
        enabled: true,
        org_id: "org-1",
        org_name: "acme",
        space_id: "space-1",
      },
    ]);
    mockClient.validateAPIKey.mockResolvedValue(false);
    mockClient.createAPIKey.mockResolvedValue({
      api_key: "sk_user_x",
      id: "k1",
      name: "dosu-cli",
      key_prefix: "sk_user_x",
    });

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt-good" });

    expect(code).toBe(0);
    const authSave = mockSaveConfig.mock.calls[0]?.[0];
    expect(testSession(authSave).access_token).toBe(ticketAccessToken);
    expect(testSession(authSave).refresh_token).toBe("");
    expect(testSession(authSave).expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
  });

  it("emits ticket_exchange_failed when redeeming a ticket throws", async () => {
    mockExchangeTicket.mockRejectedValue(new Error("exchange boom"));

    const code = await runAgentSetup({ tool: "claude", loginTicket: "tkt" });

    expect(code).toBe(1);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "auth",
        status: "error",
        reason: "ticket_exchange_failed",
        agent_next_steps: expect.stringContaining("exchange boom"),
      }),
    ]);
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and continues when the raw probe is unauthorized", async () => {
    mockLoadConfig
      .mockReturnValueOnce(
        makeBaseConfig({
          access_token: "stale",
          refresh_token: "ref",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )
      .mockReturnValue(
        makeBaseConfig({
          access_token: "fresh",
          refresh_token: "ref2",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          deployment_id: "dep-locked",
          deployment_name: "acme/locked",
          api_key: "sk_existing",
        }),
      );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 401 }));
    mockClient.refreshToken.mockResolvedValue(undefined);
    mockClient.validateAPIKey.mockResolvedValue(true);

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    expect(mockClient.refreshToken).toHaveBeenCalledTimes(1);
    const events = emittedEvents();
    expect(events.map((e) => e.step)).toContain("auth");
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
  });

  it("mints a ticket when the existing session is unauthorized and refresh fails", async () => {
    mockLoadConfig.mockReturnValue(
      makeBaseConfig({
        access_token: "stale",
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    mockClient.doRequestRaw.mockResolvedValue(new Response(null, { status: 401 }));
    mockClient.refreshToken.mockRejectedValue(new Error("refresh failed"));
    mockMintTicket.mockResolvedValue({
      ticket: "tkt-fresh",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-fresh",
    });

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(0);
    const events = emittedEvents();
    expect(events.at(-1)).toMatchObject({
      step: "auth",
      status: "need_user_action",
      ticket: "tkt-fresh",
    });
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });

  it("emits ticket_mint_failed when minting a fresh ticket throws", async () => {
    mockMintTicket.mockRejectedValue(new Error("mint boom"));

    const code = await runAgentSetup({ tool: "claude" });

    expect(code).toBe(1);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "auth",
        status: "error",
        reason: "ticket_mint_failed",
        agent_next_steps: expect.stringContaining("mint boom"),
      }),
    ]);
    expect(claudeProvider.install).not.toHaveBeenCalled();
  });
});
