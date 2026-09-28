import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GENERATED_FILE, generate, readSkills, renderSkillsModule } from "./embed-skills";

describe("embedded skills", () => {
  it("keeps src/generated/skills.ts in sync with skills/", () => {
    // Regenerate with `bun run embed:skills` after editing anything under `skills/`.
    expect(readFileSync(GENERATED_FILE, "utf8")).toBe(generate());
  });

  it("ships only the dosu skill, with a SKILL.md", () => {
    const skills = readSkills();
    expect(skills.map((skill) => skill.name)).toEqual(["dosu"]);
    for (const skill of skills) {
      expect(skill.files.some((file) => file.path === "SKILL.md")).toBe(true);
    }
  });
});

describe("readSkills", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-embed-skills-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSkill(name: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const full = join(tempDir, name, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  it("collects files with POSIX-relative paths, sorted, and records the executable bit", () => {
    writeSkill("alpha", {
      "SKILL.md": "# alpha",
      "scripts/run.py": "#!/usr/bin/env python3\n",
      "references/b.md": "b",
    });
    chmodSync(join(tempDir, "alpha", "scripts", "run.py"), 0o755);
    writeFileSync(join(tempDir, "alpha", ".DS_Store"), "junk");
    mkdirSync(join(tempDir, "alpha", "scripts", "__pycache__"));
    writeFileSync(join(tempDir, "alpha", "scripts", "__pycache__", "run.pyc"), "junk");

    const [skill] = readSkills(tempDir);
    expect(skill.name).toBe("alpha");
    expect(skill.files.map((file) => [file.path, file.executable])).toEqual([
      ["SKILL.md", false],
      ["references/b.md", false],
      ["scripts/run.py", true],
    ]);
  });

  it("rejects a skill without SKILL.md", () => {
    writeSkill("broken", { "notes.md": "x" });
    expect(() => readSkills(tempDir)).toThrow(/missing SKILL\.md/);
  });

  it("rejects a skill directory name that is not installable", () => {
    writeSkill("Bad Name", { "SKILL.md": "x" });
    expect(() => readSkills(tempDir)).toThrow(/not installable/);
  });

  it("rejects an empty skills directory", () => {
    expect(() => readSkills(tempDir)).toThrow(/No skills found/);
  });

  it("renders a module whose string literals round-trip arbitrary content", () => {
    // Backticks, `$` + `{`, quotes, newlines, and backslashes must all survive as data.
    const tricky = ["back`tick $", '{a} "quote"\n\\slash'].join("");
    const rendered = renderSkillsModule([
      { name: "x", files: [{ path: "SKILL.md", content: tricky, executable: false }] },
    ]);
    expect(rendered).toContain("export const BUNDLED_SKILLS");
    expect(rendered).toContain(JSON.stringify(tricky));
  });
});
