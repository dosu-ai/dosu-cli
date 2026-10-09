/** `isCurrent` against every real provider: what `install` writes is current, whatever deployment,
 * key, or npx it points at, and an entry in any other shape is not. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/config";
import { type FlatTestConfig, makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig, saveJSONConfig } from "../config-helpers";
import { allSetupProviders, type SetupProvider } from "../providers";

function makeCfg(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "at",
    refresh_token: "rt",
    expires_at: 0,
    deployment_id: "dep-a",
    api_key: "key-a",
    ...overrides,
  });
}

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "APPDATA", "PATH"] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let home: string;

/** Put npx in a fresh bin dir on PATH, as a moved Node install would. */
function useNpxIn(dir: string): void {
  const bin = join(home, dir);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "npx"), "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = bin;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "dosu-current-test-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.APPDATA = join(home, "AppData");
  useNpxIn("bin");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

function provider(id: string): SetupProvider {
  const found = allSetupProviders().find((p) => p.id() === id);
  if (!found) throw new Error(`no provider ${id}`);
  return found;
}

const ids = allSetupProviders().map((p) => [p.id()]);

describe.each(ids)("%s isCurrent", (id) => {
  it("is false before anything is installed", () => {
    expect(provider(id).isCurrent(makeCfg())).toBe(false);
  });

  it("is true for what install writes, whatever deployment and key it points at", () => {
    provider(id).install(makeCfg(), true);

    expect(provider(id).isCurrent(makeCfg())).toBe(true);
    expect(provider(id).isCurrent(makeCfg({ deployment_id: "dep-b", api_key: "key-b" }))).toBe(
      true,
    );
    expect(provider(id).isCurrent(undefined)).toBe(true);
  });

  it("is true after npx moves, so a Node upgrade alone never triggers a rewrite", () => {
    provider(id).install(makeCfg(), true);
    useNpxIn("other-bin");

    expect(provider(id).isCurrent(makeCfg())).toBe(true);
  });

  it("tells an OSS entry from a cloud one", () => {
    const oss = makeCfg({ mode: "oss", deployment_id: undefined });
    provider(id).install(oss, true);

    expect(provider(id).isCurrent(oss)).toBe(true);
    expect(provider(id).isCurrent(makeCfg())).toBe(false);
  });
});

describe("out-of-date entries", () => {
  it("Claude Code: an entry written before alwaysLoad", () => {
    const claude = provider("claude");
    claude.install(makeCfg(), true);
    const path = join(home, ".claude.json");
    const cfg = loadJSONConfig(path);
    delete cfg.mcpServers.dosu.alwaysLoad;
    saveJSONConfig(path, cfg);

    expect(claude.isCurrent(makeCfg())).toBe(false);
  });

  it("a JSON entry with a key added by hand", () => {
    const cursor = provider("cursor");
    cursor.install(makeCfg(), true);
    const path = join(home, ".cursor", "mcp.json");
    const cfg = loadJSONConfig(path);
    cfg.mcpServers.dosu.type = "sse";
    saveJSONConfig(path, cfg);

    expect(cursor.isCurrent(makeCfg())).toBe(false);
  });

  it("stays current when the agent's UI turns Dosu off or approves its tools", () => {
    const cline = provider("cline-cli");
    cline.install(makeCfg(), true);
    const path = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    const cfg = loadJSONConfig(path);
    Object.assign(cfg.mcpServers.dosu, { disabled: true, autoApprove: ["search"], timeout: 120 });
    saveJSONConfig(path, cfg);

    expect(cline.isCurrent(makeCfg())).toBe(true);
  });

  describe("Codex", () => {
    const path = () => join(home, ".codex", "config.toml");

    beforeEach(() => {
      mkdirSync(join(home, ".codex"), { recursive: true });
    });

    it("stays current with other servers and settings around the entry", () => {
      writeFileSync(path(), 'model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\n');
      provider("codex").install(makeCfg(), true);
      writeFileSync(path(), `${readFileSync(path(), "utf-8")}\n[profiles.fast]\nmodel = "y"\n`);

      expect(provider("codex").isCurrent(makeCfg())).toBe(true);
    });

    it("is not current for an entry written before omit_tools_from", () => {
      provider("codex").install(makeCfg(), true);
      writeFileSync(path(), readFileSync(path(), "utf-8").replace(/^omit_tools_from = .*\n/m, ""));

      expect(provider("codex").isCurrent(makeCfg())).toBe(false);
    });

    it("is not current for the legacy remote-HTTP entry", () => {
      writeFileSync(
        path(),
        '[mcp_servers.dosu]\nurl = "https://api.dosu.dev/v1/mcp/deployments/d"\n\n' +
          '[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "k"\n',
      );

      expect(provider("codex").isCurrent(makeCfg())).toBe(false);
    });

    it("is not current with a key added by hand, or a line it cannot read", () => {
      provider("codex").install(makeCfg(), true);
      const written = readFileSync(path(), "utf-8");

      writeFileSync(path(), written.replace("[mcp_servers.dosu]\n", "[mcp_servers.dosu]\nx = 1\n"));
      expect(provider("codex").isCurrent(makeCfg())).toBe(false);

      writeFileSync(path(), written.replace("[mcp_servers.dosu]\n", "[mcp_servers.dosu]\nstray\n"));
      expect(provider("codex").isCurrent(makeCfg())).toBe(false);

      writeFileSync(path(), written.replace(/^(args = .*)$/m, "$1 # pinned"));
      expect(provider("codex").isCurrent(makeCfg())).toBe(false);
    });

    it("stays current with Dosu switched off or its tools filtered", () => {
      provider("codex").install(makeCfg(), true);
      const written = readFileSync(path(), "utf-8");
      writeFileSync(
        path(),
        written.replace(
          "[mcp_servers.dosu]\n",
          '[mcp_servers.dosu]\nenabled = false\ndisabled_tools = ["x"]\ntool_timeout_sec = 60\n',
        ),
      );

      expect(provider("codex").isCurrent(makeCfg())).toBe(true);
    });

    it("is still not current without omit_tools_from when Dosu is switched off", () => {
      provider("codex").install(makeCfg(), true);
      const written = readFileSync(path(), "utf-8").replace(/^omit_tools_from = .*\n/m, "");
      writeFileSync(
        path(),
        written.replace("[mcp_servers.dosu]\n", "[mcp_servers.dosu]\nenabled = false\n"),
      );

      expect(provider("codex").isCurrent(makeCfg())).toBe(false);
    });

    it("stays current with saved tool approvals and a multi-line tool filter", () => {
      provider("codex").install(makeCfg(), true);
      const rootKeys =
        'default_tools_approval_mode = "prompt"\ntools.list.approval_mode = "approve"\n' +
        'enabled_tools = [\n  "search",\n  "read",\n]\n';
      const approval = '[mcp_servers.dosu.tools.search]\napproval_mode = "approve"\n';
      const written = readFileSync(path(), "utf-8");
      const withSettings = written.replace(
        "[mcp_servers.dosu]\n",
        `[mcp_servers.dosu]\n${rootKeys}`,
      );
      writeFileSync(path(), `${withSettings}\n${approval}`);

      expect(provider("codex").isCurrent(makeCfg())).toBe(true);
    });

    it("skips blank lines and comments inside the entry", () => {
      provider("codex").install(makeCfg(), true);
      const written = readFileSync(path(), "utf-8");
      writeFileSync(path(), written.replace("[mcp_servers.dosu]\n", "[mcp_servers.dosu]\n# n\n\n"));

      expect(provider("codex").isCurrent(makeCfg())).toBe(true);
    });
  });

  it("Zed: a leftover entry in the legacy settings file", async () => {
    const { ZedProvider } = await import("./zed");
    const legacy = join(home, "legacy-zed.json");
    const zed = ZedProvider(legacy);
    zed.install(makeCfg(), true);
    expect(zed.isCurrent(makeCfg())).toBe(true);

    saveJSONConfig(legacy, { context_servers: { dosu: { url: "old" } } });

    expect(zed.isCurrent(makeCfg())).toBe(false);
  });
});
