#!/usr/bin/env bun

/** Embed `skills/<name>/**` into `src/generated/skills.ts` so the published bundle carries the
 * agent skills without a runtime download. The generated file is committed; `--check` fails when
 * it is out of date (enforced by `embed-skills.test.ts`). */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SCRIPT_DIR, "..");
export const SKILLS_SOURCE_DIR = join(REPOSITORY_ROOT, "skills");
export const GENERATED_FILE = join(REPOSITORY_ROOT, "src", "generated", "skills.ts");

export interface EmbeddedSkillFile {
  /** Skill-relative POSIX path, e.g. `scripts/parse_agent_logs.py`. */
  path: string;
  content: string;
  executable: boolean;
}

export interface EmbeddedSkill {
  name: string;
  files: EmbeddedSkillFile[];
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const IGNORED_ENTRIES = new Set([".DS_Store", "__pycache__"]);

function listFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_ENTRIES.has(entry.name) || entry.name.endsWith(".pyc")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

export function readSkills(sourceDir: string = SKILLS_SOURCE_DIR): EmbeddedSkill[] {
  const skills: EmbeddedSkill[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || IGNORED_ENTRIES.has(entry.name)) continue;
    if (!SKILL_NAME.test(entry.name)) {
      throw new Error(`Skill directory name is not installable: ${entry.name}`);
    }
    const skillDir = join(sourceDir, entry.name);
    const files = listFiles(skillDir).map((file) => ({
      path: relative(skillDir, file).split(sep).join("/"),
      content: readFileSync(file, "utf8"),
      executable: (statSync(file).mode & 0o111) !== 0,
    }));
    if (!files.some((file) => file.path === "SKILL.md")) {
      throw new Error(`Skill ${entry.name} is missing SKILL.md`);
    }
    skills.push({ name: entry.name, files });
  }
  if (skills.length === 0) throw new Error(`No skills found under ${sourceDir}`);
  return skills;
}

export function renderSkillsModule(skills: readonly EmbeddedSkill[]): string {
  const lines = [
    "// GENERATED FILE — do not edit. Run `bun run embed:skills` after changing `skills/`.",
    "",
    "interface BundledSkillFile {",
    "  /** Skill-relative POSIX path, e.g. `scripts/parse_agent_logs.py`. */",
    "  readonly path: string;",
    "  readonly content: string;",
    "  readonly executable: boolean;",
    "}",
    "",
    "export interface BundledSkill {",
    "  readonly name: string;",
    "  readonly files: readonly BundledSkillFile[];",
    "}",
    "",
    "export const BUNDLED_SKILLS: readonly BundledSkill[] = [",
  ];
  for (const skill of skills) {
    lines.push("  {", `    name: ${JSON.stringify(skill.name)},`, "    files: [");
    for (const file of skill.files) {
      lines.push(
        "      {",
        `        path: ${JSON.stringify(file.path)},`,
        `        content: ${JSON.stringify(file.content)},`,
        `        executable: ${file.executable},`,
        "      },",
      );
    }
    lines.push("    ],", "  },");
  }
  lines.push("];", "");
  return lines.join("\n");
}

export function generate(): string {
  return renderSkillsModule(readSkills());
}

function main(args: readonly string[]): void {
  const expected = generate();
  if (args.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(GENERATED_FILE, "utf8");
    } catch {
      // Missing file is simply out of date.
    }
    if (current !== expected) {
      console.error(`${GENERATED_FILE} is out of date. Run \`bun run embed:skills\`.`);
      process.exit(1);
    }
    console.log("Embedded skills are up to date.");
    return;
  }
  writeFileSync(GENERATED_FILE, expected);
  console.log(`Wrote ${GENERATED_FILE}`);
}

const isDirectRun = process.argv[1]?.endsWith("embed-skills.ts");

if (isDirectRun) main(process.argv.slice(2));
