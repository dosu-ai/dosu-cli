import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseJSONC } from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/config";
import { makeTestConfig } from "../../config/config.test-utils";
import { VERSION } from "../../version/version";
import { ownedProjectProxyOptionsFromEntry, type ProjectProxyOptions } from "../project-proxy";
import type { SetupProvider } from "../providers";
import { CodexProvider } from "./codex";
import { CopilotProvider } from "./copilot";
import { CursorProvider } from "./cursor";
import { MCPorterProvider } from "./mcporter";

const HISTORICAL_VERSION = "0.42.0";

type ProjectProviderCase = {
  id: "cursor" | "codex" | "copilot" | "mcporter";
  create: () => SetupProvider;
  relativePath: string;
};

const PROJECT_PROVIDERS: ProjectProviderCase[] = [
  { id: "cursor", create: CursorProvider, relativePath: ".cursor/mcp.json" },
  { id: "codex", create: CodexProvider, relativePath: ".codex/config.toml" },
  { id: "copilot", create: CopilotProvider, relativePath: ".mcp.json" },
  { id: "mcporter", create: MCPorterProvider, relativePath: "config/mcporter.json" },
];

function cloudConfig(deploymentID: string): Config {
  return makeTestConfig({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Date.now() + 60_000,
    deployment_id: deploymentID,
    deployment_name: deploymentID,
    api_key: `key-for-${deploymentID}`,
    mcp_endpoint: `https://api.dosu.dev/v1/mcp/deployments/${deploymentID}`,
  });
}

function ossConfig(): Config {
  return makeTestConfig({
    access_token: "access",
    refresh_token: "refresh",
    expires_at: Date.now() + 60_000,
    mode: "oss",
    api_key: "key-for-oss",
    mcp_endpoint: "https://api.dosu.dev/v1/mcp",
  });
}

function proxyArgs(target: ProjectProxyOptions, packageVersion = HISTORICAL_VERSION): string[] {
  const prefix = ["-y", `@dosu/cli@${packageVersion}`, "mcp", "proxy"];
  return target.oss
    ? [...prefix, "--oss"]
    : [...prefix, "--deployment", target.deploymentID as string];
}

function historicalFixture(id: ProjectProviderCase["id"], target: ProjectProxyOptions): string {
  const args = proxyArgs(target);
  if (id !== "codex") {
    const entry = {
      ...(id === "cursor" || id === "copilot" ? { type: "stdio" } : {}),
      command: "npx",
      args,
    };
    return `{
  // unrelated project setting: preserve this comment
  "mcpServers": {
    "other": { "command": "other-server", "args": [] },
    "dosu": ${JSON.stringify(entry)}
  },
  "userSetting": "preserve-me"
}
`;
  }

  return `# unrelated project setting: preserve this comment
model = "preserve-me"

[mcp_servers.other]
command = "other-server"
args = []

[mcp_servers.dosu]
command = "npx"
args = ${JSON.stringify(args)}
`;
}

function writeHistoricalFixture(
  providerCase: ProjectProviderCase,
  projectRoot: string,
  target: ProjectProxyOptions,
): string {
  const path = join(projectRoot, providerCase.relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const content = historicalFixture(providerCase.id, target);
  writeFileSync(path, content);
  return content;
}

function readEntry(providerCase: ProjectProviderCase, projectRoot: string): unknown {
  const path = join(projectRoot, providerCase.relativePath);
  if (providerCase.id !== "codex") {
    const parsed = parseJSONC(readFileSync(path, "utf8")) as {
      mcpServers?: { dosu?: unknown };
    };
    return parsed.mcpServers?.dosu;
  }
  const parsed = parseToml(readFileSync(path, "utf8")) as {
    mcp_servers?: { dosu?: unknown };
  };
  return parsed.mcp_servers?.dosu;
}

function expectCurrentTarget(
  providerCase: ProjectProviderCase,
  projectRoot: string,
  expected: ProjectProxyOptions,
): void {
  const path = join(projectRoot, providerCase.relativePath);
  const raw = readFileSync(path, "utf8");
  expect(raw).toContain(`@dosu/cli@${VERSION}`);
  expect(raw).toContain("unrelated project setting: preserve this comment");
  expect(raw).toContain("preserve-me");
  expect(ownedProjectProxyOptionsFromEntry(readEntry(providerCase, projectRoot))).toEqual(expected);
}

let tempDir: string;
let projectRoot: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-project-retarget-"));
  projectRoot = join(tempDir, "repo");
  mkdirSync(projectRoot, { recursive: true });
  originalEnv = { ...process.env };
  process.env.HOME = join(tempDir, "home");
  process.env.XDG_CONFIG_HOME = join(tempDir, "xdg");
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

describe.each(PROJECT_PROVIDERS)("$id project target safety", (providerCase) => {
  it("recognizes an exact project proxy emitted by a historical CLI version", () => {
    const provider = providerCase.create();
    writeHistoricalFixture(providerCase, projectRoot, { deploymentID: "deployment-a" });

    expect(provider.isProjectConfigured(projectRoot)).toBe(true);
  });

  it("refreshes a historical proxy for the same deployment without retarget permission", () => {
    const provider = providerCase.create();
    writeHistoricalFixture(providerCase, projectRoot, { deploymentID: "deployment-a" });

    provider.install(cloudConfig("deployment-a"), false, { projectRoot });

    expectCurrentTarget(providerCase, projectRoot, { deploymentID: "deployment-a" });
  });

  it("preserves every byte when a different deployment is not explicitly authorized", () => {
    const provider = providerCase.create();
    const original = writeHistoricalFixture(providerCase, projectRoot, {
      deploymentID: "deployment-a",
    });
    const path = join(projectRoot, providerCase.relativePath);

    expect(() => provider.install(cloudConfig("deployment-b"), false, { projectRoot })).toThrow(
      /retarget/i,
    );
    expect(readFileSync(path, "utf8")).toBe(original);

    provider.install(cloudConfig("deployment-b"), false, {
      projectRoot,
      allowProjectRetarget: true,
    });
    expectCurrentTarget(providerCase, projectRoot, { deploymentID: "deployment-b" });
  });

  it.each([
    {
      label: "cloud to OSS",
      existing: { deploymentID: "deployment-a" } as ProjectProxyOptions,
      desiredConfig: ossConfig,
      expected: { oss: true } as ProjectProxyOptions,
    },
    {
      label: "OSS to cloud",
      existing: { oss: true } as ProjectProxyOptions,
      desiredConfig: () => cloudConfig("deployment-a"),
      expected: { deploymentID: "deployment-a" } as ProjectProxyOptions,
    },
  ])("requires explicit retarget permission for $label", ({
    existing,
    desiredConfig,
    expected,
  }) => {
    const provider = providerCase.create();
    const original = writeHistoricalFixture(providerCase, projectRoot, existing);
    const path = join(projectRoot, providerCase.relativePath);

    expect(() => provider.install(desiredConfig(), false, { projectRoot })).toThrow(/retarget/i);
    expect(readFileSync(path, "utf8")).toBe(original);

    provider.install(desiredConfig(), false, { projectRoot, allowProjectRetarget: true });
    expectCurrentTarget(providerCase, projectRoot, expected);
  });
});
