import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — only true I/O boundaries
// ---------------------------------------------------------------------------

vi.mock("./prompts", () => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
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

vi.mock("../auth/flow", () => ({
  startOAuthFlow: vi.fn(),
}));

vi.mock("../setup/flow", () => ({
  runSetup: vi.fn(),
  runSwitchTarget: vi.fn(),
}));

// The live Activity view needs a raw-mode TTY and polls the debug log.
vi.mock("./activity-view", () => ({
  runActivityView: vi.fn(),
}));

// And the Pages screen, which also fetches from the backend.
vi.mock("./pages-view", () => ({
  runPagesView: vi.fn(),
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
    yellow: (s: string) => s,
    bgMagenta: (s: string) => s,
  },
}));

// Provider detection scans the real filesystem; tests control the result.
vi.mock("../mcp/providers", () => ({
  allSetupProviders: vi.fn(() => []),
}));

// The repo row shells out to git and reads AGENTS.md; keep tests hermetic.
vi.mock("../setup/agents-md-step", () => ({
  inGitWorkTree: vi.fn(() => false),
  dosuAgentsSectionState: vi.fn(() => "missing"),
}));

// The mining-projects picker scans the real session stores.
vi.mock("../sessions/scan", () => ({
  scanAgentSessions: vi.fn(() => []),
}));

// Directory resolution reads session files and probes the filesystem; tests
// map a session's project field straight to a fake absolute path.
vi.mock("../sessions/project-dir", () => ({
  createProjectDirResolver: vi.fn(() => ({
    resolve: (s: { project?: string }) => (s.project ? `/repo/${s.project}` : null),
    flush: vi.fn(),
  })),
}));

// Hook detection reads the real agents' hook config files.
vi.mock("../hooks/agents", () => ({
  getHookAgent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — config is REAL, not mocked
// ---------------------------------------------------------------------------

import { OAuthCallbackError } from "../auth/errors";
import { startOAuthFlow } from "../auth/flow";
import type { Config } from "../config/config";
import { emptyConfig, getConfigDir, loadConfig, saveConfig, updateTarget } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import type { HookAgent } from "../hooks/agents";
import { getHookAgent } from "../hooks/agents";
import type { SetupProvider } from "../mcp/providers";
import { allSetupProviders } from "../mcp/providers";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { scanAgentSessions } from "../sessions/scan";
import { dosuAgentsSectionState, inGitWorkTree } from "../setup/agents-md-step";
import { runSetup, runSwitchTarget } from "../setup/flow";
import { lockPath } from "../sync/lock";
import { loadSyncState, saveSyncState } from "../sync/watermark";
import { runActivityView } from "./activity-view";
import { frameTopMargin } from "./layout";
import { menuSelect } from "./menu";
import { runPagesView } from "./pages-view";
import * as p from "./prompts";
import { handleLogout, runTUI } from "./tui";

const mockMenuSelect = vi.mocked(menuSelect);
const mockConfirm = vi.mocked(p.confirm);
const mockIsCancel = vi.mocked(p.isCancel);
const mockStartOAuthFlow = vi.mocked(startOAuthFlow);
const mockRunSetup = vi.mocked(runSetup);
const mockInGitWorkTree = vi.mocked(inGitWorkTree);
const mockSectionState = vi.mocked(dosuAgentsSectionState);
const mockRunSwitchTarget = vi.mocked(runSwitchTarget);
const mockRunActivityView = vi.mocked(runActivityView);
const mockRunPagesView = vi.mocked(runPagesView);
const mockAllSetupProviders = vi.mocked(allSetupProviders);
const mockScanSessions = vi.mocked(scanAgentSessions);
const mockMultiselect = vi.mocked(p.multiselect);
const mockGetHookAgent = vi.mocked(getHookAgent);

/** Hook agent stub: only the detection surface the TUI reads. */
function fakeHookAgent(enabled: boolean): HookAgent {
  return { isEnabled: () => enabled } as HookAgent;
}

function fakeSession(id: string, project?: string): AgentSession {
  return {
    id,
    harness: "claude",
    path: `/tmp/${id}.jsonl`,
    updated: "2026-08-25T11:00:00Z",
    ...(project ? { project } : {}),
  };
}

/** Minimal provider stub: only the detection surface the TUI reads. */
function fakeProvider(installed: boolean, configured: boolean, name = "Cursor"): SetupProvider {
  return {
    id: () => name.toLowerCase(),
    name: () => name,
    isInstalled: () => installed,
    isConfigured: () => configured,
  } as SetupProvider;
}

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
  // Default machine state: one agent installed with Dosu already configured,
  // so "target complete" configs count as fully set up.
  mockAllSetupProviders.mockImplementation(() => [fakeProvider(true, true)]);
  mockGetHookAgent.mockImplementation(() => fakeHookAgent(true));
  mockScanSessions.mockImplementation(() => []);
  vi.mocked(createProjectDirResolver).mockImplementation(
    () =>
      ({
        resolve: (s: AgentSession) => (s.project ? `/repo/${s.project}` : null),
        flush: vi.fn(),
      }) as ReturnType<typeof createProjectDirResolver>,
  );
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

const ANSI_ESC = String.fromCharCode(27);
function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ANSI_ESC}\\[[0-9;]*m`, "g"), "");
}

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

  it("auth goes straight to the login prompt — no session-verification preamble", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);

    // User declines to open browser
    mockConfirm.mockResolvedValueOnce(false);

    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockConfirm).toHaveBeenCalledWith({ message: "Open browser to log in?" });
    expect(stdoutWrites.join("")).not.toContain("Verifying session");
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

  it("logout via settings clears real config on disk", async () => {
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

    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("logout")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Verify real file on disk was cleared
    const ondisk = readRealConfig();
    expect(ondisk.active_account).toBeUndefined();
    expect(ondisk.mode).toBeUndefined();
    expect(p.log.success).toHaveBeenCalledWith("Credentials cleared.");
  });

  it("hides top-level Setup once configured; gates the whole menu behind login", async () => {
    // Signed in with a target: setup moved into Settings, no Authenticate.
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const signedIn = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(signedIn.map((o) => o.value)).toEqual([
      "sync",
      "analytics",
      "pages",
      "settings",
      "exit",
    ]);
    // Everyday rows are bare labels; only Setup carries a (warning) hint.
    expect(signedIn.every((o) => o.hint === undefined)).toBe(true);

    // Signed out: nothing works without an account, so the menu is just the
    // door — log in / sign up, or leave.
    mockMenuSelect.mockClear();
    writeRealConfig(makeCfg({ access_token: "" }));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const signedOut = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(signedOut.map((o) => o.value)).toEqual(["auth", "exit"]);
    expect(signedOut[0]?.label).toBe("Log in / Sign up");

    // Signed in but no target yet (login without setup): setup mode — the
    // other screens have nothing to show, so the menu is Setup or leave.
    mockMenuSelect.mockClear();
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const unconfigured = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(unconfigured.map((o) => o.value)).toEqual(["setup", "exit"]);
    expect(stripAnsi(unconfigured[0]?.hint ?? "")).toBe("not set up yet");
  });

  it("stays in setup mode when no installed agent is configured", async () => {
    // Target complete, but the machine's agent has no Dosu MCP entry yet
    // (e.g. the wizard was cancelled at the agent picker).
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockAllSetupProviders.mockImplementation(() => [fakeProvider(true, false)]);
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    // Auto-launched the wizard, and the menu is still just Setup + Exit.
    expect(mockRunSetup).toHaveBeenCalledOnce();
    const options = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(options.map((o) => o.value)).toEqual(["setup", "exit"]);
    expect(stripAnsi(options[0]?.hint ?? "")).toBe("incomplete \u00B7 missing agents");
    // The banner flags the agents row instead of listing configured agents.
    expect(stdoutWrites.join("")).toContain("agents");
    expect(stdoutWrites.join("")).toContain("not configured");
  });

  it("stays in setup mode when a configured agent's hook is missing", async () => {
    // Target complete and the MCP entry installed, but the session-end hook
    // is gone (write failed or was removed by hand).
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockGetHookAgent.mockImplementation(() => fakeHookAgent(false));
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalledOnce();
    const options = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(options.map((o) => o.value)).toEqual(["setup", "exit"]);
    expect(stripAnsi(options[0]?.hint ?? "")).toBe("incomplete \u00B7 missing hooks");
    expect(stdoutWrites.join("")).toContain("hooks");
  });

  it("ignores hooks for agents that are not hook-capable", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    // e.g. Zed: has an MCP entry but no hook support at all.
    mockGetHookAgent.mockImplementation(() => undefined);
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).not.toHaveBeenCalled();
    const options = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(options.map((o) => o.value)).not.toContain("setup");
  });

  it("does not require agents on a machine with none installed", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockAllSetupProviders.mockImplementation(() => []);
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).not.toHaveBeenCalled();
    const options = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(options.map((o) => o.value)).toEqual(["sync", "analytics", "pages", "settings", "exit"]);
  });

  it("flags the repo's AGENTS.md on the banner only inside a git work tree", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );

    // Outside a work tree there is no repo row at all.
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    expect(stdoutWrites.join("")).not.toContain("repo");

    // Inside one with no Dosu section, the row warns and points at Setup.
    stdoutWrites.length = 0;
    mockInGitWorkTree.mockReturnValue(true);
    mockSectionState.mockReturnValue("missing");
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    expect(stdoutWrites.join("")).toContain("AGENTS.md missing the Dosu section");

    // With the current section, the row is a checkmark.
    stdoutWrites.length = 0;
    mockSectionState.mockReturnValue("current");
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    expect(stdoutWrites.join("")).toContain("AGENTS.md has the Dosu section");
  });

  it("keeps Setup at the top with the missing steps when setup was interrupted", async () => {
    // A target with an org but no Library/MCP: the wizard was cancelled
    // partway. The old menu treated any target as configured and hid Setup.
    writeRealConfig(makeCfg({ access_token: "tok", org_id: "org-1" }));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const options = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(options[0]?.value).toBe("setup");
    expect(stripAnsi(options[0]?.hint ?? "")).toBe("incomplete \u00B7 missing Library + MCP");

    // A Library but no MCP key: only the MCP step is named.
    mockMenuSelect.mockClear();
    writeRealConfig(makeCfg({ access_token: "tok", org_id: "org-1", space_id: "sp-1" }));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    const partial = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(stripAnsi(partial[0]?.hint ?? "")).toBe("incomplete \u00B7 missing MCP");
  });

  it("reveals Authenticate after logging out via settings", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockIsCancel.mockReturnValue(false);
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("logout")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // The menu redrawn after logout must offer Authenticate again.
    const afterLogout = mockMenuSelect.mock.calls[2]?.[1] ?? [];
    expect(afterLogout.map((o) => o.value)).toContain("auth");
  });

  it("marks the Activity entry with a mining pickaxe while a run is live", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    // A lock file naming a live pid (our own) = an active mining run.
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath(dir), String(process.pid));
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    const opts = mockMenuSelect.mock.calls[0]?.[1] ?? [];
    expect(opts.find((o) => o.value === "sync")?.label).toContain("\u26CF\uFE0F mining sessions");
    // The welcome banner shows the sync row too.
    expect(stdoutWrites.join("")).toContain("mining sessions...");
  });

  it("runs in the alternate screen on a TTY and restores the shell on exit", async () => {
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
    const all = stdoutWrites.join("");
    // Enters the alternate screen first, then clears it so the banner draws
    // from the top row.
    expect(all.indexOf(`${esc}[?1049h`)).toBeGreaterThanOrEqual(0);
    expect(all.indexOf(`${esc}[?1049h`)).toBeLessThan(all.indexOf(`${esc}[2J${esc}[H`));
    // Leaves the alternate screen before the goodbye so it lands in the
    // shell's normal buffer.
    expect(all.indexOf(`${esc}[?1049l`)).toBeLessThan(all.indexOf("Goodbye!"));
  });

  it("pads the home screen with a fixed top margin", async () => {
    writeRealConfig(makeCfg({}));
    mockMenuSelect.mockResolvedValueOnce("exit");
    const origTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await runTUI();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: origTTY, configurable: true });
    }
    const esc = String.fromCharCode(27);
    // After the screen clear: exactly the height-scaled blank rows, then the
    // banner — a function of terminal height only, never the frame's own
    // height (that jiggled as the menu height changed).
    const clearIndex = stdoutWrites.indexOf(`${esc}[2J${esc}[H`);
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(stdoutWrites[clearIndex + 1]).toBe("\n".repeat(frameTopMargin()));
  });

  it("skips alternate-screen sequences when stdout is not a TTY", async () => {
    writeRealConfig(makeCfg({}));
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    const esc = String.fromCharCode(27);
    expect(stdoutWrites.join("")).not.toContain(`${esc}[?1049`);
    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("sync action opens the live Activity view", async () => {
    writeRealConfig(makeCfg({}));
    mockRunActivityView.mockResolvedValue();
    mockMenuSelect.mockResolvedValueOnce("sync").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunActivityView).toHaveBeenCalledOnce();
  });

  it("analytics action opens the Activity view on its Analytics tab", async () => {
    writeRealConfig(makeCfg({}));
    mockRunActivityView.mockResolvedValue();
    mockMenuSelect.mockResolvedValueOnce("analytics").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunActivityView).toHaveBeenCalledExactlyOnceWith({ initialTab: "analytics" });
  });

  it("pages action opens the Library pages screen", async () => {
    writeRealConfig(makeCfg({}));
    mockRunPagesView.mockResolvedValue();
    mockMenuSelect.mockResolvedValueOnce("pages").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunPagesView).toHaveBeenCalledOnce();
    expect(mockRunActivityView).not.toHaveBeenCalled();
  });

  it("settings submenu shows the active target and goes back", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "d",
        deployment_name: "My MCP",
        org_name: "Acme",
        library_name: "Docs Library",
        api_key: "k",
      }),
    );
    mockMenuSelect
      .mockResolvedValueOnce("settings") // main menu
      .mockResolvedValueOnce("back") // settings submenu
      .mockResolvedValueOnce("exit"); // main menu again

    await runTUI();

    const settingsOptions = mockMenuSelect.mock.calls[1]?.[1] ?? [];
    expect(settingsOptions.map((o) => o.value)).toEqual([
      "switch-org",
      "switch-library",
      "projects",
      "setup",
      "logout",
      "back",
    ]);
    // Each entry hints its own current value: org name on the org row,
    // Library name on the Library row, mining scope on the projects row.
    expect(settingsOptions[0]?.hint).toBe("Acme");
    expect(settingsOptions[1]?.hint).toBe("Docs Library");
    expect(settingsOptions[2]?.hint).toBe("all projects");
    expect(mockRunSwitchTarget).not.toHaveBeenCalled();
  });

  it("mining projects setting saves a subset of folders", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockIsCancel.mockReturnValue(false);
    // Two dosu-cli sessions, one other, one whose directory can't be resolved.
    mockScanSessions.mockImplementation(() => [
      fakeSession("a", "dosu-cli"),
      fakeSession("b", "dosu-cli"),
      fakeSession("c", "other"),
      fakeSession("d"),
    ]);
    mockMultiselect.mockResolvedValueOnce(["/repo/dosu-cli"]);
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("projects")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Options are directories ordered by session count; unresolvable sessions
    // get their own bucket.
    const [args] = mockMultiselect.mock.calls.at(-1) ?? [];
    const opts = (args as unknown as { options: Array<{ value: string }> }).options;
    expect(opts.map((o) => o.value)).toEqual(["/repo/dosu-cli", "/repo/other", "(unknown)"]);
    // The subset is persisted; the reopened settings row hints the new scope.
    expect(loadSyncState().project_filter).toEqual(["/repo/dosu-cli"]);
    const refreshed = mockMenuSelect.mock.calls[2]?.[1] ?? [];
    // The single picked folder is named by its basename, not counted.
    expect(refreshed.find((o) => o.value === "projects")?.hint).toBe("dosu-cli");
  });

  it("mining projects setting clears the filter when everything is picked", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    saveSyncState({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      project_filter: ["/repo/dosu-cli"],
    });
    mockIsCancel.mockReturnValue(false);
    mockScanSessions.mockImplementation(() => [
      fakeSession("a", "dosu-cli"),
      fakeSession("b", "other"),
    ]);
    mockMultiselect.mockResolvedValueOnce(["/repo/dosu-cli", "/repo/other"]);
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("projects")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // The saved filter preselects the picker; picking all clears it.
    const [args] = mockMultiselect.mock.calls.at(-1) ?? [];
    expect((args as { initialValues?: string[] }).initialValues).toEqual(["/repo/dosu-cli"]);
    expect(loadSyncState().project_filter).toBeUndefined();
  });

  it("settings shows 'not configured' before any target exists", async () => {
    writeRealConfig(makeCfg({}));
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce(null) // cancel the submenu
      .mockResolvedValueOnce("exit");

    await runTUI();

    const settingsOptions = mockMenuSelect.mock.calls[1]?.[1] ?? [];
    expect(settingsOptions[0]?.hint).toBeUndefined();
    expect(settingsOptions[1]?.hint).toBe("not configured");
  });

  it("settings switch runs the switch flow with its scope and reloads config", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "d-old",
        deployment_name: "Old MCP",
        api_key: "k",
        space_id: "sp",
      }),
    );
    mockRunSwitchTarget.mockImplementation(async () => {
      const cfg = readRealConfig();
      updateTarget(cfg, {
        deployment_id: "d-new",
        deployment_name: "New MCP",
        api_key: "k",
        space_id: "sp",
      });
      writeRealConfig(cfg);
    });
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("switch-library")
      .mockResolvedValueOnce("back") // settings redraws with the fresh target
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSwitchTarget).toHaveBeenCalledExactlyOnceWith("library");
    // The submenu re-render after the switch reflects the reloaded config.
    const refreshedOptions = mockMenuSelect.mock.calls[2]?.[1] ?? [];
    expect(refreshedOptions[1]?.hint).toBe("New MCP");
    // Leaving settings redraws the home banner with the switched target.
    expect(stdoutWrites.join("")).toContain("New MCP");
  });

  it("settings setup reruns the wizard and redraws with the fresh target", async () => {
    writeRealConfig(
      makeCfg({
        access_token: "tok",
        deployment_id: "d-old",
        deployment_name: "Old MCP",
        api_key: "k",
        space_id: "sp",
      }),
    );
    mockIsCancel.mockReturnValue(false);
    mockRunSetup.mockImplementation(async () => {
      const cfg = readRealConfig();
      updateTarget(cfg, {
        deployment_id: "d-new",
        deployment_name: "Fresh Deploy",
        api_key: "k",
        space_id: "sp",
      });
      writeRealConfig(cfg);
    });
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("setup")
      .mockResolvedValueOnce("back") // settings redraws with the fresh target
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalledOnce();
    // The submenu re-render after setup hints the reloaded target.
    const refreshedOptions = mockMenuSelect.mock.calls[2]?.[1] ?? [];
    expect(refreshedOptions[1]?.hint).toBe("Fresh Deploy");
    // Leaving settings redraws the home banner with the new deployment.
    expect(stdoutWrites.join("")).toContain("Fresh Deploy");
  });

  it("settings switch-org runs the full org chain", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockRunSwitchTarget.mockResolvedValue();
    mockMenuSelect
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("switch-org")
      .mockResolvedValueOnce("back")
      .mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSwitchTarget).toHaveBeenCalledExactlyOnceWith("org");
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
    // The home screen is redrawn after setup, and the fresh banner shows the
    // deployment that setup just configured.
    expect(stdoutWrites.join("")).toContain("Setup Deploy");
    expect(stdoutWrites.join("")).toContain("Goodbye!");
  });

  it("launches straight into setup when signed in but not set up", async () => {
    writeRealConfig(makeCfg({ access_token: "tok" }));
    mockMenuSelect.mockResolvedValueOnce("exit");

    await runTUI();

    // The wizard ran before the menu ever appeared.
    expect(mockRunSetup).toHaveBeenCalledOnce();
    expect(mockMenuSelect).toHaveBeenCalledOnce();
  });

  it("does not auto-launch setup when already set up or signed out", async () => {
    writeRealConfig(
      makeCfg({ access_token: "tok", space_id: "sp", deployment_id: "d", api_key: "k" }),
    );
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    expect(mockRunSetup).not.toHaveBeenCalled();

    writeRealConfig(makeCfg({ access_token: "" }));
    mockMenuSelect.mockResolvedValueOnce("exit");
    await runTUI();
    expect(mockRunSetup).not.toHaveBeenCalled();
  });

  it("flows into setup right after a fresh login without a target", async () => {
    writeRealConfig(makeCfg({ access_token: "" }));
    mockIsCancel.mockReturnValue(false);
    mockConfirm.mockResolvedValueOnce(true);
    mockStartOAuthFlow.mockResolvedValueOnce({
      browserOpened: true,
      token: { access_token: "new-tok", refresh_token: "new-ref", expires_in: 3600 },
    });
    mockMenuSelect.mockResolvedValueOnce("auth").mockResolvedValueOnce("exit");

    await runTUI();

    expect(mockRunSetup).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("logout")
      .mockResolvedValueOnce("exit");

    await runTUI();

    // Logout after setup sees the reloaded (now empty) config: the session
    // that was cleared on disk must be gone from the in-memory config too.
    expect(p.log.warn).toHaveBeenCalledWith("You are not logged in.");
  });
});
