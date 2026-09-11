import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSkillDescription, renderSkillMarkdown } from "./binding";
import {
  linkedSkillRoot,
  listLinkedSkills,
  readExistingBinding,
  removeLinkedSkill,
  skillPathsFor,
  writeSkillFile,
} from "./store";
import { type LinkMarker, SKILL_LINK_TEMPLATE_VERSION } from "./types";

const DOCUMENT_ID = "879cbca9-2fbf-45be-9a3e-1b74303238be";
const LIBRARY_ID = "11111111-2222-3333-4444-555555555555";

const baseMarker: Omit<LinkMarker, "content_sha256"> = {
  document_id: DOCUMENT_ID,
  library_id: LIBRARY_ID,
  org_id: null,
  revision: null,
  template: SKILL_LINK_TEMPLATE_VERSION,
  cli_version: "0.53.0",
};

function rendered(name: string, revision: number | null = null): string {
  return renderSkillMarkdown({
    name,
    description: defaultSkillDescription("DB Enum Widening Checklist", name, revision),
    marker: { ...baseMarker, revision },
  });
}

const FOREIGN_SKILL = "---\nname: mine\ndescription: hand written\n---\n\n# mine\n";
const CORRUPT_SKILL =
  "---\nname: broken\n---\n<!-- dosu:skill-link v1 {not json} -->\n\n# broken\n";

/** Snapshot of every file under `dir`: relative path → content + mtime. */
function snapshot(dir: string): Record<string, { content: string; mtimeMs: number }> {
  const out: Record<string, { content: string; mtimeMs: number }> = {};
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = { content: readFileSync(full, "utf-8"), mtimeMs: statSync(full).mtimeMs };
    }
  };
  walk(dir, "");
  return out;
}

let tempDir: string;
let originalClaudeConfigDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-skills-"));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, "claude-config");
});

afterEach(() => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("linkedSkillRoot", () => {
  it("uses CLAUDE_CONFIG_DIR for user scope", () => {
    expect(linkedSkillRoot("claude", "user")).toBe(join(tempDir, "claude-config", "skills"));
  });

  it("trims CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = `  ${join(tempDir, "padded")}  `;
    expect(linkedSkillRoot("claude", "user")).toBe(join(tempDir, "padded", "skills"));
  });

  it("falls back to ~/.claude/skills when CLAUDE_CONFIG_DIR is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(linkedSkillRoot("claude", "user")).toBe(join(homedir(), ".claude", "skills"));
  });

  it("falls back to ~/.claude/skills when CLAUDE_CONFIG_DIR is whitespace", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(linkedSkillRoot("claude", "user")).toBe(join(homedir(), ".claude", "skills"));
  });

  it("uses <cwd>/.claude/skills for project scope", () => {
    expect(linkedSkillRoot("claude", "project", tempDir)).toBe(join(tempDir, ".claude", "skills"));
  });

  it("defaults project scope to process.cwd()", () => {
    expect(linkedSkillRoot("claude", "project")).toBe(join(process.cwd(), ".claude", "skills"));
  });
});

describe("skillPathsFor", () => {
  it("returns the directory and SKILL.md under the root for a valid name", () => {
    const root = join(tempDir, "skills");
    expect(skillPathsFor(root, "migration-review")).toEqual({
      dir: join(root, "migration-review"),
      file: join(root, "migration-review", "SKILL.md"),
    });
  });

  it("resolves a relative root against the working directory", () => {
    const paths = skillPathsFor("relative-root", "x");
    expect(paths?.dir).toBe(resolve("relative-root", "x"));
  });

  it.each([
    "../x",
    "..",
    ".",
    "",
    "/abs",
    "a/b",
    "a/../..",
    "x/",
  ])("refuses %j and writes nothing outside the root", (name) => {
    const root = join(tempDir, "skills");
    mkdirSync(root, { recursive: true });
    const before = snapshot(tempDir);
    expect(skillPathsFor(root, name)).toBeNull();
    expect(snapshot(tempDir)).toEqual(before);
    expect(existsSync(join(tempDir, "x"))).toBe(false);
  });

  it("refuses an absolute path built from the root itself", () => {
    const root = join(tempDir, "skills");
    expect(skillPathsFor(root, root)).toBeNull();
    expect(skillPathsFor(root, join(root, "x"))).toBeNull();
  });

  it("handles a root that already ends with the separator", () => {
    const root = `${join(tempDir, "skills")}${sep}`;
    expect(skillPathsFor(root, "x")).toEqual({
      dir: join(tempDir, "skills", "x"),
      file: join(tempDir, "skills", "x", "SKILL.md"),
    });
  });

  it("handles the filesystem root, whose resolved form keeps its separator", () => {
    const fsRoot = parse(process.cwd()).root;
    expect(skillPathsFor(fsRoot, "x")).toEqual({
      dir: join(fsRoot, "x"),
      file: join(fsRoot, "x", "SKILL.md"),
    });
  });
});

describe("writeSkillFile", () => {
  it("creates parent directories and writes byte-identical content", () => {
    const file = join(tempDir, "skills", "migration-review", "SKILL.md");
    const content = rendered("migration-review");
    writeSkillFile(file, content);
    expect(readFileSync(file, "utf-8")).toBe(content);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o644);
    }
  });

  it("replaces an existing file without leaving temp files behind", () => {
    const dir = join(tempDir, "skills", "migration-review");
    const file = join(dir, "SKILL.md");
    writeSkillFile(file, rendered("migration-review"));
    writeSkillFile(file, rendered("migration-review", 4));
    expect(readFileSync(file, "utf-8")).toBe(rendered("migration-review", 4));
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);
  });

  it("leaves sibling skill directories byte-identical", () => {
    const root = join(tempDir, "skills");
    mkdirSync(join(root, "other", "nested"), { recursive: true });
    writeFileSync(join(root, "other", "SKILL.md"), FOREIGN_SKILL);
    writeFileSync(join(root, "other", "nested", "notes.txt"), "keep me\n");
    const before = snapshot(join(root, "other"));

    writeSkillFile(join(root, "migration-review", "SKILL.md"), rendered("migration-review"));

    expect(snapshot(join(root, "other"))).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(["migration-review", "other"]);
  });

  it("cleans up its temp file when the rename fails", () => {
    const dir = join(tempDir, "skills", "blocked");
    // A directory occupying the target path makes rename() fail.
    mkdirSync(join(dir, "SKILL.md", "inner"), { recursive: true });
    expect(() => writeSkillFile(join(dir, "SKILL.md"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["SKILL.md"]);
    expect(readdirSync(join(dir, "SKILL.md"))).toEqual(["inner"]);
  });
});

describe("readExistingBinding", () => {
  it("reports absent when there is no file", () => {
    expect(readExistingBinding(join(tempDir, "nope", "SKILL.md"))).toEqual({ kind: "absent" });
  });

  it("reports foreign for a SKILL.md without a marker and leaves it untouched", () => {
    const file = join(tempDir, "mine", "SKILL.md");
    mkdirSync(join(tempDir, "mine"));
    writeFileSync(file, FOREIGN_SKILL);
    expect(readExistingBinding(file)).toEqual({ kind: "foreign" });
    expect(readFileSync(file, "utf-8")).toBe(FOREIGN_SKILL);
  });

  it("reports foreign when SKILL.md is a directory", () => {
    const file = join(tempDir, "weird", "SKILL.md");
    mkdirSync(file, { recursive: true });
    expect(readExistingBinding(file)).toEqual({ kind: "foreign" });
  });

  it("reports corrupt for an unparseable marker", () => {
    const file = join(tempDir, "broken", "SKILL.md");
    mkdirSync(join(tempDir, "broken"));
    writeFileSync(file, CORRUPT_SKILL);
    expect(readExistingBinding(file)).toMatchObject({ kind: "corrupt", message: /marker/ });
  });

  it("reports owned with edited:false for a generated file", () => {
    const file = join(tempDir, "owned", "SKILL.md");
    const content = rendered("owned");
    mkdirSync(join(tempDir, "owned"));
    writeFileSync(file, content);
    const result = readExistingBinding(file);
    expect(result.kind).toBe("owned");
    if (result.kind !== "owned") return;
    expect(result.edited).toBe(false);
    expect(result.content).toBe(content);
    expect(result.marker).toMatchObject(baseMarker);
  });

  it("reports owned with edited:true after a user edit", () => {
    const file = join(tempDir, "owned", "SKILL.md");
    mkdirSync(join(tempDir, "owned"));
    writeFileSync(file, `${rendered("owned")}\nAlso run the linter.\n`);
    expect(readExistingBinding(file)).toMatchObject({ kind: "owned", edited: true });
  });
});

describe("listLinkedSkills", () => {
  it("returns only marker-bearing skills across roots, sorted by scope then name", () => {
    const userRoot = join(tempDir, "claude-config", "skills");
    const projectRoot = join(tempDir, "project", ".claude", "skills");

    for (const [root, name, content] of [
      [userRoot, "zeta-link", rendered("zeta-link")],
      [userRoot, "alpha-link", rendered("frontmatter-name-differs", 3)],
      [userRoot, "edited-link", `${rendered("edited-link")}\nextra\n`],
      [userRoot, "foreign", FOREIGN_SKILL],
      [userRoot, "corrupt", CORRUPT_SKILL],
      [projectRoot, "proj-b", rendered("proj-b")],
      [projectRoot, "proj-a", rendered("proj-a")],
      [projectRoot, "proj-foreign", FOREIGN_SKILL],
    ] as const) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), content);
    }
    // Noise that must be ignored: a plain file in the root, a directory
    // without SKILL.md, and a directory where SKILL.md is itself a directory.
    writeFileSync(join(userRoot, "README.md"), "# not a skill\n");
    mkdirSync(join(userRoot, "empty-dir"));
    mkdirSync(join(userRoot, "dir-skill", "SKILL.md"), { recursive: true });

    const entries = listLinkedSkills([
      { root: projectRoot, agent: "claude", scope: "project" },
      { root: userRoot, agent: "claude", scope: "user" },
      { root: join(tempDir, "does-not-exist"), agent: "claude", scope: "user" },
    ]);

    expect(entries.map((e) => [e.scope, e.name, e.edited])).toEqual([
      ["user", "alpha-link", false],
      ["user", "edited-link", true],
      ["user", "zeta-link", false],
      ["project", "proj-a", false],
      ["project", "proj-b", false],
    ]);
    const alpha = entries[0] as (typeof entries)[number];
    expect(alpha.agent).toBe("claude");
    expect(alpha.path).toBe(join(userRoot, "alpha-link", "SKILL.md"));
    expect(alpha.marker.revision).toBe(3);
    expect(alpha.marker.document_id).toBe(DOCUMENT_ID);
  });

  it("returns an empty list when no root exists", () => {
    expect(
      listLinkedSkills([{ root: join(tempDir, "missing"), agent: "claude", scope: "user" }]),
    ).toEqual([]);
  });

  it("scans a root listed twice only once, under its first scope", () => {
    const root = join(tempDir, "claude-config", "skills");
    mkdirSync(join(root, "only-once"), { recursive: true });
    writeFileSync(join(root, "only-once", "SKILL.md"), rendered("only-once"));

    const entries = listLinkedSkills([
      { root, agent: "claude", scope: "user" },
      { root: `${root}${sep}`, agent: "claude", scope: "project" },
    ]);
    expect(entries.map((e) => [e.scope, e.name])).toEqual([["user", "only-once"]]);
  });

  it("orders names by code point, not by locale", () => {
    const root = join(tempDir, "claude-config", "skills");
    for (const name of ["c-skill", "a-skill", "B-skill"]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), rendered(name));
    }
    const entries = listLinkedSkills([{ root, agent: "claude", scope: "user" }]);
    expect(entries.map((e) => e.name)).toEqual(["B-skill", "a-skill", "c-skill"]);
  });

  it("skips a root that is a plain file", () => {
    const root = join(tempDir, "file-root");
    writeFileSync(root, "not a directory\n");
    expect(listLinkedSkills([{ root, agent: "claude", scope: "user" }])).toEqual([]);
  });

  it("follows symlinked skill directories and skips dangling ones", () => {
    if (process.platform === "win32") return;
    const root = join(tempDir, "skills");
    const real = join(tempDir, "elsewhere", "real-skill");
    mkdirSync(root, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), rendered("real-skill"));
    symlinkSync(real, join(root, "linked"));
    symlinkSync(join(tempDir, "gone"), join(root, "dangling"));

    const entries = listLinkedSkills([{ root, agent: "claude", scope: "user" }]);
    expect(entries.map((e) => e.name)).toEqual(["linked"]);
  });
});

describe("removeLinkedSkill", () => {
  it("removes an owned file and its empty directory", () => {
    const dir = join(tempDir, "skills", "owned");
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, rendered("owned"));

    expect(removeLinkedSkill(file)).toEqual({
      removed: true,
      directory_removed: true,
      leftover: [],
    });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(tempDir, "skills"))).toBe(true);
  });

  it("removes an edited owned file too", () => {
    const dir = join(tempDir, "skills", "owned");
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${rendered("owned")}\nedited\n`);
    expect(removeLinkedSkill(file)).toMatchObject({ removed: true, directory_removed: true });
  });

  it("keeps a non-empty directory and reports the leftovers", () => {
    const dir = join(tempDir, "skills", "owned");
    const file = join(dir, "SKILL.md");
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(file, rendered("owned"));
    writeFileSync(join(dir, "notes.txt"), "keep\n");

    expect(removeLinkedSkill(file)).toEqual({
      removed: true,
      directory_removed: false,
      leftover: ["assets", "notes.txt"],
    });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(dir, "notes.txt"), "utf-8")).toBe("keep\n");
  });

  it("refuses a foreign SKILL.md and leaves it byte-identical", () => {
    const dir = join(tempDir, "skills", "mine");
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, FOREIGN_SKILL);

    expect(removeLinkedSkill(file)).toMatchObject({
      removed: false,
      reason: "not_a_dosu_link",
      message: /not a Dosu skill link/,
    });
    expect(readFileSync(file, "utf-8")).toBe(FOREIGN_SKILL);
  });

  it("refuses a corrupt marker", () => {
    const dir = join(tempDir, "skills", "broken");
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, CORRUPT_SKILL);

    expect(removeLinkedSkill(file)).toMatchObject({ removed: false, reason: "corrupt" });
    expect(readFileSync(file, "utf-8")).toBe(CORRUPT_SKILL);
  });

  it("reports not_found when the file is absent", () => {
    expect(removeLinkedSkill(join(tempDir, "skills", "nope", "SKILL.md"))).toMatchObject({
      removed: false,
      reason: "not_found",
    });
  });
});
