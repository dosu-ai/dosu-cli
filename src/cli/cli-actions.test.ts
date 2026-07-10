import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthCallbackError } from "../auth/errors";
import type { Config } from "../config/config";
import { loadConfig, saveConfig } from "../config/config";
import { allProviders } from "../mcp/providers";
import { createProgram } from "./cli";

// ── Mocks (true external boundaries only) ───────────────────────────────────

const mockStartOAuthFlow = vi.fn();
vi.mock("../auth/flow", () => ({
  startOAuthFlow: (...args: unknown[]) => mockStartOAuthFlow(...args),
}));

const { mockIsHeadless } = vi.hoisted(() => ({
  mockIsHeadless: vi.fn().mockReturnValue(false),
}));
vi.mock("../auth/headless", () => ({
  isHeadless: mockIsHeadless,
}));

const mockStartDeviceFlow = vi.fn();
vi.mock("../auth/device", () => ({
  startDeviceFlow: (...args: unknown[]) => mockStartDeviceFlow(...args),
}));

const mockRunLoginRequest = vi.fn();
const mockRunLoginCheck = vi.fn();
vi.mock("../agent/login-commands", () => ({
  runLoginRequest: (...args: unknown[]) => mockRunLoginRequest(...args),
  runLoginCheck: (...args: unknown[]) => mockRunLoginCheck(...args),
}));

const { mockRefreshToken } = vi.hoisted(() => ({
  mockRefreshToken: vi.fn(),
}));
vi.mock("../client/client", () => ({
  Client: class MockClient {
    private cfg: { refresh_token?: string };

    constructor(cfg: { refresh_token?: string }) {
      this.cfg = cfg;
    }

    refreshToken() {
      if (!this.cfg.refresh_token) {
        throw new Error("no refresh token available");
      }
      return mockRefreshToken(this.cfg);
    }
  },
}));

const mockRunTUI = vi.fn();
vi.mock("../tui/tui", () => ({
  runTUI: (...args: unknown[]) => mockRunTUI(...args),
}));

const mockRunSetup = vi.fn();
vi.mock("../setup/flow", () => ({
  runSetup: (...args: unknown[]) => mockRunSetup(...args),
}));

const { mockLoggerGetLogPath } = vi.hoisted(() => ({
  mockLoggerGetLogPath: vi.fn(),
}));
vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: mockLoggerGetLogPath,
    _resetForTesting: vi.fn(),
  },
}));

// ── Temp dir + env management ───────────────────────────────────────────────

let tempDir: string;
let origXDG: string | undefined;
let origHome: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-cli-test-"));
  origXDG = process.env.XDG_CONFIG_HOME;
  origHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.HOME = tempDir;

  vi.clearAllMocks();
  mockIsHeadless.mockReturnValue(false);
  mockLoggerGetLogPath.mockReturnValue(join(tempDir, "dosu-cli", "debug.log"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tempDir, { recursive: true, force: true });
  logSpy.mockRestore();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

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

async function run(...args: string[]) {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(["node", "dosu", ...args]);
}

function allLogOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function mockSuccessfulRefresh(accessToken: string, refreshToken: string): void {
  mockRefreshToken.mockImplementationOnce(async (cfg: Config) => {
    cfg.access_token = accessToken;
    cfg.refresh_token = refreshToken;
    cfg.expires_at = Math.floor(Date.now() / 1000) + 3600;
    saveConfig(cfg);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CLI actions", () => {
  // ── default (no subcommand) ─────────────────────────────────────────────

  describe("default action (no subcommand)", () => {
    it("launches the TUI", async () => {
      mockRunTUI.mockResolvedValue(undefined);
      await run();
      expect(mockRunTUI).toHaveBeenCalledOnce();
    });
  });

  // ── login ───────────────────────────────────────────────────────────────

  describe("login", () => {
    it("prints already-logged-in when config has valid token", async () => {
      saveConfig(authenticatedConfig());

      await run("login");

      expect(logSpy).toHaveBeenCalledWith("You are already logged in.");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu logout' first to re-authenticate.");
      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
    });

    it("runs OAuth flow and writes token to real config file", async () => {
      // Start with empty config (no file on disk)
      mockStartOAuthFlow.mockImplementation(async (...args: unknown[]) => {
        (args[3] as (url: string) => void)("https://app.test/cli/auth?callback=cb");
        return {
          browserOpened: true,
          token: { access_token: "new_tok", refresh_token: "new_ref", expires_in: 3600 },
        };
      });

      await run("login");

      expect(logSpy).toHaveBeenCalledWith("Opening browser for authentication...");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "If your browser doesn't open automatically, visit:\nhttps://app.test/cli/auth?callback=cb",
        ),
      );
      expect(mockStartOAuthFlow).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith("Successfully authenticated!");

      // Verify the real config file was written
      const cfg = loadConfig();
      expect(cfg.access_token).toBe("new_tok");
      expect(cfg.refresh_token).toBe("new_ref");
      expect(cfg.expires_at).toBeGreaterThan(0);
    });

    it("refreshes the session when token is expired", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000; // expired
      saveConfig(cfg);

      mockSuccessfulRefresh("refreshed_tok", "refreshed_ref");

      await run("login");

      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Session refreshed.");

      const updated = loadConfig();
      expect(updated.access_token).toBe("refreshed_tok");
      expect(updated.refresh_token).toBe("refreshed_ref");
    });

    it("runs OAuth flow when expired token cannot be refreshed", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000; // expired
      saveConfig(cfg);

      mockRefreshToken.mockRejectedValueOnce(new Error("refresh failed"));
      mockStartOAuthFlow.mockResolvedValue({
        browserOpened: true,
        token: { access_token: "oauth_tok", refresh_token: "oauth_ref", expires_in: 7200 },
      });

      await run("login");

      expect(mockStartOAuthFlow).toHaveBeenCalledOnce();

      const updated = loadConfig();
      expect(updated.access_token).toBe("oauth_tok");
      expect(updated.refresh_token).toBe("oauth_ref");
    });

    it("prints curated OAuth callback errors without saving credentials", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      mockStartOAuthFlow.mockRejectedValue(
        new OAuthCallbackError("OAuth state expired", {
          errorCode: "bad_oauth_state",
          errorDescription: "OAuth state expired",
        }),
      );

      await run("login");

      expect(errorSpy).toHaveBeenCalledWith(
        "Authentication failed: OAuth state expired. Run `dosu login` again.",
      );
      expect(process.exitCode).toBe(1);
      expect(loadConfig().access_token).toBe("");

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });

    it("prints generic OAuth errors without crashing", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      mockStartOAuthFlow.mockRejectedValue(new Error("Authentication timed out after 8 minutes"));

      await run("login");

      expect(errorSpy).toHaveBeenCalledWith("Authentication timed out after 8 minutes");
      expect(process.exitCode).toBe(1);
      expect(loadConfig().access_token).toBe("");

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });

    it("uses device flow and saves token when --no-browser is passed", async () => {
      mockStartDeviceFlow.mockResolvedValue({
        access_token: "dev_tok",
        refresh_token: "dev_ref",
        expires_in: 3600,
      });

      await run("login", "--no-browser");

      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(mockStartDeviceFlow).toHaveBeenCalledOnce();
      expect(logSpy).toHaveBeenCalledWith("Successfully authenticated!");
      const cfg = loadConfig();
      expect(cfg.access_token).toBe("dev_tok");
      expect(cfg.refresh_token).toBe("dev_ref");
    });

    it("uses device flow when headless environment is detected", async () => {
      mockIsHeadless.mockReturnValue(true);
      mockStartDeviceFlow.mockResolvedValue({
        access_token: "ssh_tok",
        refresh_token: "ssh_ref",
        expires_in: 3600,
      });

      await run("login");

      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(mockStartDeviceFlow).toHaveBeenCalledOnce();
      const cfg = loadConfig();
      expect(cfg.access_token).toBe("ssh_tok");
    });

    it("falls through to device flow when browser cannot be opened", async () => {
      mockStartOAuthFlow.mockResolvedValue({ browserOpened: false });
      mockStartDeviceFlow.mockResolvedValue({
        access_token: "fb_tok",
        refresh_token: "fb_ref",
        expires_in: 3600,
      });

      await run("login");

      expect(mockStartOAuthFlow).toHaveBeenCalledOnce();
      expect(mockStartDeviceFlow).toHaveBeenCalledOnce();
      const cfg = loadConfig();
      expect(cfg.access_token).toBe("fb_tok");
    });

    it("prints error and sets exitCode when device flow fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      mockIsHeadless.mockReturnValue(true);
      mockStartDeviceFlow.mockRejectedValue(new Error("Login session expired"));

      await run("login");

      expect(errorSpy).toHaveBeenCalledWith("Login session expired");
      expect(process.exitCode).toBe(1);
      expect(loadConfig().access_token).toBe("");

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });

    it("prints error when browser-fallback device flow fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      mockStartOAuthFlow.mockResolvedValue({ browserOpened: false });
      mockStartDeviceFlow.mockRejectedValue(new Error("Authentication timed out"));

      await run("login");

      expect(errorSpy).toHaveBeenCalledWith("Authentication timed out");
      expect(process.exitCode).toBe(1);

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });

    it("converts non-Error device flow throws to strings", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;
      mockIsHeadless.mockReturnValue(true);
      mockStartDeviceFlow.mockRejectedValue("raw error string");

      await run("login");

      expect(errorSpy).toHaveBeenCalledWith("raw error string");
      expect(process.exitCode).toBe(1);

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });

    it("--request mints a ticket and exits", async () => {
      const originalExitCode = process.exitCode;
      mockRunLoginRequest.mockResolvedValue(0);

      await run("login", "--request");

      expect(mockRunLoginRequest).toHaveBeenCalledWith({ json: false });
      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);

      process.exitCode = originalExitCode;
    });

    it("--request --json passes the json flag", async () => {
      const originalExitCode = process.exitCode;
      mockRunLoginRequest.mockResolvedValue(0);

      await run("login", "--request", "--json");

      expect(mockRunLoginRequest).toHaveBeenCalledWith({ json: true });

      process.exitCode = originalExitCode;
    });

    it("--check exchanges a ticket", async () => {
      const originalExitCode = process.exitCode;
      mockRunLoginCheck.mockResolvedValue(0);

      await run("login", "--check", "tkt_abc123");

      expect(mockRunLoginCheck).toHaveBeenCalledWith({ ticket: "tkt_abc123", json: false });
      expect(mockStartOAuthFlow).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);

      process.exitCode = originalExitCode;
    });

    it("--request and --check combined prints error and exits with code 2", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const originalExitCode = process.exitCode;

      await run("login", "--request", "--check", "tkt_abc123");

      expect(errorSpy).toHaveBeenCalledWith("--request and --check cannot be combined.");
      expect(process.exitCode).toBe(2);
      expect(mockRunLoginRequest).not.toHaveBeenCalled();
      expect(mockRunLoginCheck).not.toHaveBeenCalled();

      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────

  describe("logout", () => {
    it("clears credentials in real config file", async () => {
      saveConfig(authenticatedConfig());

      await run("logout");

      expect(logSpy).toHaveBeenCalledWith("Successfully logged out.");

      // Read back the real config file and verify credentials are cleared
      const cfg = loadConfig();
      expect(cfg.access_token).toBe("");
      expect(cfg.refresh_token).toBe("");
      expect(cfg.expires_at).toBe(0);
      expect(cfg.deployment_id).toBeUndefined();
      expect(cfg.deployment_name).toBeUndefined();
      expect(cfg.api_key).toBeUndefined();
    });

    it("prints not-logged-in when config has no credentials", async () => {
      // No config file on disk = empty config
      await run("logout");

      expect(logSpy).toHaveBeenCalledWith("You are not logged in.");
    });
  });

  // ── status ──────────────────────────────────────────────────────────────

  describe("status", () => {
    it("shows deployment info from real config", async () => {
      saveConfig(authenticatedConfig());

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Logged in");
      expect(logSpy).toHaveBeenCalledWith("MCP: My App");
      expect(logSpy).toHaveBeenCalledWith("MCP ID: dep_123");
    });

    it("shows not-logged-in with empty config", async () => {
      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Not logged in");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu login' to authenticate.");
    });

    it("shows token-expired status", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000;
      cfg.refresh_token = "";
      saveConfig(cfg);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Token expired");
      expect(logSpy).toHaveBeenCalledWith("Run 'dosu login' to re-authenticate.");
    });

    it("refreshes expired token before showing logged-in status", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000;
      saveConfig(cfg);
      mockSuccessfulRefresh("status_tok", "status_ref");

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Status: Logged in");
      expect(allLogOutput()).not.toContain("Status: Token expired");
      expect(loadConfig().access_token).toBe("status_tok");
    });

    it("shows no deployment when none selected", async () => {
      const cfg = authenticatedConfig();
      cfg.deployment_id = undefined;
      cfg.deployment_name = undefined;
      saveConfig(cfg);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("MCP: None selected");
      const output = allLogOutput();
      expect(output).toContain("dosu deployments list");
      expect(output).toContain("dosu deployments switch <id>");
    });

    it("shows OSS mode without requiring a deployment", async () => {
      const cfg = authenticatedConfig();
      cfg.mode = "oss";
      cfg.deployment_id = undefined;
      cfg.deployment_name = undefined;
      saveConfig(cfg);

      await run("status");

      expect(logSpy).toHaveBeenCalledWith("Mode: OSS");
      expect(logSpy).toHaveBeenCalledWith("MCP: Public libraries only");
    });
  });

  // ── mcp list ────────────────────────────────────────────────────────────

  describe("mcp list", () => {
    it("prints all real provider names with correct scope labels", async () => {
      await run("mcp", "list");

      const output = allLogOutput();
      expect(output).toContain("Available AI tools:");

      // Verify all real providers appear in the output
      const providers = allProviders();
      for (const p of providers) {
        expect(output).toContain(p.id());
        expect(output).toContain(p.name());
      }

      // Verify scope labels are present for providers
      for (const p of providers) {
        if (p.id() === "manual") {
          // Manual provider should have NO scope label
          // Check that the line with "manual" does not include "(global only)" or "(local + global)"
          const lines = output.split("\n");
          const manualLine = lines.find((l: string) => l.includes("manual"));
          expect(manualLine).toBeDefined();
          expect(manualLine).not.toContain("(global only)");
          expect(manualLine).not.toContain("(local + global)");
        } else if (!p.supportsLocal()) {
          expect(output).toContain("(global only)");
        } else {
          expect(output).toContain("(local + global)");
        }
      }

      expect(output).toContain("Use 'dosu mcp add <agent>' to add Dosu MCP to a tool.");
    });
  });

  // ── mcp add ─────────────────────────────────────────────────────────────

  describe("mcp add", () => {
    it("creates real cursor config file with --global", async () => {
      const cfg = authenticatedConfig();
      saveConfig(cfg);

      await run("mcp", "add", "cursor", "--global");

      // Verify real file was created on disk
      const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
      const cursorConfig = JSON.parse(readFileSync(cursorConfigPath, "utf-8"));
      expect(cursorConfig.mcpServers).toBeDefined();
      expect(cursorConfig.mcpServers.dosu).toBeDefined();
      expect(cursorConfig.mcpServers.dosu.url).toContain("dep_123");
      expect(cursorConfig.mcpServers.dosu.headers).toBeDefined();
      expect(cursorConfig.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key_abc");

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Successfully added Dosu MCP to Cursor"),
      );
    });

    it("throws error for unknown tool", async () => {
      saveConfig(authenticatedConfig());

      await expect(run("mcp", "add", "nonexistent")).rejects.toThrow("unknown tool 'nonexistent'");
    });

    it("throws error when not logged in", async () => {
      // No config on disk = empty/unauthenticated
      await expect(run("mcp", "add", "cursor")).rejects.toThrow("not logged in");
    });

    it("throws error when token is expired", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000;
      cfg.refresh_token = "";
      saveConfig(cfg);

      await expect(run("mcp", "add", "cursor")).rejects.toThrow("session expired");
    });

    it("refreshes expired token before adding MCP config", async () => {
      const cfg = authenticatedConfig();
      cfg.expires_at = Math.floor(Date.now() / 1000) - 1000;
      saveConfig(cfg);
      mockSuccessfulRefresh("mcp_tok", "mcp_ref");

      await run("mcp", "add", "cursor", "--global");

      const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
      const cursorConfig = JSON.parse(readFileSync(cursorConfigPath, "utf-8"));
      expect(cursorConfig.mcpServers.dosu).toBeDefined();
      expect(loadConfig().access_token).toBe("mcp_tok");
    });

    it("throws error when no deployment selected", async () => {
      const cfg = authenticatedConfig();
      cfg.deployment_id = undefined;
      saveConfig(cfg);

      await expect(run("mcp", "add", "cursor")).rejects.toThrow("no MCP selected");
    });

    it("throws error when API key is missing before writing tool config", async () => {
      const cfg = authenticatedConfig();
      cfg.api_key = undefined;
      saveConfig(cfg);

      await expect(run("mcp", "add", "cursor", "--global")).rejects.toThrow("no API key available");
    });

    it("supports OSS mode without a selected deployment", async () => {
      const cfg = authenticatedConfig();
      cfg.mode = "oss";
      cfg.deployment_id = undefined;
      cfg.deployment_name = undefined;
      saveConfig(cfg);

      await run("mcp", "add", "cursor", "--global");

      const cursorConfigPath = join(tempDir, ".cursor", "mcp.json");
      const cursorConfig = JSON.parse(readFileSync(cursorConfigPath, "utf-8"));
      expect(cursorConfig.mcpServers.dosu.url).toContain("/v1/mcp");
      expect(cursorConfig.mcpServers.dosu.url).not.toContain("/deployments/");
    });

    it("logs manual config details without writing files", async () => {
      saveConfig(authenticatedConfig());

      await run("mcp", "add", "manual");

      const output = allLogOutput();
      expect(output).toContain("dep_123");
      expect(output).not.toContain("key_abc");
      expect(output).toContain("Secret hidden");
      // Manual provider returns early, no "Successfully added" message
      expect(output).not.toContain("Successfully added");
    });

    it("only prints the full manual API key when --show-secret is passed", async () => {
      saveConfig(authenticatedConfig());

      await run("mcp", "add", "manual", "--show-secret");

      expect(allLogOutput()).toContain("key_abc");
    });

    it("auto-sets global when provider does not support local", async () => {
      saveConfig(authenticatedConfig());

      // Windsurf only supports global installation
      await run("mcp", "add", "windsurf");

      const output = allLogOutput();
      expect(output).toContain("only supports global installation");
      expect(output).toContain("Successfully added Dosu MCP to Windsurf");
    });

    it("installs globally when --global flag is passed", async () => {
      saveConfig(authenticatedConfig());

      await run("mcp", "add", "cursor", "--global");

      const output = allLogOutput();
      expect(output).toContain("global (all projects)");
      expect(output).toContain("Successfully added Dosu MCP to Cursor");
    });
  });

  // ── setup ───────────────────────────────────────────────────────────────

  describe("setup", () => {
    it("runs setup flow", async () => {
      mockRunSetup.mockResolvedValue(undefined);

      await run("setup");

      expect(mockRunSetup).toHaveBeenCalledWith({
        deploymentID: undefined,
      });
    });

    it("passes --deployment option to setup flow", async () => {
      mockRunSetup.mockResolvedValue(undefined);

      await run("setup", "--deployment", "dep_456");

      expect(mockRunSetup).toHaveBeenCalledWith({
        deploymentID: "dep_456",
      });
    });
  });

  // ── logs ────────────────────────────────────────────────────────────────

  describe("logs", () => {
    it("prints log file path with no flags", async () => {
      await run("logs");
      const output = allLogOutput();
      expect(output).toContain(join(tempDir, "dosu-cli", "debug.log"));
    });

    it("--clear deletes the log file", async () => {
      const logDir = join(tempDir, "dosu-cli");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, "debug.log"), "test log content");

      await run("logs", "--clear");
      expect(logSpy).toHaveBeenCalledWith("Log file deleted.");
    });

    it("--clear prints message when no file exists", async () => {
      await run("logs", "--clear");
      expect(logSpy).toHaveBeenCalledWith("No log file to delete.");
    });

    it("--tail shows last N lines", async () => {
      const logDir = join(tempDir, "dosu-cli");
      mkdirSync(logDir, { recursive: true });
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      writeFileSync(join(logDir, "debug.log"), lines);

      await run("logs", "--tail", "5");
      const output = allLogOutput();
      expect(output).toContain("line 99");
      expect(output).toContain("line 95");
    });

    it("--tail prints message when no file exists", async () => {
      await run("logs", "--tail");
      const output = allLogOutput();
      expect(output).toContain("No log file found");
    });
  });
});
