/** Post-upgrade refresh against the real Codex provider: an entry written before Codex gained
 * omit_tools_from picks it up on the first command of any later version, an entry that already
 * has it is never touched, and the rest of the user's config.toml stays as it was. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./version", () => ({ VERSION: "1.0.0" }));
vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));

import { getConfigDir, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { checkForMcpRefresh, readMcpRefreshCache } from "./mcp-refresh-check";

const USER_SETTINGS = `model = "gpt-5.5"

[mcp_servers.other]
command = "other-cmd"
`;
const PRE_CHANGE_ENTRY = `
[mcp_servers.dosu]
command = "/usr/local/bin/npx"
args = ["-y", "mcp-remote@0.1.0", "https://api.dosu.dev/v1/mcp/deployments/dep-old"]

[mcp_servers.dosu.env]
X_DOSU_API_KEY = "key-old"
`;

let home: string;
let origHome: string | undefined;
let origXDG: string | undefined;
let origCodexHome: string | undefined;
let origPath: string | undefined;

function codexConfig(): string {
  return readFileSync(join(home, ".codex", "config.toml"), "utf-8");
}

function seed(previous: string | null): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), USER_SETTINGS + PRE_CHANGE_ENTRY);
  mkdirSync(getConfigDir(), { recursive: true });
  if (previous !== null) {
    writeFileSync(join(getConfigDir(), "mcp-refresh.json"), JSON.stringify({ version: previous }));
  }
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
  home = mkdtempSync(join(tmpdir(), "dosu-codex-refresh-"));
  origHome = process.env.HOME;
  origXDG = process.env.XDG_CONFIG_HOME;
  origCodexHome = process.env.CODEX_HOME;
  origPath = process.env.PATH;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.CODEX_HOME;
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npx"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = bin;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = origHome;
  process.env.PATH = origPath;
  if (origXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG;
  if (origCodexHome !== undefined) process.env.CODEX_HOME = origCodexHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("post-upgrade refresh onto the Codex omit_tools_from entry", () => {
  it.each([
    ["0.53.0"],
    ["0.65.1"],
    ["2.0.0"],
    [null],
  ])("rewrites the old entry on the first run after %s and keeps everything else", (previous) => {
    seed(previous);

    checkForMcpRefresh();

    const content = codexConfig();
    expect(content.startsWith(USER_SETTINGS)).toBe(true);
    expect(content).toContain('omit_tools_from = ["deferred"]');
    expect(content).toContain("/deployments/dep-new");
    expect(content).not.toContain("key-old");
    expect(readMcpRefreshCache()).toEqual({ version: "1.0.0" });

    checkForMcpRefresh();

    expect(codexConfig()).toBe(content);
  });

  it("keeps Dosu switched off, and the user's tool settings, through the rewrite", () => {
    seed("0.65.1");
    const userKeys = 'enabled = false\ndisabled_tools = ["read"]\n';
    const approval = '[mcp_servers.dosu.tools.search]\napproval_mode = "approve"\n';
    writeFileSync(
      join(home, ".codex", "config.toml"),
      USER_SETTINGS +
        PRE_CHANGE_ENTRY.replace("[mcp_servers.dosu]\n", `[mcp_servers.dosu]\n${userKeys}`) +
        `\n${approval}`,
    );

    checkForMcpRefresh();

    const content = codexConfig();
    expect(content.startsWith(USER_SETTINGS)).toBe(true);
    expect(content).toContain(`omit_tools_from = ["deferred"]\n${userKeys}`);
    expect(content).toContain(approval);
    expect(content).toContain("/deployments/dep-new");

    writeFileSync(join(getConfigDir(), "mcp-refresh.json"), JSON.stringify({ version: "0.9.0" }));
    checkForMcpRefresh();

    expect(codexConfig()).toBe(content);
  });

  it("leaves the config alone once this version already checked it", () => {
    seed("1.0.0");

    checkForMcpRefresh();

    expect(codexConfig()).toBe(USER_SETTINGS + PRE_CHANGE_ENTRY);
  });

  it("never rewrites an entry that already has the key, or moves it to another deployment", () => {
    seed("0.65.1");
    checkForMcpRefresh();
    const repointed = codexConfig().replace("dep-new", "dep-other").replace("key-new", "key-other");
    writeFileSync(join(home, ".codex", "config.toml"), repointed);
    writeFileSync(join(getConfigDir(), "mcp-refresh.json"), JSON.stringify({ version: "0.9.0" }));

    checkForMcpRefresh();

    expect(codexConfig()).toBe(repointed);
    expect(readMcpRefreshCache()).toEqual({ version: "1.0.0" });
  });
});
