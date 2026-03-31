import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock terminal UI boundary
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import { generateSkillContent, runInit, writeAgentsEntry } from "./flow";

// ── Temp dir ───────────────────────────────────────────────────────────────

let tempDir: string;
let origCwd: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-init-test-"));
  origCwd = process.cwd();
  process.chdir(tempDir);
  vi.clearAllMocks();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

// ── generateSkillContent ───────────────────────────────────────────────────

describe("generateSkillContent", () => {
  it("contains dosu-add instruction", () => {
    const content = generateSkillContent();
    expect(content).toContain("/dosu-add");
    expect(content).toContain("ask_public_library");
  });

  it("contains dosu-sync instruction", () => {
    const content = generateSkillContent();
    expect(content).toContain("/dosu-sync");
  });

  it("has valid frontmatter", () => {
    const content = generateSkillContent();
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("description:");
    expect(content).toContain("globs:");
  });
});

// ── writeAgentsEntry ───────────────────────────────────────────────────────

describe("writeAgentsEntry", () => {
  it("creates new AGENTS.md when it does not exist", () => {
    const agentsPath = join(tempDir, "AGENTS.md");
    writeAgentsEntry(agentsPath, false);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("# Agents");
    expect(content).toContain("/dosu-add");
    expect(content).toContain(".claude/skills/dosu/SKILL.md");
  });

  it("appends to existing AGENTS.md", () => {
    const agentsPath = join(tempDir, "AGENTS.md");
    writeFileSync(agentsPath, "# Agents\n\n## Other\nSomething here.\n");

    writeAgentsEntry(agentsPath, true);

    const content = readFileSync(agentsPath, "utf-8");
    expect(content).toContain("## Other");
    expect(content).toContain("## Dosu");
    expect(content).toContain("/dosu-add");
  });

  it("does not duplicate if already present", () => {
    const agentsPath = join(tempDir, "AGENTS.md");
    writeFileSync(agentsPath, "# Agents\n\nSee .claude/skills/dosu/SKILL.md for details.\n");

    writeAgentsEntry(agentsPath, true);

    const content = readFileSync(agentsPath, "utf-8");
    // Should appear only once
    const count = content.split(".claude/skills/dosu/SKILL.md").length - 1;
    expect(count).toBe(1);
  });
});

// ── runInit ────────────────────────────────────────────────────────────────

describe("runInit", () => {
  it("creates skill file and AGENTS.md", async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);

    await runInit();

    const skillPath = join(tempDir, ".claude/skills/dosu/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf-8")).toContain("/dosu-add");

    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(true);

    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining("Dosu initialized"));
  });

  it("skips AGENTS.md when user declines", async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);

    await runInit();

    const skillPath = join(tempDir, ".claude/skills/dosu/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const agentsPath = join(tempDir, "AGENTS.md");
    expect(existsSync(agentsPath)).toBe(false);
  });

  it("prompts overwrite when skill already exists", async () => {
    const skillDir = join(tempDir, ".claude/skills/dosu");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "old content");

    // First confirm = overwrite yes, second confirm = create AGENTS.md
    vi.mocked(p.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await runInit();

    const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(content).toContain("/dosu-add");
    expect(content).not.toBe("old content");
  });

  it("aborts when user declines overwrite", async () => {
    const skillDir = join(tempDir, ".claude/skills/dosu");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "old content");

    vi.mocked(p.confirm).mockResolvedValue(false);

    await runInit();

    const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(content).toBe("old content");
    expect(p.outro).toHaveBeenCalledWith("No changes made");
  });

  it("handles cancellation on overwrite prompt", async () => {
    const skillDir = join(tempDir, ".claude/skills/dosu");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "old content");

    vi.mocked(p.isCancel).mockReturnValue(true);
    vi.mocked(p.confirm).mockResolvedValue(Symbol("cancel") as never);

    await runInit();

    expect(p.outro).toHaveBeenCalledWith("No changes made");
  });
});
