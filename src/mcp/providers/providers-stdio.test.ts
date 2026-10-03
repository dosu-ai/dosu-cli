/** Every provider's Dosu entry runs the local proxy, `dosu mcp serve --client <agent>`, when a
 * `dosu` command is on PATH; providers-install.test.ts covers the forms written without one. */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config";
import { makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig } from "../config-helpers";
import { allSetupProviders, getProvider, type SetupProvider } from "../providers";
import { refreshConfiguredProviders } from "../refresh";

let home: string;
let dosu: string;
let pathEnv: string;

function makeCfg(overrides: Partial<Parameters<typeof makeTestConfig>[0]> = {}): Config {
  return makeTestConfig({
    access_token: "at",
    refresh_token: "rt",
    expires_at: 0,
    deployment_id: "dep-123",
    api_key: "key-abc",
    ...overrides,
  });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-stdio-entries-")));
  const bin = join(home, "bin");
  mkdirSync(bin);
  dosu = join(bin, "dosu");
  writeFileSync(dosu, "#!/bin/sh\n", { mode: 0o755 });
  pathEnv = `${bin}:/usr/bin:/bin`;
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLINE_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function proxy(client: string) {
  return { command: dosu, args: ["mcp", "serve", "--client", client], env: { PATH: pathEnv } };
}

/** The top-level key each JSON provider keeps its servers under. */
const JSON_PROVIDERS: Array<{ id: string; key: string; entry: (client: string) => object }> = [
  {
    id: "claude",
    key: "mcpServers",
    entry: (c) => ({ type: "stdio", ...proxy(c), alwaysLoad: true }),
  },
  { id: "claude-desktop", key: "mcpServers", entry: proxy },
  { id: "cursor", key: "mcpServers", entry: proxy },
  { id: "vscode", key: "servers", entry: (c) => ({ type: "stdio", ...proxy(c) }) },
  { id: "gemini", key: "mcpServers", entry: proxy },
  { id: "windsurf", key: "mcpServers", entry: proxy },
  { id: "zed", key: "context_servers", entry: proxy },
  {
    id: "cline",
    key: "mcpServers",
    entry: (c) => ({ type: "stdio", ...proxy(c), disabled: false }),
  },
  {
    id: "cline-cli",
    key: "mcpServers",
    entry: (c) => ({ type: "stdio", ...proxy(c), disabled: false }),
  },
  {
    id: "copilot",
    key: "mcpServers",
    entry: (c) => ({ type: "local", ...proxy(c), tools: ["*"] }),
  },
  {
    id: "opencode",
    key: "mcp",
    entry: (c) => {
      const { command, args, env } = proxy(c);
      return { type: "local", command: [command, ...args], environment: env, enabled: true };
    },
  },
  { id: "antigravity", key: "mcpServers", entry: proxy },
  { id: "mcporter", key: "mcpServers", entry: proxy },
  { id: "factory", key: "mcpServers", entry: (c) => ({ type: "stdio", ...proxy(c) }) },
];

/** The client id each agent's proxy reports: its transcripts' trajectory source where it has one. */
function clientOf(id: string): string {
  return id === "claude" ? "claude-code" : id;
}

function setupProvider(id: string): SetupProvider {
  return getProvider(id) as SetupProvider;
}

describe("stdio proxy entries", () => {
  it.each(JSON_PROVIDERS)("$id runs `dosu mcp serve` for itself", ({ id, key, entry }) => {
    const provider = setupProvider(id);
    provider.install(makeCfg(), true);

    const written = loadJSONConfig(provider.globalConfigPath())[key].dosu;
    expect(written).toEqual(entry(clientOf(id)));
  });

  it("covers every provider that writes a config file", () => {
    const covered = new Set([...JSON_PROVIDERS.map((p) => p.id), "codex"]);
    expect(
      allSetupProviders()
        .map((p) => p.id())
        .sort(),
    ).toEqual([...covered].sort());
  });

  it("Codex runs the proxy and forwards the variables that choose its config and project", () => {
    const provider = setupProvider("codex");
    provider.install(makeCfg(), true);

    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(toml).toContain(`[mcp_servers.dosu]\ncommand = "${dosu}"\n`);
    expect(toml).toContain('args = ["mcp", "serve", "--client", "codex"]\n');
    expect(toml).toContain('env_vars = ["DOSU_PROJECT", "XDG_CONFIG_HOME"]\n');
    expect(toml).toContain(`[mcp_servers.dosu.env]\nPATH = "${pathEnv}"\n`);
    expect(toml).not.toContain("mcp-remote");
    expect(toml).not.toContain("key-abc");
  });

  it("writes the same entry to a project-local config", () => {
    const cwd = process.cwd();
    process.chdir(home);
    try {
      getProvider("claude").install(makeCfg(), false);
      getProvider("cursor").install(makeCfg(), false);
      getProvider("opencode").install(makeCfg(), false);
    } finally {
      process.chdir(cwd);
    }

    expect(loadJSONConfig(join(home, ".mcp.json")).mcpServers.dosu.command).toBe(dosu);
    expect(loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu.args).toEqual(
      proxy("cursor").args,
    );
    expect(loadJSONConfig(join(home, "opencode.json")).mcp.dosu.command[0]).toBe(dosu);
  });

  it("keeps the API key out of the entry: the proxy reads it from the CLI config", () => {
    for (const { id } of JSON_PROVIDERS) setupProvider(id).install(makeCfg(), true);
    for (const { id } of JSON_PROVIDERS) {
      expect(readFileSync(setupProvider(id).globalConfigPath(), "utf-8")).not.toContain("key-abc");
    }
  });

  it("pins a backend override the entry was written under, as the URL used to be", () => {
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.staging.example");
    getProvider("cursor").install(makeCfg(), true);

    const entry = loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu;
    expect(entry.env).toEqual({
      PATH: pathEnv,
      DOSU_BACKEND_URL_OVERRIDE: "https://api.staging.example",
    });
  });

  it("runs this working copy in dev mode, with the endpoints it was set up against", () => {
    vi.stubEnv("DOSU_DEV", "true");
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "http://localhost:7001");
    getProvider("cursor").install(makeCfg(), true);

    const entry = loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu;
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([process.argv[1], "mcp", "serve", "--client", "cursor"]);
    expect(entry.env).toEqual({
      DOSU_DEV: "true",
      DOSU_BACKEND_URL_OVERRIDE: "http://localhost:7001",
    });
  });

  it("still needs an API key and a deployment, which the proxy will run with", () => {
    expect(() => getProvider("cursor").install(makeCfg({ api_key: undefined }), true)).toThrow(
      /API key/,
    );
    expect(() => getProvider("codex").install(makeCfg({ deployment_id: undefined }), true)).toThrow(
      /deployment ID/,
    );
  });

  it("OSS mode runs the same proxy", () => {
    getProvider("cursor").install(makeCfg({ mode: "oss", deployment_id: undefined }), true);

    expect(loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu).toEqual(
      proxy("cursor"),
    );
  });

  it("refresh migrates remote and mcp-remote entries to the proxy", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        numStartups: 3,
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://x/v2/mcp/deployments/d",
            headers: {},
            alwaysLoad: true,
          },
          other: { command: "x" },
        },
      }),
    );
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ mcp: { dosu: { type: "remote", url: "https://x", enabled: true } } }),
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      'model = "m"\n\n[mcp_servers.dosu]\ncommand = "/usr/bin/npx"\n' +
        'args = ["-y", "mcp-remote@0.1.38", "https://x"]\n\n' +
        '[mcp_servers.dosu.env]\nX_DOSU_API_KEY = "old"\n',
    );

    const result = refreshConfiguredProviders(makeCfg());

    expect(result.updated.map((p) => p.id()).sort()).toEqual(["claude", "codex", "opencode"]);
    const claude = loadJSONConfig(join(home, ".claude.json"));
    expect(claude.numStartups).toBe(3);
    expect(claude.mcpServers.other).toEqual({ command: "x" });
    expect(claude.mcpServers.dosu.command).toBe(dosu);
    const opencode = loadJSONConfig(join(home, ".config", "opencode", "opencode.json"));
    expect(opencode.mcp.dosu.type).toBe("local");
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(toml).toContain('model = "m"');
    expect(toml).toContain(`command = "${dosu}"`);
    expect(toml).not.toContain("mcp-remote");
    expect(toml).not.toContain("X_DOSU_API_KEY");
  });
});
