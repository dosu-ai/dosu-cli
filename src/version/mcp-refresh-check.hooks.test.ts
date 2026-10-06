/** Post-upgrade refresh of the agents' hooks, against the real hook code: an install whose hooks an
 * earlier release wrote gets what this release's hooks add on the first command after the
 * upgrade, as its MCP entries do, and an agent whose hooks are off is left alone. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The release that moved every entry to the local proxy, whose hooks name each memory call's
// session; keep in step with MCP_FORMAT_CHANGES.
vi.mock("./version", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./version")>()),
  VERSION: "0.66.0",
}));
vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));

import { finishUpgrade } from "../commands/upgrade";
import { getConfigDir, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { getHookAgent } from "../hooks/agents";
import { checkForMcpRefresh, readMcpRefreshCache } from "./mcp-refresh-check";

let home: string;

const settingsPath = () => join(home, ".claude", "settings.json");
const settings = () => JSON.parse(readFileSync(settingsPath(), "utf-8"));
const opencodePlugin = () => join(home, ".config", "opencode", "plugin", "dosu.js");

function agent(id: string) {
  const found = getHookAgent(id);
  if (!found) throw new Error(`no ${id} hook agent`);
  return found;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-hooks-refresh-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", join(home, ".local", "share"));
  vi.stubEnv("PATH", join(home, "no-bin"));
  vi.stubEnv("DOSU_DEV", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  saveConfig(
    makeTestConfig({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 0,
      deployment_id: "dep-1",
      api_key: "key-1",
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Claude Code and OpenCode with the hooks a 0.65 release installed: no PreToolUse guard on the
 * memory tools, and an OpenCode plugin of that release's making. Cursor is here, its hooks off. */
function seedEarlierHooks(): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  agent("claude").enable();
  agent("opencode").enable();
  const config = settings();
  delete config.hooks.PreToolUse;
  writeFileSync(settingsPath(), JSON.stringify(config));
  writeFileSync(opencodePlugin(), "// dosu-opencode-plugin, as 0.65.1 wrote it\n");
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(join(getConfigDir(), "mcp-refresh.json"), JSON.stringify({ version: "0.65.1" }));
}

it("re-applies the hooks of every agent that has them on, after an upgrade across 0.66.0", () => {
  seedEarlierHooks();

  checkForMcpRefresh();

  expect(settings().hooks.PreToolUse).toEqual([
    expect.objectContaining({ matcher: expect.stringContaining("search_memory") }),
  ]);
  expect(readFileSync(opencodePlugin(), "utf-8")).toContain('"shell.env"');
  expect(existsSync(join(home, ".cursor", "hooks.json"))).toBe(false);
  expect(readMcpRefreshCache()).toEqual({ version: "0.66.0" });
});

it("leaves the hooks alone once this release already refreshed them", () => {
  seedEarlierHooks();
  writeFileSync(join(getConfigDir(), "mcp-refresh.json"), JSON.stringify({ version: "0.66.0" }));

  checkForMcpRefresh();

  expect(settings().hooks.PreToolUse).toBeUndefined();
});

it("re-applies them when `dosu upgrade` finishes without a terminal, too", async () => {
  seedEarlierHooks();

  await finishUpgrade("0.65.1", { interactive: false });

  expect(settings().hooks.PreToolUse).toHaveLength(1);
  expect(readFileSync(opencodePlugin(), "utf-8")).toContain('"shell.env"');
});
