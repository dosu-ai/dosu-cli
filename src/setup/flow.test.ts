import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
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

vi.mock("../config/config", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
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

vi.mock("../mcp/providers", () => ({
  allSetupProviders: vi.fn(),
}));

vi.mock("../auth/flow", () => ({
  startOAuthFlow: vi.fn(),
}));

vi.mock("./styles", () => ({
  info: (s: string) => s,
  dim: (s: string) => s,
}));

import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "../config/config";
import { Client, SessionExpiredError } from "../client/client";
import { allSetupProviders } from "../mcp/providers";
import { startOAuthFlow } from "../auth/flow";
import { runSetup } from "./flow";

const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockClient = vi.mocked(Client);
const mockAllSetupProviders = vi.mocked(allSetupProviders);
const mockStartOAuthFlow = vi.mocked(startOAuthFlow);
const mockConfirm = vi.mocked(p.confirm);
const mockSelect = vi.mocked(p.select);
const mockMultiselect = vi.mocked(p.multiselect);
const mockIsCancel = vi.mocked(p.isCancel);

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
    deployment_id: undefined as string | undefined,
    deployment_name: undefined as string | undefined,
    api_key: undefined as string | undefined,
    ...overrides,
  };
}

function makeProvider(id: string, name: string, opts: {
  isInstalled?: boolean;
  isConfigured?: boolean;
  isStdio?: boolean;
  installError?: Error;
  removeError?: Error;
} = {}) {
  return {
    id: () => id,
    name: () => name,
    detectPaths: () => ["/mock/path"],
    isInstalled: () => opts.isInstalled ?? true,
    isConfigured: () => opts.isConfigured ?? false,
    globalConfigPath: () => `/mock/${id}/config.json`,
    priority: () => 1,
    supportsLocal: () => true,
    install: opts.installError
      ? vi.fn().mockImplementation(() => { throw opts.installError; })
      : vi.fn(),
    remove: opts.removeError
      ? vi.fn().mockImplementation(() => { throw opts.removeError; })
      : vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCancel.mockReturnValue(false);
});

describe("runSetup", () => {
  // ---- stepAuthenticate tests ----

  describe("stepAuthenticate", () => {
    it("uses existing valid token without prompting login", async () => {
      const cfg = makeCfg({ access_token: "valid-tok", refresh_token: "ref" });
      mockLoadConfig.mockReturnValue(cfg);

      const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 200 });
      const mockGetOrgs = vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]);
      const mockGetDeployments = vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      ]);
      const mockValidateAPIKey = vi.fn().mockResolvedValue(true);

      mockClient.mockImplementation(() => ({
        doRequestRaw: mockDoRequestRaw,
        getOrgs: mockGetOrgs,
        getDeployments: mockGetDeployments,
        validateAPIKey: mockValidateAPIKey,
        refreshToken: vi.fn(),
      }) as any);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      // Should not have prompted for login
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      // Should have verified the session
      expect(mockDoRequestRaw).toHaveBeenCalledWith("GET", "/v1/mcp/deployments");
    });

    it("prompts for OAuth when no token exists", async () => {
      const cfg = makeCfg();
      mockLoadConfig.mockReturnValue(cfg);

      // User confirms login
      mockConfirm.mockResolvedValue(true);

      mockStartOAuthFlow.mockResolvedValue({
        access_token: "new-tok",
        refresh_token: "new-ref",
        expires_in: 3600,
      } as any);

      const mockGetOrgs = vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]);
      const mockGetDeployments = vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      ]);
      const mockValidateAPIKey = vi.fn().mockResolvedValue(false);
      const mockCreateAPIKey = vi.fn().mockResolvedValue({ api_key: "new-key" });

      mockClient.mockImplementation(() => ({
        getOrgs: mockGetOrgs,
        getDeployments: mockGetDeployments,
        validateAPIKey: mockValidateAPIKey,
        createAPIKey: mockCreateAPIKey,
      }) as any);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(mockStartOAuthFlow).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalled();
      // Config should have the new token
      const savedCfg = mockSaveConfig.mock.calls[0][0];
      expect(savedCfg.access_token).toBe("new-tok");
      expect(savedCfg.refresh_token).toBe("new-ref");
    });

    it("returns early when user declines login", async () => {
      const cfg = makeCfg();
      mockLoadConfig.mockReturnValue(cfg);

      mockConfirm.mockResolvedValue(false);

      await runSetup();

      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(p.log.success).not.toHaveBeenCalled();
    });

    it("returns early when user cancels login confirm", async () => {
      const cfg = makeCfg();
      mockLoadConfig.mockReturnValue(cfg);

      const cancelSymbol = Symbol("cancel");
      mockConfirm.mockResolvedValue(cancelSymbol as any);
      mockIsCancel.mockImplementation((val) => val === cancelSymbol);

      await runSetup();

      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
    });

    it("shows error when OAuth fails", async () => {
      const cfg = makeCfg();
      mockLoadConfig.mockReturnValue(cfg);

      mockConfirm.mockResolvedValue(true);
      mockStartOAuthFlow.mockRejectedValue(new Error("OAuth timeout"));

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("OAuth timeout"),
      );
    });

    it("refreshes token when session returns 401", async () => {
      const cfg = makeCfg({ access_token: "expired-tok", refresh_token: "ref" });
      mockLoadConfig.mockReturnValue(cfg);

      const mockDoRequestRaw = vi.fn()
        .mockResolvedValueOnce({ status: 401 })   // first check fails
        .mockResolvedValueOnce({ status: 200 });   // after refresh succeeds
      const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
      const mockGetOrgs = vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]);
      const mockGetDeployments = vi.fn().mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      ]);
      const mockValidateAPIKey = vi.fn().mockResolvedValue(true);

      mockClient.mockImplementation(() => ({
        doRequestRaw: mockDoRequestRaw,
        refreshToken: mockRefreshToken,
        getOrgs: mockGetOrgs,
        getDeployments: mockGetDeployments,
        validateAPIKey: mockValidateAPIKey,
      }) as any);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(mockRefreshToken).toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled(); // No login prompt needed
    });
  });

  // ---- stepSelectOrg tests ----

  describe("stepSelectOrg", () => {
    function setupAuthenticated(cfg = makeCfg({ access_token: "tok" })) {
      mockLoadConfig.mockReturnValue(cfg);
      const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 200 });
      const clientMethods = {
        doRequestRaw: mockDoRequestRaw,
        refreshToken: vi.fn(),
        getOrgs: vi.fn(),
        getDeployments: vi.fn(),
        validateAPIKey: vi.fn(),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("auto-selects single org", async () => {
      const client = setupAuthenticated();
      client.getOrgs.mockResolvedValue([{ org_id: "o1", name: "MyOrg" }]);
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "MyOrg" },
      ]);
      client.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "existing-key";
      mockLoadConfig.mockReturnValue(cfg);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      // Should log success with org name (auto-selected)
      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("MyOrg"),
      );
      // Should NOT have shown org selection prompt
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("prompts selection with multiple orgs", async () => {
      const client = setupAuthenticated();
      client.getOrgs.mockResolvedValue([
        { org_id: "o1", name: "Org1" },
        { org_id: "o2", name: "Org2" },
      ]);
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
      ]);
      client.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "existing-key";
      mockLoadConfig.mockReturnValue(cfg);

      mockSelect.mockResolvedValueOnce("o1");
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(mockSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Select an organization",
        }),
      );
    });

    it("returns null on SessionExpiredError", async () => {
      const client = setupAuthenticated();
      client.getOrgs.mockRejectedValue(new SessionExpiredError());
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(p.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Session expired"),
      );
    });

    it("returns null when no orgs found", async () => {
      const client = setupAuthenticated();
      client.getOrgs.mockResolvedValue([]);

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        "No organizations found for your account",
      );
    });

    it("returns null when user cancels org selection", async () => {
      const client = setupAuthenticated();
      client.getOrgs.mockResolvedValue([
        { org_id: "o1", name: "Org1" },
        { org_id: "o2", name: "Org2" },
      ]);

      const cancelSymbol = Symbol("cancel");
      mockSelect.mockResolvedValueOnce(cancelSymbol as any);
      mockIsCancel.mockImplementation((val) => val === cancelSymbol);

      await runSetup();

      // Should have returned early -- no deployment selection
      expect(p.log.error).not.toHaveBeenCalled();
    });
  });

  // ---- stepResolveDeployment tests ----

  describe("stepResolveDeployment (via deploymentID option)", () => {
    function setupAuthenticated() {
      const cfg = makeCfg({ access_token: "tok" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn(),
        getDeployments: vi.fn(),
        validateAPIKey: vi.fn(),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("resolves deployment by ID when found", async () => {
      const client = setupAuthenticated();
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "Deploy2", org_id: "o1", org_name: "Org1" },
      ]);
      client.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "existing-key";
      mockLoadConfig.mockReturnValue(cfg);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup({ deploymentID: "d2" });

      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("Deploy2"),
      );
      // Verify config was saved with deployment info
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          deployment_id: "d2",
          deployment_name: "Deploy2",
        }),
      );
    });

    it("shows error when deployment ID not found", async () => {
      const client = setupAuthenticated();
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
      ]);

      await runSetup({ deploymentID: "nonexistent" });

      expect(p.log.error).toHaveBeenCalledWith("Deployment nonexistent not found");
    });

    it("shows error when getDeployments fails", async () => {
      const client = setupAuthenticated();
      client.getDeployments.mockRejectedValue(new Error("network issue"));

      await runSetup({ deploymentID: "d1" });

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("network issue"),
      );
    });
  });

  // ---- stepSelectDeployment tests ----

  describe("stepSelectDeployment", () => {
    function setupWithOrg() {
      const cfg = makeCfg({ access_token: "tok" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
        getDeployments: vi.fn(),
        validateAPIKey: vi.fn(),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("auto-selects single deployment", async () => {
      const client = setupWithOrg();
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "OnlyDeploy", org_id: "o1", org_name: "Org1" },
      ]);
      client.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "key";
      mockLoadConfig.mockReturnValue(cfg);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("OnlyDeploy"),
      );
    });

    it("prompts when multiple deployments for org", async () => {
      const client = setupWithOrg();
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
        { deployment_id: "d2", name: "Deploy2", org_id: "o1", org_name: "Org1" },
      ]);
      client.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "key";
      mockLoadConfig.mockReturnValue(cfg);

      mockSelect.mockResolvedValueOnce("d1");
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(mockSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Select a deployment",
        }),
      );
    });

    it("returns null when no deployments for org", async () => {
      const client = setupWithOrg();
      client.getDeployments.mockResolvedValue([
        { deployment_id: "d1", name: "Deploy1", org_id: "other-org", org_name: "Other" },
      ]);

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("No deployments found"),
      );
    });
  });

  // ---- stepMintAPIKey tests ----

  describe("stepMintAPIKey", () => {
    function setupThroughDeployment() {
      const cfg = makeCfg({ access_token: "tok" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
        getDeployments: vi.fn().mockResolvedValue([
          { deployment_id: "d1", name: "Deploy1", org_id: "o1", org_name: "Org1" },
        ]),
        validateAPIKey: vi.fn(),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return { clientMethods, cfg };
    }

    it("uses existing valid API key", async () => {
      const { clientMethods } = setupThroughDeployment();
      clientMethods.validateAPIKey.mockResolvedValue(true);

      const cfg = mockLoadConfig();
      cfg.api_key = "existing-key";
      mockLoadConfig.mockReturnValue(cfg);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(clientMethods.validateAPIKey).toHaveBeenCalledWith("existing-key", "d1");
      expect(clientMethods.createAPIKey).not.toHaveBeenCalled();
      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("using existing"),
      );
    });

    it("creates new key when existing key is invalid", async () => {
      const { clientMethods } = setupThroughDeployment();
      clientMethods.validateAPIKey.mockResolvedValue(false);
      clientMethods.createAPIKey.mockResolvedValue({ api_key: "brand-new-key" });

      const cfg = mockLoadConfig();
      cfg.api_key = "bad-key";
      mockLoadConfig.mockReturnValue(cfg);

      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(p.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid"),
      );
      expect(clientMethods.createAPIKey).toHaveBeenCalledWith("d1", "dosu-cli");
      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("created"),
      );
    });

    it("creates new key when no existing key", async () => {
      const { clientMethods } = setupThroughDeployment();
      clientMethods.createAPIKey.mockResolvedValue({ api_key: "new-key" });
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(clientMethods.createAPIKey).toHaveBeenCalledWith("d1", "dosu-cli");
    });

    it("returns null when key creation fails", async () => {
      const { clientMethods } = setupThroughDeployment();
      clientMethods.createAPIKey.mockRejectedValue(new Error("rate limited"));
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("rate limited"),
      );
    });
  });

  // ---- stepDetectTools tests ----

  describe("stepDetectTools", () => {
    function setupThroughAPIKey() {
      const cfg = makeCfg({ access_token: "tok", api_key: "key" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
        getDeployments: vi.fn().mockResolvedValue([
          { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        ]),
        validateAPIKey: vi.fn().mockResolvedValue(true),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("filters out non-installed and stdio-only providers", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true });
      const vscodeProvider = makeProvider("vscode", "VS Code", { isInstalled: false });
      const claudeDesktop = makeProvider("claude-desktop", "Claude Desktop", { isInstalled: true });

      mockAllSetupProviders.mockReturnValue([cursorProvider, vscodeProvider, claudeDesktop]);

      // Only cursor should remain after filtering (vscode not installed, claude-desktop is stdio-only)
      // The multiselect will be shown for cursor only
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      // Cursor was selected for install
      expect(cursorProvider.install).toHaveBeenCalled();
      // VS Code was not installed, so never offered
      expect(vscodeProvider.install).not.toHaveBeenCalled();
      // Claude Desktop filtered as stdio-only
      expect(claudeDesktop.install).not.toHaveBeenCalled();
    });

    it("shows warning when no tools detected", async () => {
      setupThroughAPIKey();
      mockAllSetupProviders.mockReturnValue([]);

      await runSetup();

      expect(p.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("No supported AI tools detected"),
      );
    });
  });

  // ---- stepConfigureTools tests ----

  describe("stepConfigureTools", () => {
    function setupThroughAPIKey() {
      const cfg = makeCfg({ access_token: "tok", api_key: "key" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
        getDeployments: vi.fn().mockResolvedValue([
          { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        ]),
        validateAPIKey: vi.fn().mockResolvedValue(true),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("installs selected unconfigured providers", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: false });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);

      // User selects cursor for install
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(cursorProvider.install).toHaveBeenCalled();
      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("Configured 1 tool"),
      );
    });

    it("removes deselected configured providers", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: true });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);

      // User deselects cursor (it was previously configured)
      mockMultiselect.mockResolvedValue([]);

      await runSetup();

      expect(cursorProvider.remove).toHaveBeenCalled();
      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Removed from 1 tool"),
      );
    });

    it("skips already-configured providers that remain selected", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: true });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);

      // User keeps cursor selected (already configured)
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(cursorProvider.install).not.toHaveBeenCalled();
      expect(cursorProvider.remove).not.toHaveBeenCalled();
      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("All tools already configured"),
      );
    });

    it("handles install errors gracefully", async () => {
      setupThroughAPIKey();

      const failProvider = makeProvider("cursor", "Cursor", {
        isInstalled: true,
        isConfigured: false,
        installError: new Error("permission denied"),
      });
      mockAllSetupProviders.mockReturnValue([failProvider]);

      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
      );
    });

    it("handles remove errors gracefully", async () => {
      setupThroughAPIKey();

      const failProvider = makeProvider("cursor", "Cursor", {
        isInstalled: true,
        isConfigured: true,
        removeError: new Error("config locked"),
      });
      mockAllSetupProviders.mockReturnValue([failProvider]);

      // Deselect to trigger remove
      mockMultiselect.mockResolvedValue([]);

      await runSetup();

      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("config locked"),
      );
    });

    it("returns null when user cancels tool selection", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);

      const cancelSymbol = Symbol("cancel");
      mockMultiselect.mockResolvedValue(cancelSymbol as any);
      mockIsCancel.mockImplementation((val) => val === cancelSymbol);

      await runSetup();

      expect(cursorProvider.install).not.toHaveBeenCalled();
    });
  });

  // ---- stepShowSummary tests ----

  describe("stepShowSummary", () => {
    function setupThroughAPIKey() {
      const cfg = makeCfg({ access_token: "tok", api_key: "key" });
      mockLoadConfig.mockReturnValue(cfg);
      const clientMethods = {
        doRequestRaw: vi.fn().mockResolvedValue({ status: 200 }),
        refreshToken: vi.fn(),
        getOrgs: vi.fn().mockResolvedValue([{ org_id: "o1", name: "Org1" }]),
        getDeployments: vi.fn().mockResolvedValue([
          { deployment_id: "d1", name: "D1", org_id: "o1", org_name: "Org1" },
        ]),
        validateAPIKey: vi.fn().mockResolvedValue(true),
        createAPIKey: vi.fn(),
      };
      mockClient.mockImplementation(() => clientMethods as any);
      return clientMethods;
    }

    it("shows try-it-out message when tools are installed", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: false });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(p.log.message).toHaveBeenCalledWith(
        expect.stringContaining("Try it out"),
      );
    });

    it("shows try-it-out message when tools are skipped (already configured)", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: true });
      mockAllSetupProviders.mockReturnValue([cursorProvider]);
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(p.log.message).toHaveBeenCalledWith(
        expect.stringContaining("Try it out"),
      );
    });

    it("mixed install and remove shows both summaries", async () => {
      setupThroughAPIKey();

      const cursorProvider = makeProvider("cursor", "Cursor", { isInstalled: true, isConfigured: false });
      const vscodeProvider = makeProvider("vscode", "VS Code", { isInstalled: true, isConfigured: true });
      mockAllSetupProviders.mockReturnValue([cursorProvider, vscodeProvider]);

      // Select cursor (new install), deselect vscode (remove)
      mockMultiselect.mockResolvedValue(["cursor"]);

      await runSetup();

      expect(p.log.success).toHaveBeenCalledWith(
        expect.stringContaining("Configured 1 tool"),
      );
      expect(p.log.info).toHaveBeenCalledWith(
        expect.stringContaining("Removed from 1 tool"),
      );
    });
  });
});
