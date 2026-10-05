/** Every provider's Dosu entry runs the local proxy, `dosu mcp serve --client <agent>`, with the
 * Dosu install doing the writing; providers-install.test.ts covers the forms written when that is
 * a package runner's throwaway copy. */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../config/config";
import { makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig } from "../config-helpers";
import { allSetupProviders, getProvider, type SetupProvider } from "../providers";
import { refreshConfiguredProviders } from "../refresh";
import {
  restoreRunningInstall,
  stubRunningFromNpx,
  stubRunningInstall,
  testRuntime,
} from "../running-install.test-utils";

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
  stubRunningInstall({ execPath: dosu });
  pathEnv = `${bin}:/usr/bin:/bin`;
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", bin);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLINE_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreRunningInstall();
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

/** What pi's built-in MCP is asked to run once a session starts in `cwd`: pi has no MCP entry of
 * Dosu's in a config file; the Dosu pi extension the provider installs registers it. */
async function piRegistration(cwd: string): Promise<unknown> {
  const extension = setupProvider("pi").globalConfigPath();
  const { default: load } = await import(`${pathToFileURL(extension).href}?t=${Date.now()}`);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const servers = new Map<string, unknown>();
  load({
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
    registerMcpServer: (name: string, config: unknown) => servers.set(name, config),
    getActiveTools: () => [],
    setActiveTools: () => {},
  });
  handlers.get("session_start")?.(
    { reason: "startup" },
    { cwd, sessionManager: { getSessionId: () => "s-1", getEntries: () => [] } },
  );
  return servers.get("dosu");
}

describe("stdio proxy entries", () => {
  it.each(JSON_PROVIDERS)("$id runs `dosu mcp serve` for itself", ({ id, key, entry }) => {
    const provider = setupProvider(id);
    provider.install(makeCfg(), true);

    const written = loadJSONConfig(provider.globalConfigPath())[key].dosu;
    expect(written).toEqual(entry(clientOf(id)));
  });

  it("Pi runs the same proxy, registered with pi's built-in MCP for each session", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    setupProvider("pi").install(makeCfg(), true);

    expect(await piRegistration(home)).toEqual({
      ...proxy("pi"),
      cwd: home,
      exposure: "direct",
      description: expect.any(String),
    });
  });

  it("covers every provider that writes a config file", () => {
    const covered = new Set([...JSON_PROVIDERS.map((p) => p.id), "codex", "pi"]);
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
    stubRunningInstall({ execPath: "/opt/bun/bin/bun", script: "/src/dosu-cli/src/index.ts" });
    vi.stubEnv("DOSU_DEV", "true");
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "http://localhost:7001");
    getProvider("cursor").install(makeCfg(), true);

    const entry = loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu;
    expect(entry.command).toBe("/opt/bun/bin/bun");
    expect(entry.args).toEqual([
      "/src/dosu-cli/src/index.ts",
      "mcp",
      "serve",
      "--client",
      "cursor",
    ]);
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

  it("refresh moves pi from the extension's own memory tools to the proxy", async () => {
    // The extension before pi had built-in MCP: tools that shelled out to `dosu memory`.
    const extension = join(home, ".pi", "agent", "extensions", "dosu.ts");
    mkdirSync(dirname(extension), { recursive: true });
    writeFileSync(
      extension,
      "// dosu:pi-extension v1\nexport default function (pi) {\n" +
        '  pi.registerTool({ name: "search_memory" });\n}\n',
    );

    const result = refreshConfiguredProviders(makeCfg());

    expect(result.updated.map((p) => p.id())).toEqual(["pi"]);
    expect(readFileSync(extension, "utf-8")).not.toContain("registerTool");
    expect(await piRegistration(home)).toMatchObject(proxy("pi"));
  });
});

describe("the Dosu an entry runs", () => {
  /** An executable `name` in a new directory under the test home; returns its path. */
  function program(dir: string, name: string, body: string): string {
    mkdirSync(join(home, dir), { recursive: true });
    const path = join(home, dir, name);
    writeFileSync(path, body, { mode: 0o755 });
    return path;
  }

  function link(target: string, dir: string, name: string): string {
    mkdirSync(join(home, dir), { recursive: true });
    const path = join(home, dir, name);
    symlinkSync(target, path);
    return path;
  }

  function cursorEntry() {
    getProvider("cursor").install(makeCfg(), true);
    return loadJSONConfig(join(home, ".cursor", "mcp.json")).mcpServers.dosu;
  }

  it("runs a compiled install through the PATH link that reaches it, not its versioned file", () => {
    // Homebrew: `dosu` on PATH links to the Cellar binary, the path Bun reports as execPath,
    // which the next `brew upgrade` deletes.
    const cellar = program("Cellar/dosu/1.0.0/bin", "dosu", "#!/bin/sh\n");
    const brewBin = dirname(link(cellar, "brew/bin", "dosu"));
    const git = program("git/bin", "git", "#!/bin/sh\n");
    vi.stubEnv("PATH", `${brewBin}:${dirname(git)}`);
    stubRunningInstall({ execPath: cellar });

    expect(cursorEntry()).toEqual({
      command: join(brewBin, "dosu"),
      args: ["mcp", "serve", "--client", "cursor"],
      env: { PATH: `${brewBin}:${dirname(git)}:/usr/bin:/bin` },
    });
  });

  it("runs the install doing the writing, not an older dosu earlier on PATH", () => {
    const old = program("old/bin", "dosu", "#!/bin/sh\necho \"error: unknown command 'serve'\"\n");
    const current = program("new/bin", "dosu", "#!/bin/sh\n");
    stubRunningInstall({ execPath: current });

    vi.stubEnv("PATH", `${dirname(old)}:${dirname(current)}`);
    expect(cursorEntry().command).toBe(current);

    vi.stubEnv("PATH", dirname(old));
    expect(cursorEntry().command).toBe(current);
  });

  it("starts the npm package with node by absolute path, with the git the installing shell had", () => {
    // A global install whose bin dir has no node beside it (Yarn, pnpm, a custom npm prefix):
    // the script's `#!/usr/bin/env node` finds nothing on a PATH of that dir plus the system dirs.
    const script = program(
      "lib/node_modules/@dosu/cli/bin",
      "dosu.js",
      "#!/usr/bin/env node\n" +
        'const { spawnSync } = require("node:child_process");\n' +
        'const git = spawnSync("git", ["--version"], { encoding: "utf-8" });\n' +
        "console.log(JSON.stringify({ args: process.argv.slice(2), git: git.stdout?.trim() }));\n",
    );
    const bin = link(script, "yarn/bin", "dosu");
    const node = link(testRuntime, "node/bin", "node");
    const git = program("git/bin", "git", "#!/bin/sh\necho fake-git 9.9\n");
    vi.stubEnv("PATH", [dirname(bin), dirname(node), dirname(git)].join(":"));
    // Node reports its own file, resolved: Homebrew's Cellar copy rather than bin/node.
    stubRunningInstall({ execPath: realpathSync(testRuntime), script: bin });

    getProvider("claude").install(makeCfg(), true);
    const entry = loadJSONConfig(join(home, ".claude.json")).mcpServers.dosu;

    expect(entry.command).toBe(node);
    expect(entry.args).toEqual([bin, "mcp", "serve", "--client", "claude-code"]);
    // What the agent does with the entry: run it with the entry's own environment.
    const run = spawnSync(entry.command, entry.args, {
      env: { HOME: home, ...entry.env },
      encoding: "utf-8",
      timeout: 20_000,
    });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({
      args: ["mcp", "serve", "--client", "claude-code"],
      git: "fake-git 9.9",
    });
  });

  it.each([
    ["npx", ".npm/_npx/0123abcd/node_modules/.bin"],
    ["bunx", "tmp/bunx-501-@dosu/cli@latest/node_modules/.bin"],
    ["pnpm dlx", ".cache/pnpm/dlx/0123abcd/node_modules/.bin"],
    ["yarn dlx", "tmp/xfs-0123abcd/dlx-4242/node_modules/.bin"],
  ])("writes the remote entry when %s runs a throwaway copy", (_runner, dir) => {
    // The runner puts its copy's bin dir first on PATH while it runs.
    const script = program(dir, "dosu", "#!/usr/bin/env node\n");
    vi.stubEnv("PATH", `${dirname(script)}:${dirname(dosu)}`);
    stubRunningInstall({ execPath: process.execPath, script });

    expect(cursorEntry()).toEqual(
      expect.objectContaining({
        url: expect.stringContaining("dep-123"),
        headers: expect.any(Object),
      }),
    );
  });

  it("writes the remote entry from the shared npx helper's install, as other tests rely on", () => {
    stubRunningFromNpx(home);
    expect(cursorEntry().command).toBeUndefined();
  });
});
