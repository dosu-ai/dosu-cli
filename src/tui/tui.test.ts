import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — only true I/O boundaries
// ---------------------------------------------------------------------------

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
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
import { Client } from "../client/client";
import type { Config } from "../config/config";
import { loadConfig, saveConfig } from "../config/config";
import { loadJSONConfig } from "../mcp/config-helpers";
import { handleLogout, runTUI } from "./tui";

const mockSelect = vi.mocked(p.select);
const mockConfirm = vi.mocked(p.confirm);
const mockIsCancel = vi.mocked(p.isCancel);
const mockOutro = vi.mocked(p.outro);

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

  vi.clearAllMocks();
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

  it("logout action clears real config on disk", async () => {
    const cfg = makeCfg({
      access_token: "tok",
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
    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("deployments action saves selected deployment_id to real config", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockDeployments = [
      { deployment_id: "d1", name: "Deploy 1", org_name: "Org" },
      { deployment_id: "d2", name: "Deploy 2", org_name: "Org" },
    ];
    const mockGetDeployments = vi.fn().mockResolvedValue(mockDeployments);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as unknown as Client,
    );

    mockSelect
      .mockResolvedValueOnce("deployments")
      .mockResolvedValueOnce("d1")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockGetDeployments).toHaveBeenCalled();
    expect(p.log.success).toHaveBeenCalledWith("Selected: Deploy 1");

    // Verify real config on disk has the deployment
    const ondisk = readRealConfig();
    expect(ondisk.deployment_id).toBe("d1");
    expect(ondisk.deployment_name).toBe("Deploy 1");
  });

  it("deployments shows warning when not authenticated (handles inner check)", async () => {
    // Write a config that starts authenticated, then becomes unauthenticated
    // We simulate this by writing the config, then having logout clear it before deployments
    // Actually, simpler: write config with access_token, select logout then deployments
    // But the code checks isAuthenticated inside handleDeployments with the same cfg object.
    // After logout, cfg.access_token is "". So selecting deployments after logout triggers the warn.
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("logout")
      .mockResolvedValueOnce("deployments")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please authenticate first.");
  });

  it("deployments shows warning when no deployments found", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockGetDeployments = vi.fn().mockResolvedValue([]);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as unknown as Client,
    );

    mockSelect.mockResolvedValueOnce("deployments").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("No deployments found.");
  });

  it("deployments handles cancel during deployment selection", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));

    const mockDeployments = [{ deployment_id: "d1", name: "Deploy 1", org_name: "Org" }];
    const mockGetDeployments = vi.fn().mockResolvedValue(mockDeployments);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as unknown as Client,
    );

    const cancelSymbol = Symbol("cancel");
    mockIsCancel.mockImplementation((val) => val === cancelSymbol);

    mockSelect
      .mockResolvedValueOnce("deployments")
      .mockResolvedValueOnce(cancelSymbol as unknown)
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Config should not have been updated
    const ondisk = readRealConfig();
    expect(ondisk.deployment_id).toBeUndefined();
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("deployments shows error when fetch fails", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockGetDeployments = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as unknown as Client,
    );

    mockSelect.mockResolvedValueOnce("deployments").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Failed: network error");
  });

  it("mcp-add shows warning when no deployment selected", async () => {
    writeRealConfig(makeCfg({ access_token: "tok", deployment_id: undefined }));
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("mcp-add").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please select a deployment first.");
  });

  it("mcp-remove shows warning when no deployment selected", async () => {
    writeRealConfig(makeCfg({ access_token: "tok", deployment_id: undefined }));
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("mcp-remove").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please select a deployment first.");
  });

  it("mcp-add with real Cursor provider creates JSON config on disk", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        deployment_name: "my-deploy",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Create the ~/.cursor directory so the provider is "installed"
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.success).toHaveBeenCalledWith("Added Dosu MCP to Cursor");

    // Verify real Cursor MCP config file was created on disk
    const mcpPath = cursorMcpPath();
    expect(existsSync(mcpPath)).toBe(true);

    const mcpConfig = loadJSONConfig(mcpPath);
    expect(mcpConfig.mcpServers).toBeDefined();
    expect(mcpConfig.mcpServers.dosu).toBeDefined();
    expect(mcpConfig.mcpServers.dosu.url).toContain("dep-123");
    expect(mcpConfig.mcpServers.dosu.headers["X-Dosu-API-Key"]).toBe("key-abc");
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

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.success).toHaveBeenCalledWith("Removed Dosu MCP from Cursor");

    // Verify dosu entry was removed but other-tool remains
    const mcpConfig = loadJSONConfig(mcpPath);
    expect(mcpConfig.mcpServers.dosu).toBeUndefined();
    expect(mcpConfig.mcpServers["other-tool"]).toBeDefined();
  });

  it("mcp-add does nothing when user cancels provider selection", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        api_key: "key-abc",
      }),
    );

    const cancelSymbol = Symbol("cancel");
    mockIsCancel.mockImplementation((val) => val === cancelSymbol);

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce(cancelSymbol as unknown)
      .mockResolvedValueOnce("exit");

    await runTUI();

    // No MCP config file should have been created
    expect(existsSync(cursorMcpPath())).toBe(false);
  });

  it("mcp-add shows error when install fails", async () => {
    // Config without api_key — provider.install requires deployment_id
    // but let's trigger the error by having no deployment_id on the config object
    // Actually, the menu guard blocks this. Let's use a provider that throws.
    // We write a config with deployment_id so the guard passes, but with
    // a deployment_id that the provider can use. The real provider won't fail
    // unless something is wrong. We can force it by making the target dir read-only...
    // Simplest: just use a mock for the providers module for this specific error test.
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Create ~/.cursor as a FILE (not directory) so writing mcp.json inside it fails
    writeFileSync(join(tempDir, ".cursor"), "not-a-directory");

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // The install should fail because .cursor is a file, not a directory
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("Failed:"));
  });

  it("mcp-remove filters out manual provider from options", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "dep-123",
        api_key: "key-abc",
      }),
    );
    mockIsCancel.mockReturnValue(false);

    // Create ~/.cursor so cursor provider is "installed"
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Check the options passed to the remove select call (2nd select invocation)
    const removeSelectCall = mockSelect.mock.calls[1];
    const options = (removeSelectCall[0] as { options: { value: string }[] }).options;
    const ids = options.map((o: { value: string }) => o.value);
    expect(ids).not.toContain("manual");
  });
});
