import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshConfiguredProviders: vi.fn(),
}));

vi.mock("../mcp/refresh", () => ({
  refreshConfiguredProviders: mocks.refreshConfiguredProviders,
}));

// Pin the running version: the real one comes from package.json, which each release bumps, so a
// seeded "previous" version would start crossing format changes that ship after it was written.
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
  MCP_FORMAT_CHANGES,
  needsMcpRefresh,
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
  mocks.refreshConfiguredProviders.mockReset();
  mocks.refreshConfiguredProviders.mockReturnValue({ updated: [], failed: [] });
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

describe("needsMcpRefresh", () => {
  it("lists the releases that changed the MCP entry", () => {
    expect(MCP_FORMAT_CHANGES).toContain("0.53.0");
    // Claude Code entries gained alwaysLoad: true. Provisional: must equal the version this
    // change actually ships in (re-check at merge/release time).
    expect(MCP_FORMAT_CHANGES).toContain("0.62.0");
  });

  it("refreshes every pre-alwaysLoad install when it upgrades onto the Claude Code change", () => {
    for (const previous of [
      "0.58.0",
      "0.58.3",
      "0.59.0",
      "0.59.2",
      "0.60.1",
      "0.60.2",
      "0.61.0",
      "0.61.3",
      null,
    ]) {
      expect(needsMcpRefresh(previous, "0.62.0")).toBe(true);
      expect(needsMcpRefresh(previous, "0.62.4")).toBe(true);
    }
  });

  it("does not refresh again once an install already wrote the alwaysLoad entry", () => {
    expect(needsMcpRefresh("0.62.0", "0.62.1")).toBe(false);
    expect(needsMcpRefresh("0.62.0-alpha.3", "0.62.0")).toBe(false);
  });

  it("refreshes when the install predates the marker", () => {
    expect(needsMcpRefresh(null, "0.60.0")).toBe(true);
  });

  it("refreshes only when the upgrade crosses a format change", () => {
    expect(needsMcpRefresh("0.52.3", "0.53.0")).toBe(true);
    expect(needsMcpRefresh("0.52.3", "0.56.0")).toBe(true);
    expect(needsMcpRefresh("0.53.0-beta.16", "0.53.0")).toBe(false);
    expect(needsMcpRefresh("0.53.0", "0.53.1")).toBe(false);
    expect(needsMcpRefresh("0.54.0", "0.56.0")).toBe(false);
    expect(needsMcpRefresh("0.50.0", "0.52.9")).toBe(false);
  });

  it("treats a downgrade across a format change the same way", () => {
    expect(needsMcpRefresh("0.54.0", "0.52.0")).toBe(true);
    expect(needsMcpRefresh("0.54.0", "0.53.0")).toBe(false);
  });

  it("never refreshes for the same version", () => {
    expect(needsMcpRefresh("0.53.0", "0.53.0")).toBe(false);
  });
});

describe("checkForMcpRefresh", () => {
  it("only moves the marker along for a bump that did not change the entry", () => {
    saveConfig(signedInCfg);
    seedCache("0.62.0");

    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(readMcpRefreshCache()).toEqual({ version: VERSION });
  });

  it("does nothing when this version already refreshed", () => {
    saveConfig(signedInCfg);
    seedCache(VERSION);

    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("refreshes configured agents and records the version after crossing a format change", () => {
    saveConfig(signedInCfg);
    seedCache("0.52.3");
    mocks.refreshConfiguredProviders.mockReturnValue({
      updated: [named("Cursor"), named("Claude Code")],
      failed: [],
    });

    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).toHaveBeenCalledOnce();
    const passed = mocks.refreshConfiguredProviders.mock.calls[0][0];
    expect(passed.active_account?.target?.api_key).toBe("key-1");
    expect(JSON.parse(readFileSync(cachePath(), "utf-8"))).toEqual({ version: VERSION });
    const output = stderr.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("refreshed MCP config for Cursor, Claude Code");
    expect(output).toContain('"dosu setup"');
    expect(output).toContain("restart your AI agents");
  });

  it("also runs when no marker exists yet (first run after adopting this check)", () => {
    saveConfig(signedInCfg);

    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).toHaveBeenCalledOnce();
    expect(readMcpRefreshCache()).toEqual({ version: VERSION });
  });

  it("stays silent when nothing was configured, but still records the version", () => {
    saveConfig(signedInCfg);

    checkForMcpRefresh();

    expect(stderr).not.toHaveBeenCalled();
    expect(readMcpRefreshCache()).toEqual({ version: VERSION });
  });

  it("stays silent with notify: false while still refreshing", () => {
    saveConfig(signedInCfg);
    mocks.refreshConfiguredProviders.mockReturnValue({ updated: [named("Cursor")], failed: [] });

    checkForMcpRefresh({ notify: false });

    expect(mocks.refreshConfiguredProviders).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("skips and leaves no marker when the config cannot drive an install", () => {
    saveConfig(makeTestConfig({ access_token: "tok", refresh_token: "ref", expires_at: 0 }));

    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
    // No marker: the next invocation after the user signs in reconciles.
    expect(existsSync(cachePath())).toBe(false);
  });

  it("skips when there is no config file at all", () => {
    checkForMcpRefresh();

    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
    expect(existsSync(cachePath())).toBe(false);
  });

  it("fails open when the refresh itself throws", () => {
    saveConfig(signedInCfg);
    mocks.refreshConfiguredProviders.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => checkForMcpRefresh()).not.toThrow();
    expect(existsSync(cachePath())).toBe(false);
  });
});
