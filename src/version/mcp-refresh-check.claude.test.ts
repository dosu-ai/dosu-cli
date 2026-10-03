/** Post-upgrade refresh against the real provider code: an install written by a release before
 * the Claude Code alwaysLoad change gets the new entry on the first command of the shipping
 * release, and nothing else in the user's Claude Code config moves. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Provisional shipping version of the alwaysLoad change; keep in step with MCP_FORMAT_CHANGES.
vi.mock("./version", () => ({ VERSION: "0.62.0" }));
vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));

import { getConfigDir, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { checkForMcpRefresh, readMcpRefreshCache } from "./mcp-refresh-check";

const PRE_ALWAYS_LOAD_ENTRY = {
  type: "http",
  url: "https://api.dosu.dev/v1/mcp/deployments/dep-old",
  headers: { "X-Dosu-API-Key": "key-old" },
};
const UNRELATED = {
  github: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } },
  local: { command: "node", args: ["server.js"], env: { A: "1" } },
};

let home: string;
let origHome: string | undefined;
let origXDG: string | undefined;

function claudeJson() {
  return JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
}

function writeMarker(contents: string): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(join(getConfigDir(), "mcp-refresh.json"), contents);
}

function seed(previous: string | null): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 3,
      projects: { "/repo": { allowedTools: [] } },
      mcpServers: { dosu: PRE_ALWAYS_LOAD_ENTRY, ...UNRELATED },
    }),
  );
  if (previous !== null) writeMarker(JSON.stringify({ version: previous }));
  saveConfig(
    makeTestConfig({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 0,
      deployment_id: "dep-new",
      api_key: "key-new",
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-always-load-refresh-"));
  origHome = process.env.HOME;
  origXDG = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  // No `dosu` on PATH: this pins the remote entry 0.62.0 wrote, not the later stdio proxy.
  vi.stubEnv("PATH", join(home, "no-bin"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  if (origXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("post-upgrade refresh onto the Claude Code alwaysLoad entry", () => {
  it.each([
    ["0.58.3"],
    ["0.59.0"],
    ["0.59.2"],
    ["0.60.1"],
    ["0.60.2"],
    ["0.61.0"],
    [null],
  ])("rewrites the entry written by %s and keeps everything else", (previous) => {
    seed(previous);

    checkForMcpRefresh();

    const cfg = claudeJson();
    expect(cfg.mcpServers.dosu).toEqual({
      type: "http",
      url: expect.stringContaining("dep-new"),
      headers: { "X-Dosu-API-Key": "key-new" },
      alwaysLoad: true,
    });
    expect(cfg.mcpServers.github).toEqual(UNRELATED.github);
    expect(cfg.mcpServers.local).toEqual(UNRELATED.local);
    expect(cfg.numStartups).toBe(3);
    expect(cfg.projects).toEqual({ "/repo": { allowedTools: [] } });
    expect(readMcpRefreshCache()).toEqual({ version: "0.62.0" });
  });

  it.each([
    ["unreadable JSON", "{not json"],
    ["a non-string version", JSON.stringify({ version: 61 })],
  ])("treats a marker with %s as unknown and rewrites the entry", (_label, contents) => {
    seed(null);
    writeMarker(contents);

    checkForMcpRefresh();

    expect(claudeJson().mcpServers.dosu).toMatchObject({ alwaysLoad: true });
    expect(readMcpRefreshCache()).toEqual({ version: "0.62.0" });
  });

  it("leaves the config alone once the shipping release already refreshed it", () => {
    seed("0.62.0");

    checkForMcpRefresh();

    expect(claudeJson().mcpServers.dosu).toEqual(PRE_ALWAYS_LOAD_ENTRY);
  });

  it("does not add a Dosu entry to a Claude Code config that never had one", () => {
    seed("0.60.2");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: UNRELATED }));

    checkForMcpRefresh();

    expect(claudeJson().mcpServers).toEqual(UNRELATED);
    expect(existsSync(join(home, ".mcp.json"))).toBe(false);
  });
});
