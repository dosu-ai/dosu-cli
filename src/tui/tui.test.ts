import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — only true I/O boundaries
// ---------------------------------------------------------------------------

vi.mock("./prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

// The custom menu needs a raw-mode TTY; tests drive it as a boundary.
vi.mock("./menu", () => ({
  menuSelect: vi.fn(),
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

// The live sync view needs a raw-mode TTY and polls the debug log.
vi.mock("./sync-view", () => ({
  runSyncView: vi.fn(),
}));

// Insights fetches from the backend and opens a browser report.
vi.mock("../commands/insights", () => ({
  executeInsights: vi.fn(),
}));

// The banner reads the update cache from disk; tests must not see the
// developer machine's real cache file.
vi.mock("../version/update-check", () => ({
  getAvailableUpdate: vi.fn(() => null),
  buildUpdateHint: vi.fn(() => 'Run "dosu upgrade"'),
}));

vi.mock("picocolors", () => ({
  default: {
    magenta: (s: string) => s,
    magentaBright: (s: string) => s,
    white: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    bgMagenta: (s: string) => s,
  },
}));

// Provider detection scans the real filesystem; the banner only needs names.
vi.mock("../mcp/providers", () => ({
  allSetupProviders: () => [],
}));

// ---------------------------------------------------------------------------
// Imports — config is REAL, not mocked
// ---------------------------------------------------------------------------

import { OAuthCallbackError } from "../auth/errors";
import { startOAuthFlow } from "../auth/flow";
import { Client } from "../client/client";
import { executeInsights } from "../commands/insights";
import type { Config } from "../config/config";
import { emptyConfig, loadConfig, saveConfig, updateTarget } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { runSetup } from "../setup/flow";
import { menuSelect } from "./menu";
import * as p from "./prompts";
import { runSyncView } from "./sync-view";
import { handleLogout, runTUI } from "./tui";

const mockMenuSelect = vi.mocked(menuSelect);
const mockConfirm = vi.mocked(p.confirm);
const mockIsCancel = vi.mocked(p.isCancel);
const mockStartOAuthFlow = vi.mocked(startOAuthFlow);
const mockRunSetup = vi.mocked(runSetup);
const mockRunSyncView = vi.mocked(runSyncView);
const mockExecuteInsights = vi.mocked(executeInsights);

// ---------------------------------------------------------------------------
// Temp directory setup — real config on disk
// ---------------------------------------------------------------------------

let tempDir: string;
let origHome: string | undefined;
let origXdg: string | undefined;
let stdoutWrites: string[];

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
    cancel: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  } as ReturnType<typeof p.spinner>);
  // The banner and goodbye line write to stdout directly.
  stdoutWrites = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function makeCfg(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "tok",
    refresh_token: "ref",
    expires_at: 9999999999,
    deployment_id: undefined,
    deployment_name: undefined,
    api_key: undefined,
    ...overrides,
  });
}

function writeRealConfig(cfg: Config): void {
  saveConfig(cfg);
}

function readRealConfig(): Config {
  return loadConfig();
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
    expect(cfg.active_account).toBeUndefined();

    // Verify the file on disk was actually written with cleared values
    const ondisk = readRealConfig();
    expect(ondisk.active_account).toBeUndefined();

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
  it("shows the main menu before authentication", async () => {
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockMenuSelect).toHaveBeenCalledOnce();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("exits loop and says goodbye when user selects exit", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("exits loop when user cancels the menu", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockMenuSelect.mockResolvedValueOnce(null);

    await runTUI();

    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("verifies session when user selects auth action with existing token", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 200 });
    vi.mocked(Client).mockImplementation(function () {
      return { doRequestRaw: mockDoRequestRaw } as unknown as Client;
    });

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockDoRequestRaw).toHaveBeenCalledWith("GET", "/v1/mcp/deployments");
    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("refreshes token when verification returns non-200", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockRefreshToken = vi.fn().mockResolvedValue(undefined);
    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 401 });
    vi.mocked(Client).mockImplementation(function () {
      return {
        doRequestRaw: mockDoRequestRaw,
        refreshToken: mockRefreshToken,
      } as unknown as Client;
    });

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRefreshToken).toHaveBeenCalled();
  });

  it("falls through to login when refresh fails", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockRefreshToken = vi.fn().mockRejectedValue(new Error("refresh failed"));
    const mockDoRequestRaw = vi.fn().mockResolvedValue({ status: 401 });
    vi.mocked(Client).mockImplementation(function () {
      return {
        doRequestRaw: mockDoRequestRaw,
        refreshToken: mockRefreshToken,
      } as unknown as Client;
    });

    // User declines to open browser
    mockConfirm.mockResolvedValueOnce(false);

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
  });

  it("falls through to login when verification throws", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);

    const mockDoRequestRaw = vi.fn().mockRejectedValue(new Error("network error"));
    vi.mocked(Client).mockImplementation(function () {
      return { doRequestRaw: mockDoRequestRaw } as unknown as Client;
    });

    // User declines to open browser
    mockConfirm.mockResolvedValueOnce(false);

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
  });

  it("opens browser and saves token on successful OAuth flow", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);
    mockConfirm.mockResolvedValueOnce(true);

    mockStartOAuthFlow.mockImplementationOnce(async (_signal, _path, _params, onAuthURL) => {
      onAuthURL?.("https://app.test/cli/auth?callback=cb");
      return {
        browserOpened: true,
        token: { access_token: "new-tok", refresh_token: "new-ref", expires_in: 3600 },
      };
    });

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockStartOAuthFlow).toHaveBeenCalledWith(
      undefined,
      "/cli/auth",
      {},
      expect.any(Function),
    );
    expect(p.log.message).toHaveBeenCalledWith(
      expect.stringContaining(
        "If your browser doesn't open automatically, visit:\nhttps://app.test/cli/auth?callback=cb",
      ),
    );
    const ondisk = readRealConfig();
    expect(ondisk.active_account?.session.access_token).toBe("new-tok");
    expect(ondisk.active_account?.session.refresh_token).toBe("new-ref");
  });

  it("shows error when OAuth flow fails", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockConfirm.mockResolvedValueOnce(true);
    mockStartOAuthFlow.mockRejectedValueOnce(new Error("auth timeout"));
    mockIsCancel.mockReturnValue(false);
    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith("Authentication failed: auth timeout");
  });

  it("shows curated OAuth callback errors", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockConfirm.mockResolvedValueOnce(true);
    mockStartOAuthFlow.mockRejectedValueOnce(
      new OAuthCallbackError("OAuth state expired", {
        errorCode: "bad_oauth_state",
        errorDescription: "OAuth state expired",
      }),
    );
    mockIsCancel.mockReturnValue(false);
    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith(
      "Authentication failed: OAuth state expired. Run `dosu login` again.",
    );
  });

  it("shows error message and skips save when browser cannot be opened", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);
    mockConfirm.mockResolvedValueOnce(true);
    mockStartOAuthFlow.mockResolvedValueOnce({ browserOpened: false });
    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(p.log.error).toHaveBeenCalledWith(
      "Run 'dosu login --no-browser' from the terminal to authenticate over SSH.",
    );
    expect(readRealConfig().active_account?.session.access_token).toBe("");
  });

  it("does nothing when user cancels confirm prompt", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(true);
    mockConfirm.mockResolvedValueOnce(Symbol.for("cancel") as unknown as boolean);
    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

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

    mockMenuSelect.mockResolvedValueOnce("logout").mockResolvedValueOnce("exit");

    await runTUI();

    // Verify real file on disk was cleared
    const ondisk = readRealConfig();
    expect(ondisk.active_account).toBeUndefined();
    expect(ondisk.mode).toBeUndefined();
    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("shows insights in the menu only for a fully set-up account", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const full = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(full.map((o) => o.value)).toEqual([
      "setup",
      "sync",
      "insights",
      "auth",
      "logout",
      "exit",
    ]);

    mockMenuSelect.mockClear();
    writeRealConfig(makeCfg({}));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const bare = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(bare.map((o) => o.value)).toEqual(["setup", "sync", "auth", "logout", "exit"]);
  });

  it("clears the screen on a TTY so the banner starts at the top", async () => {
    writeRealConfig(makeCfg({}));
    mockMenuSelect.mockResolvedValueOnce("exit");
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await runTUI();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
    }
    const esc = String.fromCharCode(27);
    expect(stdoutWrites[0]).toContain(`${esc}[2J${esc}[H`);
  });

  it("offers insights only for a fully set-up account, and runs it", async () => {
    writeRealConfig(makeCfg({ space_id: "sp", deployment_id: "dep", api_key: "key" }));
    mockExecuteInsights.mockResolvedValue();
    mockMenuSelect.mockResolvedValueOnce("insights").mockResolvedValueOnce("exit");

    await runTUI();

    const opts = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(opts.map((o) => o.value)).toContain("insights");
    expect(mockExecuteInsights).toHaveBeenCalledOnce();
  });

  it("sync action opens the live sync view", async () => {
    writeRealConfig(makeCfg({}));
    mockRunSyncView.mockResolvedValue();
    mockMenuSelect.mockResolvedValueOnce("sync").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSyncView).toHaveBeenCalledOnce();
  });

  it("setup action calls runSetup and reloads config", async () => {
    const initialCfg = makeCfg({ access_token: "tok" });
    writeRealConfig(initialCfg);
    mockIsCancel.mockReturnValue(false);

    // Simulate setup writing new deployment to config
    mockRunSetup.mockImplementation(async () => {
      const cfg = readRealConfig();
      updateTarget(cfg, {
        deployment_id: "dep-from-setup",
        deployment_name: "Setup Deploy",
        api_key: "key-from-setup",
      });
      writeRealConfig(cfg);
    });

    mockMenuSelect.mockResolvedValueOnce("setup").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalled();
    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("setup reload removes account state that was cleared on disk", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockIsCancel.mockReturnValue(false);
    mockRunSetup.mockImplementation(async () => {
      writeRealConfig(emptyConfig());
    });
    mockMenuSelect
      .mockResolvedValueOnce("setup")
      .mockResolvedValueOnce("logout")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Logout after setup sees the reloaded (now empty) config: the session
    // that was cleared on disk must be gone from the in-memory config too.
    expect(p.log.warn).toHaveBeenCalledWith("You are not logged in.");
  });
});
