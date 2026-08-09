import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRemoveGlobalSkillQuietly, mockRemoveRuleForAgent, mockRulePathForAgent } = vi.hoisted(
  () => ({
    mockRemoveGlobalSkillQuietly: vi.fn(),
    mockRemoveRuleForAgent: vi.fn(),
    mockRulePathForAgent: vi.fn(),
  }),
);

vi.mock("../commands/skill", () => ({
  removeGlobalSkillQuietly: mockRemoveGlobalSkillQuietly,
}));

vi.mock("../rules/installer", () => ({
  removeRuleForAgent: mockRemoveRuleForAgent,
  rulePathForAgent: mockRulePathForAgent,
}));

import {
  cleanupLegacyGlobalMcp,
  cleanupLegacyGlobalRule,
  cleanupLegacyGlobalSkill,
} from "./legacy-global-cleanup";

let tempDir: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-legacy-global-cleanup-")));
  mockRemoveRuleForAgent.mockReset();
  mockRulePathForAgent.mockReset();
  mockRemoveGlobalSkillQuietly.mockReset();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cleanupLegacyGlobalMcp", () => {
  it("calls the provider-owned legacy cleanup when available", () => {
    const removeLegacyGlobal = vi.fn();

    expect(() => cleanupLegacyGlobalMcp({ removeLegacyGlobal })).not.toThrow();

    expect(removeLegacyGlobal).toHaveBeenCalledOnce();
  });

  it("silently skips unsupported providers and provider cleanup failures", () => {
    expect(() => cleanupLegacyGlobalMcp({})).not.toThrow();
    expect(() =>
      cleanupLegacyGlobalMcp({
        removeLegacyGlobal: () => {
          throw new Error("cleanup failed");
        },
      }),
    ).not.toThrow();
  });
});

describe("cleanupLegacyGlobalRule", () => {
  it("removes only a marked Dosu section from a section-based global rule", () => {
    const rulePath = join(tempDir, "AGENTS.md");
    writeFileSync(rulePath, "<!-- dosu:rules:start v1 -->\nlegacy rule\n<!-- dosu:rules:end -->\n");
    mockRulePathForAgent.mockReturnValue(rulePath);

    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();

    expect(mockRulePathForAgent).toHaveBeenCalledWith("codex");
    expect(mockRemoveRuleForAgent).toHaveBeenCalledWith("codex");
  });

  it("preserves standalone and foreign files at historical paths", () => {
    const rulePath = join(tempDir, "dosu.md");
    writeFileSync(
      rulePath,
      "The team you are assisting maintains shared knowledge in Dosu: user additions",
      "utf-8",
    );
    mockRulePathForAgent.mockReturnValue(rulePath);

    expect(() => cleanupLegacyGlobalRule("claude")).not.toThrow();

    expect(mockRulePathForAgent).not.toHaveBeenCalled();
    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();

    mockRulePathForAgent.mockReturnValue(rulePath);
    writeFileSync(rulePath, "user-owned instructions", "utf-8");
    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();

    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("silently skips missing and unsupported historical paths", () => {
    mockRulePathForAgent.mockReturnValueOnce(join(tempDir, "missing.md")).mockReturnValueOnce(null);

    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();
    expect(() => cleanupLegacyGlobalRule("windsurf")).not.toThrow();

    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("refuses to follow a symlink at the final rule path", () => {
    const target = join(tempDir, "target.md");
    const symlink = join(tempDir, "dosu.md");
    writeFileSync(target, "user content", "utf-8");
    symlinkSync(target, symlink);
    mockRulePathForAgent.mockReturnValue(symlink);

    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();

    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("refuses to follow a symlinked parent directory", () => {
    const targetDir = join(tempDir, "target");
    const linkedDir = join(tempDir, "linked");
    const target = join(targetDir, "dosu.md");
    mkdirSync(targetDir);
    writeFileSync(
      target,
      "The team you are assisting maintains shared knowledge in Dosu: legacy rule",
      "utf-8",
    );
    symlinkSync(targetDir, linkedDir);
    mockRulePathForAgent.mockReturnValue(join(linkedDir, "dosu.md"));

    expect(() => cleanupLegacyGlobalRule("claude")).not.toThrow();

    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("preserves the Gemini rule shared with project-unsupported Antigravity", () => {
    expect(() => cleanupLegacyGlobalRule("gemini")).not.toThrow();

    expect(mockRulePathForAgent).not.toHaveBeenCalled();
    expect(mockRemoveRuleForAgent).not.toHaveBeenCalled();
  });

  it("swallows lookup and removal failures", () => {
    const rulePath = join(tempDir, "dosu.md");
    writeFileSync(
      rulePath,
      "The team you are assisting maintains shared knowledge in Dosu: legacy rule",
      "utf-8",
    );
    mockRulePathForAgent
      .mockImplementationOnce(() => {
        throw new Error("lookup failed");
      })
      .mockReturnValueOnce(rulePath);
    mockRemoveRuleForAgent.mockImplementation(() => {
      throw new Error("remove failed");
    });

    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();
    expect(() => cleanupLegacyGlobalRule("codex")).not.toThrow();
  });
});

describe("cleanupLegacyGlobalSkill", () => {
  it("runs the exact historical global skill cleanup", async () => {
    mockRemoveGlobalSkillQuietly.mockResolvedValue(true);

    await expect(cleanupLegacyGlobalSkill(["claude"])).resolves.toBeUndefined();

    expect(mockRemoveGlobalSkillQuietly).toHaveBeenCalledWith(["claude"]);
  });

  it("silently ignores skill cleanup failures", async () => {
    mockRemoveGlobalSkillQuietly.mockRejectedValue(new Error("cleanup failed"));

    await expect(cleanupLegacyGlobalSkill(["claude"])).resolves.toBeUndefined();
  });
});
