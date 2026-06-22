import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupProvider } from "../mcp/providers";

const {
  mockMintTicket,
  mockExchangeTicket,
  mockLoadConfig,
  mockSaveConfig,
  mockAllSetupProviders,
  mockIsStdioOnly,
  mockClient,
  mockClientConstructor,
} = vi.hoisted(() => {
  return {
    mockMintTicket: vi.fn(),
    mockExchangeTicket: vi.fn(),
    mockLoadConfig: vi.fn(),
    mockSaveConfig: vi.fn(),
    mockAllSetupProviders: vi.fn(),
    mockIsStdioOnly: vi.fn(),
    mockClient: {
      doRequestRaw: vi.fn(),
      refreshToken: vi.fn(),
      getDeployments: vi.fn(),
      validateAPIKey: vi.fn(),
      createAPIKey: vi.fn(),
    },
    mockClientConstructor: vi.fn(),
  };
});

vi.mock("../auth/ticket", () => ({
  mintTicket: mockMintTicket,
  exchangeTicket: mockExchangeTicket,
}));

vi.mock("../config/config", () => ({
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}));

vi.mock("../mcp/providers", () => ({
  allSetupProviders: mockAllSetupProviders,
}));

vi.mock("../setup/flow", () => ({
  isStdioOnly: mockIsStdioOnly,
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
    priority: () => 0,
    ...opts,
  };
}

const baseCfg = {
  access_token: "",
  refresh_token: "",
  expires_at: 0,
};

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
});

describe("listAgentSupportedToolIDs", () => {
  it("excludes stdio-only providers", () => {
    mockAllSetupProviders.mockReturnValue([
      makeProvider("claude"),
      makeProvider("claude-desktop"),
      makeProvider("cursor"),
    ]);
    mockIsStdioOnly.mockImplementation((p: SetupProvider) => p.id() === "claude-desktop");

    expect(listAgentSupportedToolIDs()).toEqual(["claude", "cursor"]);
  });
});

describe("runAgentSetup", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let claudeProvider: SetupProvider;
  let stdioProvider: SetupProvider;

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
    mockIsStdioOnly.mockReset();
    mockClientConstructor.mockReset();
    for (const fn of Object.values(mockClient)) fn.mockReset();

    claudeProvider = makeProvider("claude", { name: () => "Claude Code" });
    stdioProvider = makeProvider("claude-desktop", { name: () => "Claude Desktop" });

    mockAllSetupProviders.mockReturnValue([claudeProvider, stdioProvider]);
    mockIsStdioOnly.mockImplementation((p: SetupProvider) => p.id() === "claude-desktop");
    mockLoadConfig.mockReturnValue({ ...baseCfg });
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

  it("emits tool_unsupported error when the chosen tool is stdio-only", async () => {
    const code = await runAgentSetup({ tool: "claude-desktop" });

    expect(code).toBe(2);
    expect(emittedEvents()).toEqual([
      expect.objectContaining({
        step: "setup",
        status: "error",
        reason: "tool_unsupported_in_agent_mode",
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
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
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
      "done",
    ]);
    expect(claudeProvider.install).toHaveBeenCalledTimes(1);
    expect(mockSaveConfig).toHaveBeenCalled();
    const lastSave = mockSaveConfig.mock.calls.at(-1)?.[0] as {
      access_token: string;
      api_key?: string;
      deployment_id?: string;
    };
    expect(lastSave.access_token).toBe("tok");
    expect(lastSave.api_key).toBe("sk_user_x");
    expect(lastSave.deployment_id).toBe("dep-1");
    expect(events.at(-1)).toMatchObject({
      step: "done",
      status: "ok",
      agent_next_steps: expect.stringContaining("Claude Code"),
    });
  });

  it("errors with multiple_deployments when the user has more than one dosu_mcp", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
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
      access_token: "tok",
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
      access_token: "tok",
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
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
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
      access_token: "tok",
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
    });
  });

  it("emits fetch_failed when loading deployments throws while resolving --deployment", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
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
      access_token: "tok",
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
      access_token: "tok",
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
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      deployment_id: "dep-locked",
      deployment_name: "acme/locked",
    });
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

  it("reuses a still-valid API key without minting a new one", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      deployment_id: "dep-locked",
      deployment_name: "acme/locked",
      api_key: "sk_existing",
    });
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
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      deployment_id: "dep-locked",
      deployment_name: "acme/locked",
    });
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

  it("emits install_failed when the provider install throws", async () => {
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "tok",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      deployment_id: "dep-locked",
      deployment_name: "acme/locked",
      api_key: "sk_existing",
    });
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
  });

  it("redeems a ticket whose response omits tokens, falling back to defaults", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "authenticated" });
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
    const authSave = mockSaveConfig.mock.calls[0]?.[0] as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(authSave.access_token).toBe("");
    expect(authSave.refresh_token).toBe("");
    expect(authSave.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
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
      .mockReturnValueOnce({
        ...baseCfg,
        access_token: "stale",
        refresh_token: "ref",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
      .mockReturnValue({
        ...baseCfg,
        access_token: "fresh",
        refresh_token: "ref2",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-locked",
        deployment_name: "acme/locked",
        api_key: "sk_existing",
      });
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
    mockLoadConfig.mockReturnValue({
      ...baseCfg,
      access_token: "stale",
      refresh_token: "ref",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
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
