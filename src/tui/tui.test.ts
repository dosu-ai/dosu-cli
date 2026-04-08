import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — only true I/O boundaries
// ---------------------------------------------------------------------------

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../client/client", () => ({
  Client: vi.fn(),
}));

vi.mock("../auth/flow", () => ({
  startOAuthFlow: vi.fn(),
}));

vi.mock("../setup/flow", () => ({
  runSetup: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    magenta: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// ---------------------------------------------------------------------------
// Imports — config is REAL, not mocked
// ---------------------------------------------------------------------------

import * as p from "@clack/prompts";
import { startOAuthFlow } from "../auth/flow";
import { Client } from "../client/client";
import type { Config } from "../config/config";
import { loadConfig, saveConfig } from "../config/config";
import { loadJSONConfig } from "../mcp/config-helpers";
import { runSetup } from "../setup/flow";
import { handleLogout, runTUI } from "./tui";

const mockSelect = vi.mocked(p.select);
const mockMultiselect = vi.mocked(p.multiselect);
const mockConfirm = vi.mocked(p.confirm);
const mockIsCancel = vi.mocked(p.isCancel);
const mockOutro = vi.mocked(p.outro);
const mockStartOAuthFlow = vi.mocked(startOAuthFlow);
const mockRunSetup = vi.mocked(runSetup);

// ---------------------------------------------------------------------------
// Temp directory setup — real config on disk
// ---------------------------------------------------------------------------

let tempDir: string;
let origHome: string | undefined;
let origXdg: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-tui-test-"));
  origHome = process.env.HOME;
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.HOME = tempDir;

  vi.resetAllMocks();
  // Restore spinner factory cleared by resetAllMocks
  vi.mocked(p.spinner).mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  } as ReturnType<typeof p.spinner>);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origXdg !== undefined) {
    process.env.XDG_CONFIG_HOME = origXdg;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "tok",
    refresh_token: "ref",
    expires_at: 9999999999,
    deployment_id: undefined,
    deployment_name: undefined,
    api_key: undefined,
    ...overrides,
  };
}

function writeRealConfig(cfg: Config): void {
  saveConfig(cfg);
}

function readRealConfig(): Config {
  return loadConfig();
}

/** Returns the path to the Cursor global MCP config given current HOME. */
function cursorMcpPath(): string {
  return join(tempDir, ".cursor", "mcp.json");
}

// ---------------------------------------------------------------------------
// 1. handleLogout — direct, high-fidelity tests
// ---------------------------------------------------------------------------

describe("handleLogout (direct)", () => {
  it("clears credentials on disk when authenticated", () => {
    const cfg = makeCfg({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 9999999999,
      deployment_id: "dep-1",
      deployment_name: "My Deploy",
      api_key: "key-123",
    });
    writeRealConfig(cfg);

    // handleLogout mutates cfg in place and calls saveConfig
    handleLogout(cfg);

    // Verify the object was cleared
    expect(cfg.access_token).toBe("");
    expect(cfg.refresh_token).toBe("");
    expect(cfg.expires_at).toBe(0);
    expect(cfg.deployment_id).toBeUndefined();
    expect(cfg.deployment_name).toBeUndefined();
    expect(cfg.api_key).toBeUndefined();

    // Verify the file on disk was actually written with cleared values
    const ondisk = readRealConfig();
    expect(ondisk.access_token).toBe("");
    expect(ondisk.refresh_token).toBe("");
    expect(ondisk.expires_at).toBe(0);
    expect(ondisk.deployment_id).toBeUndefined();
    expect(ondisk.deployment_name).toBeUndefined();
    expect(ondisk.api_key).toBeUndefined();

    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("shows warning and does not write when not authenticated", () => {
    const cfg = makeCfg({ access_token: "" });
    writeRealConfig(cfg);

    // Grab file mtime before call
    const configPath = join(tempDir, "dosu-cli", "config.json");
    const mtimeBefore = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

    handleLogout(cfg);

    // File content should be unchanged
    const mtimeAfter = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
    expect(mtimeAfter).toBe(mtimeBefore);

    expect(p.log.warn).toHaveBeenCalledWith("You are not logged in.");
    expect(p.log.success).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. runTUI flow tests — mock prompts, real config
// ---------------------------------------------------------------------------

describe("runTUI", () => {
  it("prompts to authenticate when not authenticated (real config, no file on disk)", async () => {
    // No config file exists, so loadConfig returns empty → not authenticated
    // User declines to open browser → TUI exits
    mockConfirm.mockResolvedValueOnce(false);

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("exits loop and calls outro when user selects exit", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockSelect.mockResolvedValueOnce("exit");
    mockIsCancel.mockReturnValue(false);

    await runTUI();

    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("exits loop when user cancels select", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    const cancelSymbol = Symbol("cancel");
    mockSelect.mockResolvedValueOnce(cancelSymbol as unknown);
    mockIsCancel.mockReturnValue(true);

    await runTUI();

    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("verifies session when user selects auth action with existing token", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 200 });
    vi.mocked(Client).mockImplementation(
      () => ({ doRequestRaw: mockDoRequestRaw }) as unknown as Client,
    );

    mockSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockDoRequestRaw).toHaveBeenCalledWith("GET", "/v1/mcp/deployments");
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("refreshes token when verification returns non-200", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 401 });
    vi.mocked(Client).mockImplementation(
      () =>
        ({ doRequestRaw: mockDoRequestRaw, refreshToken: mockRefreshToken }) as unknown as Client,
    );

    mockSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRefreshToken).toHaveBeenCalled();
  });

  it("falls through to login when refresh fails", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockRefreshToken = vi.fn().mockRejectedValue(new Error("refresh failed"));
    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 401 });
    vi.mocked(Client).mockImplementation(
      () =>
        ({ doRequestRaw: mockDoRequestRaw, refreshToken: mockRefreshToken }) as unknown as Client,
    );

    // User declines to open browser
    mockConfirm.mockResolvedValueOnce(false);

    mockSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
  });

  it("falls through to login when verification throws", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockDoRequestRaw = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(Client).mockImplementation(
      () => ({ doRequestRaw: mockDoRequestRaw }) as unknown as Client,
    );

    // User declines to open browser
    mockConfirm.mockResolvedValueOnce(false);

    mockSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
  });

  it("opens browser and saves token on successful OAuth flow", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);
    mockConfirm.mockResolvedValueOnce(true);

    mockStartOAuthFlow.mockResolvedValueOnce({
      access_token: "new-tok",
      refresh_token: "new-ref",
      expires_in: 3600,
    });

    mockSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockStartOAuthFlow).toHaveBeenCalledWith(undefined, "/cli/auth");
    const ondisk = readRealConfig();
    expect(ondisk.access_token).toBe("new-tok");
    expect(ondisk.refresh_token).toBe("new-ref");
  });

  it("saves OSS mode from OAuth token response", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);
    mockConfirm.mockResolvedValueOnce(true);

    mockStartOAuthFlow.mockResolvedValueOnce({
      access_token: "new-tok",
      refresh_token: "new-ref",
      expires_in: 3600,
      mode: "oss",
    });

    mockSelect.mockResolvedValueOnce("exit");

    await runTUI();

    const ondisk = readRealConfig();
    expect(ondisk.mode).toBe("oss");
  });

  it("shows error when OAuth flow fails", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockConfirm.mockResolvedValueOnce(true);
    mockStartOAuthFlow.mockRejectedValueOnce(new Error("auth timeout"));

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Authentication failed: auth timeout");
  });

  it("does nothing when user cancels confirm prompt", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(true);
    mockConfirm.mockResolvedValueOnce(Symbol.for("cancel") as unknown as boolean);

    await runTUI();

    expect(mockStartOAuthFlow).not.toHaveBeenCalled();
  });

  it("logout action clears real config on disk", async () => {
    const cfg = makeCfg({
      access_token: "tok",
      mode: "oss",
      refresh_token: "ref",
      expires_at: 9999999999,
      deployment_id: "dep-1",
      deployment_name: "My Deploy",
      api_key: "key-123",
    });
    writeRealConfig(cfg);
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("logout").mockResolvedValueOnce("exit");

    await runTUI();

    // Verify real file on disk was cleared
    const ondisk = readRealConfig();
    expect(ondisk.access_token).toBe("");
    expect(ondisk.refresh_token).toBe("");
    expect(ondisk.expires_at).toBe(0);
    expect(ondisk.mode).toBeUndefined();
    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("setup action calls runSetup and reloads config", async () => {
    const initialCfg = makeCfg({ access_token: "tok" });
    writeRealConfig(initialCfg);
    mockIsCancel.mockReturnValue(false);

    // Simulate setup writing new deployment to config
    mockRunSetup.mockImplementation(async () => {
      const cfg = readRealConfig();
      cfg.deployment_id = "dep-from-setup";
      cfg.deployment_name = "Setup Deploy";
      cfg.api_key = "key-from-setup";
      writeRealConfig(cfg);
    });

    mockSelect.mockResolvedValueOnce("setup").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalled();
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("mcp-remove shows warning when no deployment selected", async () => {
    writeRealConfig(makeCfg({ access_token: "tok", deployment_id: undefined }));
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("mcp-remove").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please select a deployment first.");
  });

  it("mcp-remove with real Cursor provider removes dosu entry from JSON config", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        deployment_name: "my-deploy",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Pre-create a Cursor MCP config with dosu entry and another entry
    const mcpPath = cursorMcpPath();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            dosu: { url: "http://old-url", headers: {} },
            "other-tool": { url: "http://other" },
          },
        },
        null,
        2,
      ),
    );

    // User deselects cursor (returns empty array = nothing kept)
    mockMultiselect.mockResolvedValueOnce([]);

    mockSelect.mockResolvedValueOnce("mcp-remove");

    await runTUI();

    expect(p.log.success).toHaveBeenCalledWith("Removed Dosu MCP from Cursor");
    // Should exit directly after removal
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
    // Should not return to main menu (no second select call)
    expect(mockSelect).toHaveBeenCalledTimes(1);

    // Verify dosu entry was removed but other-tool remains
    const mcpConfig = loadJSONConfig(mcpPath);
    expect(mcpConfig.mcpServers.dosu).toBeUndefined();
    expect(mcpConfig.mcpServers["other-tool"]).toBeDefined();
  });

  it("mcp-remove shows only configured providers in multiselect", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Create ~/.cursor with dosu configured
    const mcpPath = cursorMcpPath();
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { dosu: { url: "http://old-url", headers: {} } } }, null, 2),
    );

    // User keeps all (no deselection)
    mockMultiselect.mockResolvedValueOnce(["cursor"]);

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Verify multiselect was called with only configured providers
    const multiselectCall = mockMultiselect.mock.calls[0];
    const options = (multiselectCall[0] as { options: { value: string }[] }).options;
    const ids = options.map((o: { value: string }) => o.value);
    expect(ids).toContain("cursor");
    expect(ids).not.toContain("manual");
    // Only configured tools should appear — not unconfigured installed tools
    for (const id of ids) {
      expect(id).toBe("cursor"); // cursor is the only configured provider
    }

    expect(p.log.info).toHaveBeenCalledWith("No changes.");
  });

  it("mcp-remove shows warning when no tools are configured", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Create ~/.cursor but without dosu configured
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("No tools currently have Dosu MCP configured.");
    expect(mockMultiselect).not.toHaveBeenCalled();
  });
});
