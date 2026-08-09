import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProjectProof,
  type ProjectProof,
  proveProjectScope,
  resolveProjectProof,
} from "./project-proof";
import { resolveLegacyTargets } from "./targets";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("strict project proof", () => {
  it("returns an opaque proof only for a non-bare Git worktree containing cwd", () => {
    const result = proveProjectScope({
      cwd: "/repo/packages/app",
      gitTopLevel: "/repo",
      insideWorkTree: true,
      bareRepository: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proof.root).toBe(resolve("/repo"));
      expect(result.proof.cwd).toBe(resolve("/repo/packages/app"));
    }
  });

  it("rejects non-worktrees, bare repositories, and roots that do not contain cwd", () => {
    expect(
      proveProjectScope({
        cwd: "/tmp",
        gitTopLevel: "/repo",
        insideWorkTree: false,
        bareRepository: false,
      }),
    ).toMatchObject({ ok: false, reason: "not_git_worktree" });
    expect(
      proveProjectScope({
        cwd: "/repo",
        gitTopLevel: "/repo",
        insideWorkTree: true,
        bareRepository: true,
      }),
    ).toMatchObject({ ok: false, reason: "bare_repository" });
    expect(
      proveProjectScope({
        cwd: "/other/repo-copy",
        gitTopLevel: "/repo",
        insideWorkTree: true,
        bareRepository: false,
      }),
    ).toMatchObject({ ok: false, reason: "cwd_outside_project" });
  });

  it("resolves a real nested Git worktree and rejects a missing directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dosu-project-proof-"));
    temporaryRoots.push(root);
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q", root]);

    const result = resolveProjectProof(nested);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.proof.root).toBe(realpathSync(root));
      expect(result.proof.cwd).toBe(realpathSync(nested));
      expect(() => assertProjectProof(result.proof)).not.toThrow();
    }
    expect(resolveProjectProof(join(root, "missing"))).toEqual({
      ok: false,
      reason: "git_probe_failed",
    });
  });

  it("does not accept a structurally forged project proof", () => {
    expect(() => assertProjectProof({ root: "/repo", cwd: "/repo" } as ProjectProof)).toThrow(
      /verified project proof/i,
    );
  });
});

describe("platform-aware legacy target resolver", () => {
  it("resolves macOS app support, overrides, shared rules, and all published providers", () => {
    const result = resolveLegacyTargets(
      [
        "claude",
        "claude-desktop",
        "vscode",
        "codex",
        "gemini",
        "antigravity",
        "cline",
        "cline-cli",
        "mcporter",
      ],
      {
        platform: "darwin",
        homeDir: "/Users/tester",
        env: {
          CLAUDE_CONFIG_DIR: "/custom/claude",
          CODEX_HOME: "/custom/codex",
          CLINE_DIR: "/custom/cline",
        },
      },
    );

    expect(result.warnings).toEqual([]);
    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/Users/tester/.claude.json", kind: "json_mcp" }),
        expect.objectContaining({
          path: "/Users/tester/Library/Application Support/Claude/claude_desktop_config.json",
        }),
        expect.objectContaining({
          path: "/Users/tester/Library/Application Support/Code/User/mcp.json",
          topKey: "servers",
        }),
        expect.objectContaining({ path: "/custom/codex/config.toml", kind: "codex_toml" }),
        expect.objectContaining({ path: "/custom/claude/rules/dosu.md", kind: "rule_file" }),
        expect.objectContaining({ path: "/custom/codex/AGENTS.md", kind: "rule_section" }),
        expect.objectContaining({ path: "/custom/cline/data/settings/cline_mcp_settings.json" }),
        expect.objectContaining({ path: "/Users/tester/.mcporter/mcporter.json" }),
        expect.objectContaining({ path: "/Users/tester/.mcporter/mcporter.jsonc" }),
      ]),
    );

    const sharedGeminiRules = result.targets.filter(
      (target) =>
        target.kind === "rule_section" && target.path === "/Users/tester/.gemini/GEMINI.md",
    );
    expect(sharedGeminiRules).toHaveLength(1);
    expect(sharedGeminiRules[0]).toMatchObject({
      requiredProviders: ["gemini", "antigravity"],
    });
  });

  it("resolves Linux XDG paths and the released Copilot XDG path", () => {
    const result = resolveLegacyTargets(["vscode", "zed", "copilot", "opencode"], {
      platform: "linux",
      homeDir: "/home/tester",
      env: { XDG_CONFIG_HOME: "/xdg/config" },
    });
    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join("/xdg/config", "Code", "User", "mcp.json") }),
        expect.objectContaining({ path: join("/xdg/config", "zed", "settings.json") }),
        expect.objectContaining({ path: "/xdg/config/mcp-config.json" }),
        expect.objectContaining({ path: "/home/tester/.config/opencode/opencode.json" }),
      ]),
    );
  });

  it("requires only effective consumers for the shared Gemini rule", () => {
    const environment = {
      platform: "linux" as const,
      homeDir: "/home/tester",
      env: {},
    };
    const geminiOnly = resolveLegacyTargets(["gemini"], environment).targets.find(
      (target) => target.kind === "rule_section",
    );
    const antigravityOnly = resolveLegacyTargets(["antigravity"], environment).targets.find(
      (target) => target.kind === "rule_section",
    );
    expect(geminiOnly?.requiredProviders).toEqual(["gemini"]);
    expect(antigravityOnly?.requiredProviders).toEqual(["antigravity"]);
  });

  it("resolves Windows APPDATA and warns rather than inventing it when missing", () => {
    const found = resolveLegacyTargets(["vscode", "cline"], {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
    });
    expect(found.targets.some((target) => target.path.includes("AppData"))).toBe(true);

    const missing = resolveLegacyTargets(["vscode", "cline"], {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {},
    });
    expect(missing.targets).toEqual([]);
    expect(missing.warnings).toContain("APPDATA is unavailable; preserving VS Code/Cline targets");
  });

  it("never turns relative environment overrides into cleanup targets", () => {
    const result = resolveLegacyTargets(["claude", "codex", "cline-cli", "copilot"], {
      platform: "linux",
      homeDir: "/home/tester",
      env: {
        CLAUDE_CONFIG_DIR: "relative-claude",
        CODEX_HOME: "relative-codex",
        CLINE_DIR: "relative-cline",
        XDG_CONFIG_HOME: "relative-xdg",
      },
    });
    expect(result.targets).toEqual([
      expect.objectContaining({ id: "claude:mcp", path: "/home/tester/.claude.json" }),
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CLAUDE_CONFIG_DIR"),
        expect.stringContaining("CODEX_HOME"),
        expect.stringContaining("CLINE_DIR"),
        expect.stringContaining("XDG_CONFIG_HOME"),
      ]),
    );
  });

  it("preserves everything when the home directory itself is relative", () => {
    expect(
      resolveLegacyTargets(["claude", "cursor"], {
        platform: "linux",
        homeDir: "relative-home",
        env: {},
      }),
    ).toEqual({
      targets: [],
      warnings: ["Home directory is not absolute; preserving every legacy target"],
    });
  });

  it("covers every direct-path provider and deduplicates repeated requests", () => {
    const result = resolveLegacyTargets(["cursor", "windsurf", "factory", "manual", "cursor"], {
      platform: "linux",
      homeDir: "/home/tester",
      env: {},
    });
    expect(result.warnings).toEqual([]);
    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cursor:mcp", path: "/home/tester/.cursor/mcp.json" }),
        expect.objectContaining({ id: "cursor:rule", ruleKind: "cursor" }),
        expect.objectContaining({
          id: "windsurf:mcp",
          path: "/home/tester/.codeium/windsurf/mcp_config.json",
        }),
        expect.objectContaining({ id: "factory:mcp", path: "/home/tester/.factory/mcp.json" }),
      ]),
    );
    expect(result.targets.filter((target) => target.id === "cursor:mcp")).toHaveLength(1);
  });

  it("uses documented defaults when optional Linux overrides are absent", () => {
    const result = resolveLegacyTargets(
      ["claude", "codex", "cline-cli", "copilot", "vscode", "zed"],
      { platform: "linux", homeDir: "/home/tester", env: {} },
    );
    expect(result.warnings).toEqual([]);
    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/home/tester/.claude/rules/dosu.md" }),
        expect.objectContaining({ path: "/home/tester/.codex/config.toml" }),
        expect.objectContaining({
          path: "/home/tester/.cline/data/settings/cline_mcp_settings.json",
        }),
        expect.objectContaining({ path: "/home/tester/.copilot/mcp-config.json" }),
        expect.objectContaining({ path: "/home/tester/.config/Code/User/mcp.json" }),
        expect.objectContaining({ path: "/home/tester/.config/zed/settings.json" }),
      ]),
    );
  });

  it("warns separately for Windows products whose APPDATA target cannot be proven", () => {
    const result = resolveLegacyTargets(["claude-desktop", "zed"], {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {},
    });
    expect(result.targets).toEqual([]);
    expect(result.warnings).toEqual([
      "APPDATA is unavailable; preserving Claude Desktop target",
      "APPDATA is unavailable; preserving Zed target",
    ]);
  });
});
