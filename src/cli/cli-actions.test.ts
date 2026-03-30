import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createProgram } from "./cli";
import type { Config } from "../config/config";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockLoadConfig = vi.fn<() => Config>();
const mockSaveConfig = vi.fn<(cfg: Config) => void>();
const mockIsAuthenticated = vi.fn<(cfg: Config) => boolean>();
const mockIsTokenExpired = vi.fn<(cfg: Config) => boolean>();
const mockGetConfigPath = vi.fn<() => string>();

vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...(args as [])),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...(args as [Config])),
  isAuthenticated: (...args: unknown[]) => mockIsAuthenticated(...(args as [Config])),
  isTokenExpired: (...args: unknown[]) => mockIsTokenExpired(...(args as [Config])),
  getConfigPath: (...args: unknown[]) => mockGetConfigPath(...(args as [])),
}));

const mockInstall = vi.fn();

const fakeProvider = (overrides: Partial<{
  id: string;
  name: string;
  supportsLocal: boolean;
}> = {}) => ({
  id: vi.fn().mockReturnValue(overrides.id ?? "cursor"),
  name: vi.fn().mockReturnValue(overrides.name ?? "Cursor"),
  supportsLocal: vi.fn().mockReturnValue(overrides.supportsLocal ?? true),
  install: mockInstall,
  remove: vi.fn(),
});

const mockGetProvider = vi.fn();
const mockAllProviders = vi.fn();

vi.mock("../mcp/providers", () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
  allProviders: (...args: unknown[]) => mockAllProviders(...args),
}));

const mockStartOAuthFlow = vi.fn();
vi.mock("../auth/flow", () => ({
  startOAuthFlow: (...args: unknown[]) => mockStartOAuthFlow(...args),
}));

const mockRunTUI = vi.fn();
vi.mock("../tui/tui", () => ({
  runTUI: (...args: unknown[]) => mockRunTUI(...args),
}));

const mockRunSetup = vi.fn();
vi.mock("../setup/flow", () => ({
  runSetup: (...args: unknown[]) => mockRunSetup(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function authenticatedConfig(): Config {
  return {
    access_token: "tok_abc",
    refresh_token: "ref_abc",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    deployment_id: "dep_123",
    deployment_name: "My App",
    api_key: "key_abc",
  };
}

function unauthenticatedConfig(): Config {
  return {
    access_token: "",
    refresh_token: "",
    expires_at: 0,
  };
}

/** Parse a command through Commander, catching Commander's own exit calls. */
async function run(...args: string[]) {
  const program = createProgram();
  program.exitOverride();
  // Commander wraps action errors in CommanderError; we want the original.
  await program.parseAsync(["node", "dosu", ...args]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CLI actions", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetConfigPath.mockReturnValue("/home/user/.config/dosu-cli/config.json");
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── default (no subcommand) ──────────────────────────────────────────────

  describe("default action (no subcommand)", () => {
    it("launches the TUI", async () => {
      mockRunTUI.mockResolvedValue(undefined);
      await run();
      expect(mockRunTUI).toHaveBeenCalledOnce();
    });
  });

  // ── login ────────────────────────────────────────────────────────────────

  describe("login", () => {
    it("prints already-logged-in message when authenticated", async () => {
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("login");

      expect(logSpy).toHaveBeenCalledWith("You are already logged in.");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu logout' first to re-authenticate.");
      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
    });

    it("runs OAuth flow and saves token when not authenticated", async () => {
      const cfg = unauthenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(false);
      mockIsTokenExpired.mockReturnValue(false);
      mockStartOAuthFlow.mockResolvedValue({
        access_token: "new_tok",
        refresh_token: "new_ref",
        expires_in: 3600,
      });

      await run("login");

      expect(logSpy).toHaveBeenCalledWith("Opening browser for authentication...");
      expect(mockStartOAuthFlow).toHaveBeenCalledOnce();
      expect(mockSaveConfig).toHaveBeenCalledOnce();
      const saved = mockSaveConfig.mock.calls[0][0];
      expect(saved.access_token).toBe("new_tok");
      expect(saved.refresh_token).toBe("new_ref");
      expect(saved.expires_at).toBeGreaterThan(0);
      expect(logSpy).toHaveBeenCalledWith("Successfully authenticated!");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Credentials saved to"),
      );
    });

    it("runs OAuth flow when token is expired", async () => {
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(true);
      mockStartOAuthFlow.mockResolvedValue({
        access_token: "refreshed",
        refresh_token: "ref2",
        expires_in: 7200,
      });

      await run("login");

      expect(mockStartOAuthFlow).toHaveBeenCalledOnce();
      expect(mockSaveConfig).toHaveBeenCalledOnce();
    });
  });

  // ── logout ───────────────────────────────────────────────────────────────

  describe("logout", () => {
    it("clears credentials and saves config when authenticated", async () => {
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);

      await run("logout");

      expect(mockSaveConfig).toHaveBeenCalledOnce();
      const saved = mockSaveConfig.mock.calls[0][0];
      expect(saved.access_token).toBe("");
      expect(saved.refresh_token).toBe("");
      expect(saved.expires_at).toBe(0);
      expect(saved.deployment_id).toBeUndefined();
      expect(saved.deployment_name).toBeUndefined();
      expect(saved.api_key).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("Successfully logged out.");
    });

    it("prints not-logged-in message when not authenticated", async () => {
      mockLoadConfig.mockReturnValue(unauthenticatedConfig());
      mockIsAuthenticated.mockReturnValue(false);

      await run("logout");

      expect(logSpy).toHaveBeenCalledWith("You are not logged in.");
      expect(mockSaveConfig).not.toHaveBeenCalled();
    });
  });

  // ── status ───────────────────────────────────────────────────────────────

  describe("status", () => {
    it("shows not-logged-in when unauthenticated", async () => {
      mockLoadConfig.mockReturnValue(unauthenticatedConfig());
      mockIsAuthenticated.mockReturnValue(false);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Not logged in");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu login' to authenticate.");
    });

    it("shows logged in with deployment info", async () => {
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Logged in");
      expect(logSpy).toHaveBeenCalledWith("Deployment: My App");
      expect(logSpy).toHaveBeenCalledWith("Deployment ID: dep_123");
    });

    it("shows token-expired status", async () => {
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(true);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Token expired");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu login' to re-authenticate.");
    });

    it("shows no deployment when none selected", async () => {
      const cfg = authenticatedConfig();
      cfg.deployment_id = undefined;
      cfg.deployment_name = undefined;
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Deployment: None selected");
      expect(logSpy).toHaveBeenCalledWith(
        "Run 'dosu' to open the TUI and select a deployment.",
      );
    });
  });

  // ── mcp list ─────────────────────────────────────────────────────────────

  describe("mcp list", () => {
    it("prints all providers", async () => {
      const providers = [
        fakeProvider({ id: "cursor", name: "Cursor", supportsLocal: true }),
        fakeProvider({ id: "claude", name: "Claude Code", supportsLocal: true }),
        fakeProvider({ id: "manual", name: "Manual", supportsLocal: true }),
      ];
      // Override the id check for "manual" — the list action uses p.id() === "manual"
      providers[2].id.mockReturnValue("manual");
      // Make the third one not support local to exercise all branches
      providers[1].supportsLocal.mockReturnValue(false);

      mockAllProviders.mockReturnValue(providers);

      await run("mcp", "list");

      expect(logSpy).toHaveBeenCalledWith("Available AI tools:\n");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("cursor"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("claude"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("manual"),
      );
      expect(logSpy).toHaveBeenCalledWith(
        "\nUse 'dosu mcp add <tool>' to add Dosu MCP to a tool.",
      );
    });
  });

  // ── mcp add ──────────────────────────────────────────────────────────────

  describe("mcp add", () => {
    it("installs a valid tool", async () => {
      const provider = fakeProvider({ id: "cursor", name: "Cursor", supportsLocal: true });
      mockGetProvider.mockReturnValue(provider);

      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("mcp", "add", "cursor");

      expect(mockGetProvider).toHaveBeenCalledWith("cursor");
      expect(mockInstall).toHaveBeenCalledWith(cfg, false);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Successfully added Dosu MCP to Cursor"),
      );
    });

    it("throws error for unknown tool", async () => {
      mockGetProvider.mockImplementation(() => {
        throw new Error("unknown tool: nope");
      });

      await expect(run("mcp", "add", "nope")).rejects.toThrow(
        "unknown tool 'nope'",
      );
    });

    it("throws error when not authenticated", async () => {
      const provider = fakeProvider();
      mockGetProvider.mockReturnValue(provider);
      mockLoadConfig.mockReturnValue(unauthenticatedConfig());
      mockIsAuthenticated.mockReturnValue(false);

      await expect(run("mcp", "add", "cursor")).rejects.toThrow(
        "not logged in",
      );
    });

    it("throws error when token is expired", async () => {
      const provider = fakeProvider();
      mockGetProvider.mockReturnValue(provider);
      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(true);

      await expect(run("mcp", "add", "cursor")).rejects.toThrow(
        "session expired",
      );
    });

    it("throws error when no deployment selected", async () => {
      const provider = fakeProvider();
      mockGetProvider.mockReturnValue(provider);
      const cfg = authenticatedConfig();
      cfg.deployment_id = undefined;
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await expect(run("mcp", "add", "cursor")).rejects.toThrow(
        "no deployment selected",
      );
    });

    it("calls install without global flag for manual tool", async () => {
      const provider = fakeProvider({ id: "manual", name: "Manual" });
      mockGetProvider.mockReturnValue(provider);

      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("mcp", "add", "manual");

      expect(mockInstall).toHaveBeenCalledWith(cfg, false);
      // Should return early — no "Successfully added" message for manual
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Successfully added"),
      );
    });

    it("auto-sets global when provider does not support local", async () => {
      const provider = fakeProvider({
        id: "zed",
        name: "Zed",
        supportsLocal: false,
      });
      mockGetProvider.mockReturnValue(provider);

      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("mcp", "add", "zed");

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("only supports global installation"),
      );
      expect(mockInstall).toHaveBeenCalledWith(cfg, true);
    });

    it("installs globally when --global flag is passed", async () => {
      const provider = fakeProvider({ id: "cursor", name: "Cursor", supportsLocal: true });
      mockGetProvider.mockReturnValue(provider);

      const cfg = authenticatedConfig();
      mockLoadConfig.mockReturnValue(cfg);
      mockIsAuthenticated.mockReturnValue(true);
      mockIsTokenExpired.mockReturnValue(false);

      await run("mcp", "add", "cursor", "--global");

      expect(mockInstall).toHaveBeenCalledWith(cfg, true);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("global (all projects)"),
      );
    });
  });

  // ── setup ────────────────────────────────────────────────────────────────

  describe("setup", () => {
    it("runs setup flow", async () => {
      mockRunSetup.mockResolvedValue(undefined);

      await run("setup");

      expect(mockRunSetup).toHaveBeenCalledWith({ deploymentID: undefined });
    });

    it("passes --deployment option to setup flow", async () => {
      mockRunSetup.mockResolvedValue(undefined);

      await run("setup", "--deployment", "dep_456");

      expect(mockRunSetup).toHaveBeenCalledWith({ deploymentID: "dep_456" });
    });
  });
});
