import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MINER_CORE_END, MINER_CORE_START } from "./prompt-core";
import { MINER_CORE_RULES } from "./prompt-core.generated";
import { candidateSkillPromptPaths, resolveMinerCoreRules } from "./prompt-source";

const mockReadFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ readFileSync: mockReadFileSync }));
vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const REL = join("log-to-dosu-knowledge", "references", "miner-system-prompt.md");

function skillDoc(rules: string): string {
  return `header\n${MINER_CORE_START}\n${rules}\n${MINER_CORE_END}\n`;
}

beforeEach(() => {
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => {
    throw new Error("ENOENT");
  });
});

describe("candidateSkillPromptPaths", () => {
  it("orders: DOSU_SKILL_REPO checkout, .agents, claude config, windsurf", () => {
    const paths = candidateSkillPromptPaths({
      DOSU_SKILL_REPO: "/repo/dosu-skill",
      CLAUDE_CONFIG_DIR: "/custom/claude",
    });

    expect(paths).toEqual([
      join("/repo/dosu-skill", "skills", REL),
      join(homedir(), ".agents", "skills", REL),
      join("/custom/claude", "skills", REL),
      join(homedir(), ".codeium", "windsurf", "skills", REL),
    ]);
  });

  it("defaults to ~/.claude and omits the checkout without env overrides", () => {
    const paths = candidateSkillPromptPaths({});

    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(join(homedir(), ".agents", "skills", REL));
    expect(paths[1]).toBe(join(homedir(), ".claude", "skills", REL));
  });
});

describe("resolveMinerCoreRules", () => {
  it("returns the first readable installed copy", () => {
    const claudePath = join(homedir(), ".claude", "skills", REL);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === claudePath) return skillDoc("INSTALLED RULES");
      throw new Error("ENOENT");
    });

    expect(resolveMinerCoreRules({})).toEqual({ rules: "INSTALLED RULES", source: claudePath });
  });

  it("prefers an earlier candidate over a later one", () => {
    mockReadFileSync.mockReturnValue(skillDoc("CHECKOUT RULES"));

    const resolved = resolveMinerCoreRules({ DOSU_SKILL_REPO: "/repo/dosu-skill" });

    expect(resolved.source).toBe(join("/repo/dosu-skill", "skills", REL));
    expect(resolved.rules).toBe("CHECKOUT RULES");
  });

  it("skips a copy with broken markers and keeps looking", () => {
    const agentsPath = join(homedir(), ".agents", "skills", REL);
    const claudePath = join(homedir(), ".claude", "skills", REL);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path === agentsPath) return "no markers in this file";
      if (path === claudePath) return skillDoc("GOOD RULES");
      throw new Error("ENOENT");
    });

    expect(resolveMinerCoreRules({})).toEqual({ rules: "GOOD RULES", source: claudePath });
  });

  it("falls back to the vendored rules when no skill is installed", () => {
    expect(resolveMinerCoreRules({})).toEqual({ rules: MINER_CORE_RULES, source: "bundled" });
  });
});
