import {
  existsSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJSONServer } from "../mcp/config-helpers";
import type { SetupProvider } from "../mcp/providers";
import {
  FALLBACK_DOSU_RULE,
  GLOBAL_DOSU_SKILLS_GUIDANCE,
  rulePathForAgent,
} from "../rules/installer";
import {
  cleanupLegacyGlobalMcp,
  cleanupLegacyGlobalRule,
  reconcileLegacyGlobalSetup,
} from "./legacy-global-cleanup";

let tempDir: string;
let originalHome: string | undefined;
let originalClaudeConfigDir: string | undefined;
let originalCodexHome: string | undefined;

function makeProvider(
  id: string,
  globalPath: string,
  options: { projectConfigured?: boolean; globalConfigured?: boolean } = {},
): SetupProvider {
  return {
    id: () => id,
    name: () => id,
    configurationKind: () => "project",
    install() {},
    remove() {},
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => options.globalConfigured ?? existsSync(globalPath),
    globalConfigPath: () => globalPath,
    projectConfigPath: (root) => join(root, `.${id}`, "mcp.json"),
    isProjectConfigured: () => options.projectConfigured ?? true,
    priority: () => 0,
  };
}

function legacyMcpEntry() {
  return {
    type: "http",
    url: "https://api.dosu.dev/v1/mcp/deployments/dep-123",
    headers: { "X-Dosu-API-Key": "old-key" },
  };
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function releasedRule(): string {
  return FALLBACK_DOSU_RULE.replace(`\n${GLOBAL_DOSU_SKILLS_GUIDANCE}\n`, "");
}

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-legacy-reconcile-")));
  originalHome = process.env.HOME;
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tempDir;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, ".claude");
  process.env.CODEX_HOME = join(tempDir, ".codex");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("cleanupLegacyGlobalMcp", () => {
  it("removes only an exact released entry and preserves unrelated entries", () => {
    const path = join(tempDir, ".claude.json");
    writeJSON(path, {
      mcpServers: { dosu: legacyMcpEntry(), other: { url: "https://example.com/mcp" } },
      userSetting: true,
    });
    const provider = makeProvider("claude", path);

    expect(cleanupLegacyGlobalMcp(provider)).toMatchObject({ status: "removed" });
    expect(getJSONServer(path, "mcpServers")).toBeUndefined();
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      mcpServers: { other: { url: "https://example.com/mcp" } },
      userSetting: true,
    });
  });

  it.each([
    [
      "foreign origin",
      {
        ...legacyMcpEntry(),
        url: "https://foreign.example/v1/mcp/deployments/dep-123",
      },
    ],
    ["modified shape", { ...legacyMcpEntry(), extra: true }],
    ["same name but different command", { command: "foreign", args: ["serve"] }],
  ])("preserves a %s byte-for-byte", (_label, entry) => {
    const path = join(tempDir, ".cursor", "mcp.json");
    const original = JSON.stringify({ mcpServers: { dosu: entry } });
    writeJSON(path, JSON.parse(original));
    const bytes = readFileSync(path, "utf-8");

    expect(cleanupLegacyGlobalMcp(makeProvider("cursor", path))).toMatchObject({
      status: "preserved",
      reason: "foreign_or_modified",
    });
    expect(readFileSync(path, "utf-8")).toBe(bytes);
  });

  it("preserves malformed files and JSONC", () => {
    const malformedPath = join(tempDir, "malformed.json");
    writeFileSync(malformedPath, '{"mcpServers":{"dosu":');
    expect(cleanupLegacyGlobalMcp(makeProvider("claude", malformedPath))).toMatchObject({
      status: "preserved",
      reason: "write_failed",
    });
    expect(readFileSync(malformedPath, "utf-8")).toBe('{"mcpServers":{"dosu":');

    const jsoncPath = join(tempDir, "mcporter.jsonc");
    const jsonc = `// user comment\n${JSON.stringify({ mcpServers: { dosu: legacyMcpEntry() } })}`;
    writeFileSync(jsoncPath, jsonc);
    expect(cleanupLegacyGlobalMcp(makeProvider("mcporter", jsoncPath))).toMatchObject({
      status: "preserved",
      reason: "shared_or_unsupported",
    });
    expect(readFileSync(jsoncPath, "utf-8")).toBe(jsonc);
  });

  it.each(["final", "parent"])("does not follow a %s symlink", (kind) => {
    const realDirectory = join(tempDir, "real");
    const target = join(realDirectory, "config.json");
    mkdirSync(realDirectory);
    writeJSON(target, { mcpServers: { dosu: legacyMcpEntry() } });
    let path: string;
    if (kind === "final") {
      path = join(tempDir, "linked.json");
      symlinkSync(target, path);
    } else {
      const linkedDirectory = join(tempDir, "linked");
      symlinkSync(realDirectory, linkedDirectory);
      path = join(linkedDirectory, "config.json");
    }

    expect(cleanupLegacyGlobalMcp(makeProvider("claude", path))).toMatchObject({
      status: "preserved",
      reason: "symlink_or_non_file",
    });
    expect(getJSONServer(target, "mcpServers")).toEqual(legacyMcpEntry());
  });

  it("preserves known shared provider configs", () => {
    const path = join(tempDir, ".gemini", "settings.json");
    writeJSON(path, { mcpServers: { dosu: legacyMcpEntry() } });

    expect(cleanupLegacyGlobalMcp(makeProvider("gemini", path))).toMatchObject({
      status: "preserved",
      reason: "shared_or_unsupported",
    });
    expect(getJSONServer(path, "mcpServers")).toEqual(legacyMcpEntry());
  });

  it("reports absent supported and unsupported global MCP config without creating files", () => {
    const supportedPath = join(tempDir, "missing-claude.json");
    expect(cleanupLegacyGlobalMcp(makeProvider("claude", supportedPath))).toMatchObject({
      status: "not_found",
    });

    const unsupportedPath = join(tempDir, "missing-gemini.json");
    expect(cleanupLegacyGlobalMcp(makeProvider("gemini", unsupportedPath))).toMatchObject({
      status: "not_found",
    });

    const throwing = makeProvider("unknown-agent", join(tempDir, "unknown.json"));
    throwing.isConfigured = () => {
      throw new Error("unreadable global config");
    };
    expect(cleanupLegacyGlobalMcp(throwing)).toMatchObject({ status: "not_found" });
    expect(existsSync(supportedPath)).toBe(false);
    expect(existsSync(unsupportedPath)).toBe(false);
  });

  it("treats a supported global file without a Dosu entry as not found", () => {
    const path = join(tempDir, ".claude.json");
    writeJSON(path, { mcpServers: { other: { command: "other" } } });

    expect(cleanupLegacyGlobalMcp(makeProvider("claude", path))).toMatchObject({
      status: "not_found",
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
      mcpServers: { other: { command: "other" } },
    });
  });
});

describe("cleanupLegacyGlobalRule", () => {
  it.each([
    ["claude", ""],
    ["cursor", "---\nalwaysApply: true\n---\n\n"],
  ])("deletes the exact released standalone %s rule", (agent, prefix) => {
    const path = rulePathForAgent(agent) ?? "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${prefix}${releasedRule()}`);

    expect(cleanupLegacyGlobalRule(agent)).toMatchObject({ status: "removed" });
    expect(existsSync(path)).toBe(false);
  });

  it("preserves a user-modified standalone rule", () => {
    const path = rulePathForAgent("claude") ?? "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${releasedRule()}\nUser addition\n`);
    const original = readFileSync(path, "utf-8");

    expect(cleanupLegacyGlobalRule("claude")).toMatchObject({
      status: "preserved",
      reason: "foreign_or_modified",
    });
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("removes one Codex marker section and preserves surrounding instructions", () => {
    const path = rulePathForAgent("codex") ?? "";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      "# User\n\n<!-- dosu:rules:start v1 -->\nlegacy\n<!-- dosu:rules:end -->\n",
    );

    expect(cleanupLegacyGlobalRule("codex")).toMatchObject({ status: "removed" });
    expect(readFileSync(path, "utf-8")).toBe("# User\n");
  });

  it("preserves duplicate marker sections and the shared Gemini rule", () => {
    const codexPath = rulePathForAgent("codex") ?? "";
    mkdirSync(dirname(codexPath), { recursive: true });
    const section = "<!-- dosu:rules:start v1 -->\nlegacy\n<!-- dosu:rules:end -->\n";
    writeFileSync(codexPath, `${section}${section}`);
    expect(cleanupLegacyGlobalRule("codex")).toMatchObject({
      status: "preserved",
      reason: "foreign_or_modified",
    });

    const geminiPath = rulePathForAgent("gemini") ?? "";
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(geminiPath, section);
    expect(cleanupLegacyGlobalRule("gemini")).toMatchObject({
      status: "preserved",
      reason: "shared_or_unsupported",
    });
  });

  it("reports missing rule paths and marker sections without writing", () => {
    expect(cleanupLegacyGlobalRule("unknown-agent")).toBeNull();

    const codexPath = rulePathForAgent("codex") ?? "";
    expect(cleanupLegacyGlobalRule("codex")).toMatchObject({ status: "not_found" });
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, "# User-owned instructions\n");
    expect(cleanupLegacyGlobalRule("codex")).toMatchObject({ status: "not_found" });

    const geminiPath = rulePathForAgent("gemini") ?? "";
    mkdirSync(dirname(geminiPath), { recursive: true });
    writeFileSync(geminiPath, "# User-owned Gemini instructions\n");
    expect(cleanupLegacyGlobalRule("gemini")).toMatchObject({ status: "not_found" });
  });

  it("preserves a symlinked marker rule", () => {
    const path = rulePathForAgent("codex") ?? "";
    const target = join(tempDir, "real-codex-agents.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(target, "<!-- dosu:rules:start v1 -->\nlegacy\n<!-- dosu:rules:end -->\n");
    symlinkSync(target, path);

    expect(cleanupLegacyGlobalRule("codex")).toMatchObject({
      status: "preserved",
      reason: "symlink_or_non_file",
    });
    expect(readFileSync(target, "utf-8")).toContain("legacy");
  });
});

describe("reconcileLegacyGlobalSetup", () => {
  it("runs only after the selected project provider verifies and is idempotent", () => {
    const path = join(tempDir, ".claude.json");
    writeJSON(path, { mcpServers: { dosu: legacyMcpEntry() } });
    const unverified = makeProvider("claude", path, { projectConfigured: false });

    const blocked = reconcileLegacyGlobalSetup([unverified], tempDir, [unverified]);
    expect(blocked.preserved).toEqual([
      expect.objectContaining({ reason: "project_not_verified" }),
    ]);
    expect(getJSONServer(path, "mcpServers")).toEqual(legacyMcpEntry());

    const verified = makeProvider("claude", path);
    expect(reconcileLegacyGlobalSetup([verified], tempDir, [verified]).removed).toEqual([
      expect.objectContaining({ providerID: "claude", component: "mcp" }),
    ]);
    expect(reconcileLegacyGlobalSetup([verified], tempDir, [verified]).removed).toEqual([]);
  });

  it("reports but preserves unselected unsupported config, skills, hooks, and plugins", () => {
    const selectedPath = join(tempDir, ".claude.json");
    writeJSON(selectedPath, { mcpServers: { dosu: legacyMcpEntry() } });
    const selected = makeProvider("claude", selectedPath);
    const unsupportedPath = join(tempDir, ".windsurf", "mcp.json");
    writeJSON(unsupportedPath, { mcpServers: { dosu: legacyMcpEntry() } });
    const unsupported = makeProvider("windsurf", unsupportedPath, { globalConfigured: true });

    const skill = join(tempDir, ".agents", "skills", "dosu", "SKILL.md");
    const hook = join(tempDir, ".claude", "hooks", "dosu.sh");
    const plugin = join(tempDir, ".claude", "plugins", "dosu.json");
    for (const path of [skill, hook, plugin]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "keep\n");
    }

    const report = reconcileLegacyGlobalSetup([selected], tempDir, [selected, unsupported]);

    expect(report.preserved).toEqual([
      expect.objectContaining({ providerID: "windsurf", reason: "not_selected" }),
    ]);
    expect(getJSONServer(unsupportedPath, "mcpServers")).toEqual(legacyMcpEntry());
    for (const path of [skill, hook, plugin]) expect(readFileSync(path, "utf-8")).toBe("keep\n");
  });

  it("does not invent cleanup outcomes for selected agents without a rule or inactive globals", () => {
    const selected = makeProvider("windsurf", join(tempDir, "missing-windsurf.json"));
    const inactive = makeProvider("gemini", join(tempDir, "missing-gemini.json"), {
      globalConfigured: false,
    });

    const report = reconcileLegacyGlobalSetup([selected], tempDir, [selected, inactive]);

    expect(report.outcomes).toEqual([
      expect.objectContaining({ providerID: "windsurf", component: "mcp", status: "not_found" }),
    ]);
    expect(report.preserved).toEqual([]);
  });
});
