import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/config";
import { makeTestConfig } from "../../config/config.test-utils";
import { loadJSONConfig } from "../config-helpers";
import { allSetupProviders } from "../providers";

const SECRET = "project-config-must-not-contain-this-key";

function config(): Config {
  return makeTestConfig({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Date.now() + 60_000,
    deployment_id: "dep-project",
    deployment_name: "Project brain",
    api_key: SECRET,
    mcp_endpoint: "https://api.dosu.dev/v1/mcp/deployments/dep-project",
  });
}

interface JSONExpectation {
  provider: string;
  relativePath: string;
  topKey: string;
  type?: string;
  commandArray?: boolean;
}

const JSON_PROJECT_PROVIDERS: JSONExpectation[] = [
  { provider: "claude", relativePath: ".mcp.json", topKey: "mcpServers", type: "stdio" },
  { provider: "cursor", relativePath: ".cursor/mcp.json", topKey: "mcpServers", type: "stdio" },
  { provider: "vscode", relativePath: ".vscode/mcp.json", topKey: "servers", type: "stdio" },
  { provider: "gemini", relativePath: ".gemini/settings.json", topKey: "mcpServers" },
  { provider: "zed", relativePath: ".zed/settings.json", topKey: "context_servers" },
  // Claude and Copilot intentionally share the cross-client .mcp.json contract.
  { provider: "copilot", relativePath: ".mcp.json", topKey: "mcpServers", type: "stdio" },
  {
    provider: "opencode",
    relativePath: "opencode.json",
    topKey: "mcp",
    type: "local",
    commandArray: true,
  },
  { provider: "antigravity", relativePath: ".agents/mcp_config.json", topKey: "mcpServers" },
  { provider: "mcporter", relativePath: "config/mcporter.json", topKey: "mcpServers" },
  { provider: "factory", relativePath: ".factory/mcp.json", topKey: "mcpServers", type: "stdio" },
];

let tempDir: string;
let projectRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-project-providers-"));
  projectRoot = join(tempDir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  originalEnv = { ...process.env };
  process.env.HOME = join(tempDir, "home");
  process.env.XDG_CONFIG_HOME = join(tempDir, "xdg");
  process.env.APPDATA = join(tempDir, "appdata");
  process.env.CODEX_HOME = join(tempDir, "codex-home");
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, process.platform === "win32" ? "npx.cmd" : "npx"), "", {
    mode: 0o755,
  });
  process.env.PATH = binDir;
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("project-scoped MCP provider entries", () => {
  it("never falls back to an arbitrary current working directory", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");

    expect(() => provider?.install(config(), false)).toThrow(/verified project root/i);
  });

  it.each(
    JSON_PROJECT_PROVIDERS,
  )("$provider writes the official project schema without credentials", ({
    provider: id,
    relativePath,
    topKey,
    type,
    commandArray,
  }) => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === id);
    expect(provider).toBeDefined();

    const receipt = provider?.install(config(), false, { projectRoot });

    const path = join(projectRoot, relativePath);
    expect(provider?.projectConfigPath(projectRoot)).toBe(path);
    const entry = loadJSONConfig(path)[topKey].dosu;
    if (type) expect(entry.type).toBe(type);
    if (commandArray) {
      expect(entry.command).toEqual(expect.arrayContaining(["mcp", "proxy", "dep-project"]));
    } else {
      expect(entry.command).toBe("npx");
      expect(entry.args).toEqual(expect.arrayContaining(["mcp", "proxy", "dep-project"]));
    }
    const raw = readFileSync(path, "utf8");
    expect(receipt).toMatchObject({
      path,
      beforeContent: null,
      beforeMode: null,
      afterContent: raw,
      afterMode: 0o644,
    });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("X-Dosu-API-Key");
    expect(raw).not.toContain("api.dosu.dev");
    expect(provider?.isProjectConfigured(projectRoot)).toBe(true);
  });

  it("Codex writes a secretless project TOML entry", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "codex");
    const receipt = provider?.install(config(), false, { projectRoot });

    const path = join(projectRoot, ".codex", "config.toml");
    const raw = readFileSync(path, "utf8");
    expect(receipt).toMatchObject({
      path,
      beforeContent: null,
      beforeMode: null,
      afterContent: raw,
      afterMode: 0o644,
    });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(raw).toContain("[mcp_servers.dosu]");
    expect(raw).toContain('command = "npx"');
    expect(raw).toContain('"mcp", "proxy"');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("X-Dosu-API-Key");
    expect(raw).not.toContain("api.dosu.dev");
    expect(provider?.projectConfigPath(projectRoot)).toBe(path);
    expect(provider?.isProjectConfigured(projectRoot)).toBe(true);
  });

  it("Codex refuses to overwrite or remove a foreign server named dosu", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "codex");
    const path = join(projectRoot, ".codex", "config.toml");
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const foreign = '[mcp_servers.dosu]\ncommand = "my-company-server"\nargs = []\n';
    writeFileSync(path, foreign);

    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(/refusing/i);
    expect(() => provider?.remove(false, { projectRoot })).toThrow(/refusing/i);
    expect(readFileSync(path, "utf8")).toBe(foreign);
  });

  it("Codex refuses an invalid TOML document even when it contains an exact proxy table", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "codex");
    provider?.install(config(), false, { projectRoot });
    const path = join(projectRoot, ".codex", "config.toml");
    const invalid = `not valid toml !!!\n${readFileSync(path, "utf8")}`;
    writeFileSync(path, invalid);

    expect(provider?.isProjectConfigured(projectRoot)).toBe(false);
    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(/refusing/i);
    expect(readFileSync(path, "utf8")).toBe(invalid);
  });

  it("uses the explicit Git root instead of process.cwd()", () => {
    const nested = join(projectRoot, "packages", "api");
    mkdirSync(nested, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(nested);
    try {
      const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");
      provider?.install(config(), false, { projectRoot });
      expect(existsSync(join(projectRoot, ".cursor", "mcp.json"))).toBe(true);
      expect(existsSync(join(nested, ".cursor", "mcp.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it.each([
    "claude-desktop",
    "windsurf",
    "cline",
    "cline-cli",
  ])("%s remains unsupported instead of silently falling back to global", (id) => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === id);
    expect(provider?.supportsLocal()).toBe(false);
    expect(provider?.projectConfigPath(projectRoot)).toBeNull();
    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(
      /does not support project/i,
    );
  });

  it("refuses to overwrite a non-Dosu server that happens to use the dosu name", () => {
    const path = join(projectRoot, ".cursor", "mcp.json");
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { dosu: { command: "my-company-server" } } }));
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");

    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(
      /non-Dosu server named "dosu"/i,
    );
    expect(readFileSync(path, "utf8")).toContain("my-company-server");
  });

  it.each(
    JSON_PROJECT_PROVIDERS,
  )("$provider preserves a same-shaped server on a foreign origin during removal", ({
    provider: id,
    relativePath,
    topKey,
  }) => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === id);
    const path = join(projectRoot, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    const url = "https://foreign.example/v1/mcp/deployments/dep-project";
    const headers = { "X-Dosu-API-Key": "foreign-key" };
    const entry =
      id === "cursor"
        ? { url, headers }
        : id === "opencode"
          ? { type: "remote", enabled: true, url, headers }
          : id === "zed"
            ? { source: "custom", type: "http", url, headers }
            : id === "antigravity"
              ? { serverUrl: url, headers }
              : id === "copilot"
                ? { type: "http", url, tools: ["*"], headers }
                : { type: "http", url, headers };
    const original = JSON.stringify({ [topKey]: { dosu: entry, user: { command: "keep" } } });
    writeFileSync(path, original);

    expect(() => provider?.remove(false, { projectRoot })).toThrow(/refusing/i);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("Codex preserves a same-shaped HTTP server on a foreign origin during removal", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "codex");
    const path = join(projectRoot, ".codex", "config.toml");
    mkdirSync(join(projectRoot, ".codex"), { recursive: true });
    const original = `[mcp_servers.dosu]\ntype = "http"\nurl = "https://foreign.example/v1/mcp/deployments/dep-project"\n\n[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "foreign-key"\n`;
    writeFileSync(path, original);

    expect(() => provider?.remove(false, { projectRoot })).toThrow(/refusing/i);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("refuses a project MCP config symlink that could escape the repository", () => {
    const outside = join(tempDir, "outside.json");
    writeFileSync(outside, JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    symlinkSync(outside, join(projectRoot, ".cursor", "mcp.json"));
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");

    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(/symbolic link/i);
    expect(readFileSync(outside, "utf8")).toBe(JSON.stringify({ mcpServers: {} }));
  });

  it("refuses a symlinked project config directory", () => {
    const outside = join(tempDir, "outside-dir");
    mkdirSync(outside);
    symlinkSync(outside, join(projectRoot, ".cursor"));
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");

    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(/symbolic link/i);
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  });

  it("refuses duplicate JSON properties instead of guessing which value owns the file", () => {
    const path = join(projectRoot, ".cursor", "mcp.json");
    mkdirSync(join(projectRoot, ".cursor"), { recursive: true });
    writeFileSync(
      path,
      '{"mcpServers":{"dosu":{"command":"foreign"},"dosu":{"command":"foreign-2"}}}',
    );
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");

    expect(() => provider?.install(config(), false, { projectRoot })).toThrow(/duplicate/i);
  });

  it("removes a project entry without rewriting sibling JSONC bytes", () => {
    const provider = allSetupProviders().find((candidate) => candidate.id() === "cursor");
    provider?.install(config(), false, { projectRoot });
    const path = join(projectRoot, ".cursor", "mcp.json");
    const owned = loadJSONConfig(path).mcpServers.dosu;
    const before = `{
  // keep this root comment
  "mcpServers": {
    "user": {"url":"x"}, // keep this user comment
    "dosu": ${JSON.stringify(owned)}
  },
  "other": [1,2,3]
}
`;
    writeFileSync(path, before);

    provider?.remove(false, { projectRoot });

    expect(readFileSync(path, "utf8")).toBe(`{
  // keep this root comment
  "mcpServers": {
    "user": {"url":"x"} // keep this user comment
${"    "}
  },
  "other": [1,2,3]
}
`);
  });
});
