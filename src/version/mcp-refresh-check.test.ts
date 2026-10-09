import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshProviders: vi.fn(),
  staleProviders: vi.fn(),
}));

vi.mock("../mcp/refresh", () => ({
  refreshProviders: mocks.refreshProviders,
  staleProviders: mocks.staleProviders,
}));

// Pin the running version so a seeded marker compares against a known value.
vi.mock("./version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version")>()),
  VERSION: "0.62.1",
}));

import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { SetupProvider } from "../mcp/providers";
import {
  canRefreshMcp,
  checkForMcpRefresh,
  readMcpRefreshCache,
  writeMcpRefreshCache,
} from "./mcp-refresh-check";
import { VERSION } from "./version";

const CACHE_FILENAME = "mcp-refresh.json";

function named(name: string): SetupProvider {
  return { name: () => name } as unknown as SetupProvider;
}

const signedInCfg = makeTestConfig({
  access_token: "tok",
  refresh_token: "ref",
  expires_at: 0,
  deployment_id: "dep-1",
  api_key: "key-1",
});

let tempDir: string;
let origXDG: string | undefined;
let stderr: ReturnType<typeof spyStderr>;

function spyStderr() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

function cachePath(): string {
  return join(tempDir, "dosu-cli", CACHE_FILENAME);
}

function seedCache(version: string): void {
  mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ version }));
}

beforeEach(() => {
  origXDG = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-mcp-refresh-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  mocks.refreshProviders.mockReset();
  mocks.refreshProviders.mockReturnValue({ updated: [], failed: [] });
  mocks.staleProviders.mockReset();
  mocks.staleProviders.mockReturnValue([]);
  stderr = spyStderr();
});

afterEach(() => {
  if (origXDG !== undefined) {
    process.env.XDG_CONFIG_HOME = origXDG;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cache", () => {
  it("returns null when no cache exists", () => {
    expect(readMcpRefreshCache()).toBeNull();
  });

  it("round-trips a version and creates the config dir", () => {
    writeMcpRefreshCache({ version: "1.2.3" });
    expect(readMcpRefreshCache()).toEqual({ version: "1.2.3" });
  });

  it("returns null for corrupt or mis-shaped JSON", () => {
    seedCache("x");
    writeFileSync(cachePath(), "NOT JSON{{{");
    expect(readMcpRefreshCache()).toBeNull();
    writeFileSync(cachePath(), JSON.stringify({ version: 42 }));
    expect(readMcpRefreshCache()).toBeNull();
  });

  it("swallows write failures", () => {
    process.env.XDG_CONFIG_HOME = join(tempDir, "not-a-dir-file");
    writeFileSync(process.env.XDG_CONFIG_HOME, "occupied");
    expect(() => writeMcpRefreshCache({ version: "1.0.0" })).not.toThrow();
  });
});

describe("canRefreshMcp", () => {
  it("requires an API key", () => {
    expect(canRefreshMcp(makeTestConfig({ ...flat(), api_key: undefined }))).toBe(false);
    expect(canRefreshMcp({ schema_version: 2 })).toBe(false);
  });

  it("requires a deployment outside OSS mode", () => {
    expect(canRefreshMcp(makeTestConfig({ ...flat(), deployment_id: undefined }))).toBe(false);
    expect(
      canRefreshMcp(makeTestConfig({ ...flat(), deployment_id: undefined, mode: "oss" })),
    ).toBe(true);
  });

  it("accepts a cloud target with key and deployment", () => {
    expect(canRefreshMcp(signedInCfg)).toBe(true);
  });

  function flat() {
    return {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 0,
      deployment_id: "dep-1",
      api_key: "key-1",
    };
  }
});

describe("checkForMcpRefresh", () => {
  it("does nothing when this version already checked", () => {
    saveConfig(signedInCfg);
    seedCache(VERSION);

    checkForMcpRefresh();

    expect(mocks.staleProviders).not.toHaveBeenCalled();
    expect(mocks.refreshProviders).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    ["0.52.3"],
    ["0.62.0"],
    ["9.0.0"],
    [null],
  ])("checks the entries on the first run after %s and records this version", (previous) => {
    saveConfig(signedInCfg);
    if (previous) seedCache(previous);

    checkForMcpRefresh();

    expect(mocks.staleProviders).toHaveBeenCalledOnce();
    expect(mocks.staleProviders.mock.calls[0][0].active_account?.target?.api_key).toBe("key-1");
    expect(readMcpRefreshCache()).toEqual({ version: VERSION });
  });

  it("rewrites only the out-of-date entries and says so", () => {
    saveConfig(signedInCfg);
    const stale = [named("Cursor"), named("Claude Code")];
    mocks.staleProviders.mockReturnValue(stale);
    mocks.refreshProviders.mockReturnValue({ updated: stale, failed: [] });

    checkForMcpRefresh();

    expect(mocks.refreshProviders).toHaveBeenCalledOnce();
    const [passed, providers] = mocks.refreshProviders.mock.calls[0];
    expect(passed.active_account?.target?.api_key).toBe("key-1");
    expect(providers).toBe(stale);
    expect(JSON.parse(readFileSync(cachePath(), "utf-8"))).toEqual({ version: VERSION });
    const output = stderr.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("refreshed MCP config for Cursor, Claude Code");
    expect(output).toContain('"dosu setup"');
    expect(output).toContain("restart your AI agents");
  });

  it("stays silent when every entry is already current, but still records the version", () => {
    saveConfig(signedInCfg);

    checkForMcpRefresh();

    expect(stderr).not.toHaveBeenCalled();
    expect(readMcpRefreshCache()).toEqual({ version: VERSION });
  });

  it("stays silent with notify: false while still refreshing", () => {
    saveConfig(signedInCfg);
    mocks.staleProviders.mockReturnValue([named("Cursor")]);
    mocks.refreshProviders.mockReturnValue({ updated: [named("Cursor")], failed: [] });

    checkForMcpRefresh({ notify: false });

    expect(mocks.refreshProviders).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("skips and leaves no marker when the config cannot drive an install", () => {
    saveConfig(makeTestConfig({ access_token: "tok", refresh_token: "ref", expires_at: 0 }));

    checkForMcpRefresh();

    expect(mocks.staleProviders).not.toHaveBeenCalled();
    // No marker: the next invocation after the user signs in reconciles.
    expect(existsSync(cachePath())).toBe(false);
  });

  it("skips when there is no config file at all", () => {
    checkForMcpRefresh();

    expect(mocks.staleProviders).not.toHaveBeenCalled();
    expect(existsSync(cachePath())).toBe(false);
  });

  it("fails open when the refresh itself throws", () => {
    saveConfig(signedInCfg);
    mocks.refreshProviders.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => checkForMcpRefresh()).not.toThrow();
    expect(existsSync(cachePath())).toBe(false);
  });
});
