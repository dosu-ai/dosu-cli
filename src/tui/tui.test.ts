import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(),
  outro: vi.fn(),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../config/config", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  isAuthenticated: vi.fn(),
}));

vi.mock("../client/client", () => ({
  Client: vi.fn(),
}));

vi.mock("../setup/flow", () => ({
  runSetup: vi.fn(),
}));

vi.mock("../mcp/providers", () => ({
  allProviders: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    magenta: (s: string) => s,
    dim: (s: string) => s,
  },
}));

import * as p from "@clack/prompts";
import { loadConfig, saveConfig, isAuthenticated } from "../config/config";
import { Client } from "../client/client";
import { runSetup } from "../setup/flow";
import { runTUI } from "./tui";

const mockSelect = vi.mocked(p.select);
const mockIsCancel = vi.mocked(p.isCancel);
const mockOutro = vi.mocked(p.outro);
const mockLoadConfig = vi.mocked(loadConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockIsAuthenticated = vi.mocked(isAuthenticated);
const mockRunSetup = vi.mocked(runSetup);

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "tok",
    refresh_token: "ref",
    expires_at: 9999999999,
    deployment_id: undefined as string | undefined,
    deployment_name: undefined as string | undefined,
    api_key: undefined as string | undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Suppress console.log for the logo
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runTUI", () => {
  it("calls runSetup when not authenticated", async () => {
    const cfg = makeCfg({ access_token: "" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(false);
    mockRunSetup.mockResolvedValue(undefined);

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalledOnce();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("exits loop and calls outro when user selects exit", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockSelect.mockResolvedValueOnce("exit");
    mockIsCancel.mockReturnValue(false);

    await runTUI();

    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("exits loop when user cancels select", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockSelect.mockResolvedValueOnce(Symbol("cancel") as any);
    mockIsCancel.mockReturnValue(true);

    await runTUI();

    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("calls runSetup when user selects setup action", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);
    mockRunSetup.mockResolvedValue(undefined);

    // First call: select "setup", second call: select "exit"
    mockSelect.mockResolvedValueOnce("setup").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalledOnce();
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("handleLogout clears credentials and saves config", async () => {
    const cfg = makeCfg({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 9999999999,
      deployment_id: "dep-1",
      deployment_name: "My Deploy",
      api_key: "key-123",
    });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    // First select "logout", then "exit"
    mockSelect.mockResolvedValueOnce("logout").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: "",
        refresh_token: "",
        expires_at: 0,
        deployment_id: undefined,
        deployment_name: undefined,
        api_key: undefined,
      }),
    );
    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("handleLogout shows warning when not logged in", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);

    // isAuthenticated is called at: (1) line 30 initial check, (2) line 42 hint,
    // (3) line 43 hint, then (4) inside handleLogout at line 175
    mockIsAuthenticated
      .mockReturnValueOnce(true)  // enter menu
      .mockReturnValueOnce(true)  // select hint 1
      .mockReturnValueOnce(true)  // select hint 2
      .mockReturnValueOnce(false) // handleLogout check
      .mockReturnValue(true);     // rest of loop
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("logout").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("You are not logged in.");
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("handleDeployments shows warning when not authenticated", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);

    // isAuthenticated is called at: (1) line 30 initial check, (2) line 42 hint,
    // (3) line 43 hint, then (4) inside handleDeployments at line 86
    mockIsAuthenticated
      .mockReturnValueOnce(true)  // enter menu
      .mockReturnValueOnce(true)  // select hint 1
      .mockReturnValueOnce(true)  // select hint 2
      .mockReturnValueOnce(false) // handleDeployments check
      .mockReturnValue(true);     // rest of loop
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("deployments").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please authenticate first.");
  });

  it("handleDeployments fetches and allows selection", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    const mockDeployments = [
      { deployment_id: "d1", name: "Deploy 1", org_name: "Org" },
      { deployment_id: "d2", name: "Deploy 2", org_name: "Org" },
    ];
    const mockGetDeployments = vi.fn().mockResolvedValue(mockDeployments);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as any,
    );

    // First select "deployments", then select deployment "d1", then "exit"
    mockSelect
      .mockResolvedValueOnce("deployments")
      .mockResolvedValueOnce("d1")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockGetDeployments).toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        deployment_id: "d1",
        deployment_name: "Deploy 1",
      }),
    );
    expect(p.log.success).toHaveBeenCalledWith("Selected: Deploy 1");
  });

  it("handleDeployments shows warning when no deployments found", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    const mockGetDeployments = vi.fn().mockResolvedValue([]);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as any,
    );

    mockSelect.mockResolvedValueOnce("deployments").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("No deployments found.");
  });

  it("handleDeployments cancels when user cancels deployment selection", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);

    const mockDeployments = [
      { deployment_id: "d1", name: "Deploy 1", org_name: "Org" },
    ];
    const mockGetDeployments = vi.fn().mockResolvedValue(mockDeployments);
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as any,
    );

    const cancelSymbol = Symbol("cancel");
    mockIsCancel.mockImplementation((val) => val === cancelSymbol);

    // First select "deployments", then cancel the deployment selection, then "exit"
    mockSelect
      .mockResolvedValueOnce("deployments")
      .mockResolvedValueOnce(cancelSymbol as any)
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(mockOutro).toHaveBeenCalledWith("Goodbye!");
  });

  it("handleMCPAdd shows warning when no deployment selected", async () => {
    const cfg = makeCfg({ deployment_id: undefined });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    // Select mcp-add, then exit
    mockSelect.mockResolvedValueOnce("mcp-add").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please select a deployment first.");
  });

  it("handleMCPRemove shows warning when no deployment selected", async () => {
    const cfg = makeCfg({ deployment_id: undefined });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect.mockResolvedValueOnce("mcp-remove").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.warn).toHaveBeenCalledWith("Please select a deployment first.");
  });

  it("handleMCPAdd installs the selected provider", async () => {
    const mockInstall = vi.fn();
    const mockProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: mockInstall,
      remove: vi.fn(),
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([mockProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockInstall).toHaveBeenCalledWith(cfg, true);
    expect(p.log.success).toHaveBeenCalledWith("Added Dosu MCP to Cursor");
  });

  it("handleMCPAdd shows error when install fails", async () => {
    const mockInstall = vi.fn().mockImplementation(() => {
      throw new Error("write permission denied");
    });
    const mockProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: mockInstall,
      remove: vi.fn(),
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([mockProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Failed: write permission denied");
  });

  it("handleMCPAdd does nothing when user cancels provider selection", async () => {
    const mockProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: vi.fn(),
      remove: vi.fn(),
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([mockProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);

    const cancelSymbol = Symbol("cancel");
    mockIsCancel.mockImplementation((val) => val === cancelSymbol);

    mockSelect
      .mockResolvedValueOnce("mcp-add")
      .mockResolvedValueOnce(cancelSymbol as any)
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockProvider.install).not.toHaveBeenCalled();
  });

  it("handleMCPRemove removes the selected provider", async () => {
    const mockRemove = vi.fn();
    const mockProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: vi.fn(),
      remove: mockRemove,
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([mockProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRemove).toHaveBeenCalledWith(true);
    expect(p.log.success).toHaveBeenCalledWith("Removed Dosu MCP from Cursor");
  });

  it("handleMCPRemove shows error when remove fails", async () => {
    const mockRemove = vi.fn().mockImplementation(() => {
      throw new Error("file not found");
    });
    const mockProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: vi.fn(),
      remove: mockRemove,
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([mockProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Failed: file not found");
  });

  it("handleMCPRemove filters out manual provider", async () => {
    const manualProvider = {
      id: () => "manual",
      name: () => "Manual",
      supportsLocal: () => false,
      install: vi.fn(),
      remove: vi.fn(),
    };
    const cursorProvider = {
      id: () => "cursor",
      name: () => "Cursor",
      supportsLocal: () => true,
      install: vi.fn(),
      remove: vi.fn(),
    };

    const { allProviders } = await import("../mcp/providers");
    vi.mocked(allProviders).mockReturnValue([manualProvider, cursorProvider]);

    const cfg = makeCfg({ deployment_id: "d1" });
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    mockSelect
      .mockResolvedValueOnce("mcp-remove")
      .mockResolvedValueOnce("cursor")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // The select call for mcp-remove should only include cursor, not manual
    const removeSelectCall = mockSelect.mock.calls[1];
    const options = (removeSelectCall[0] as any).options;
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe("cursor");
  });

  it("handleDeployments shows error when fetch fails", async () => {
    const cfg = makeCfg();
    mockLoadConfig.mockReturnValue(cfg);
    mockIsAuthenticated.mockReturnValue(true);
    mockIsCancel.mockReturnValue(false);

    const mockGetDeployments = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(Client).mockImplementation(
      () => ({ getDeployments: mockGetDeployments }) as any,
    );

    mockSelect.mockResolvedValueOnce("deployments").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Failed: network error");
  });
});
