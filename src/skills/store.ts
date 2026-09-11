/**
 * Filesystem layer for live knowledge skill bindings: where `SKILL.md` files
 * live for each agent and scope, containment-checked path resolution,
 * ownership-aware reads, atomic writes, and listing/removal that only ever
 * touch files carrying our marker.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseMarker } from "./binding";
import type { LinkedSkillEntry, LinkMarker, SkillAgent, SkillScope } from "./types";

const SKILL_FILE = "SKILL.md";

/** Per-agent user config dir. Mirrors `skillInstallTargetForProvider` for Claude Code. */
const USER_CONFIG_DIR: Readonly<Record<SkillAgent, () => string>> = {
  claude: () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
};

/** Per-agent project-local skills directory, relative to the working directory. */
const PROJECT_SKILLS_DIR: Readonly<Record<SkillAgent, readonly string[]>> = {
  claude: [".claude", "skills"],
};

/** Root directory that holds `<name>/SKILL.md` directories for the agent+scope. */
export function linkedSkillRoot(agent: SkillAgent, scope: SkillScope, cwd?: string): string {
  if (scope === "project") return join(cwd ?? process.cwd(), ...PROJECT_SKILLS_DIR[agent]);
  return join(USER_CONFIG_DIR[agent](), "skills");
}

/**
 * Resolve `<root>/<name>` and `<root>/<name>/SKILL.md`. Returns null unless
 * `name` is a single path segment and the resolved directory is strictly inside
 * `root`, so `../x`, absolute paths, `.`, `x/` and nested `a/b` are all refused
 * before any I/O.
 */
export function skillPathsFor(root: string, name: string): { dir: string; file: string } | null {
  if (name !== basename(name)) return null;
  const resolvedRoot = resolve(root);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  const dir = resolve(resolvedRoot, name);
  if (!dir.startsWith(prefix)) return null;
  return { dir, file: join(dir, SKILL_FILE) };
}

export type ExistingBinding =
  | { kind: "absent" }
  | { kind: "foreign" }
  | { kind: "corrupt"; message: string }
  | { kind: "owned"; marker: LinkMarker; content: string; edited: boolean };

/** Classify whatever currently sits at `file` without modifying it. */
export function readExistingBinding(file: string): ExistingBinding {
  if (!existsSync(file)) return { kind: "absent" };
  // Anything that is not a regular file (a directory named SKILL.md, say) is
  // someone else's; treat it like a foreign skill and never touch it.
  if (!statSync(file).isFile()) return { kind: "foreign" };
  const content = readFileSync(file, "utf-8");
  const parsed = parseMarker(content);
  if (parsed.kind === "missing") return { kind: "foreign" };
  if (parsed.kind === "corrupt") return { kind: "corrupt", message: parsed.message };
  return { kind: "owned", marker: parsed.marker, content, edited: parsed.edited };
}

/**
 * mkdir -p the parent, write to a temp file in the same directory, then rename
 * over `file` so readers never observe a partial SKILL.md. Mode 0o644 is set
 * explicitly so the result does not depend on the umask.
 */
export function writeSkillFile(file: string, content: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${SKILL_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf-8", mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface SkillRoot {
  root: string;
  agent: SkillAgent;
  scope: SkillScope;
}

const SCOPE_ORDER: Readonly<Record<SkillScope, number>> = { user: 0, project: 1 };

/** Code-point order, independent of the process locale. */
function compareNames(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

function compareEntries(a: LinkedSkillEntry, b: LinkedSkillEntry): number {
  return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || compareNames(a.name, b.name);
}

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Scan every `<root>/<dir>/SKILL.md` for each root and return only files carrying a
 * parseable marker. Missing roots are skipped silently; foreign skills, plain
 * files in the root, and corrupt markers are ignored. A root that appears more
 * than once (e.g. `CLAUDE_CONFIG_DIR` pointing at `<cwd>/.claude`) is scanned
 * once, under the scope it was first listed with. Sorted by scope then name.
 * `name` is the directory name, not the frontmatter name.
 */
export function listLinkedSkills(roots: readonly SkillRoot[]): LinkedSkillEntry[] {
  const entries: LinkedSkillEntry[] = [];
  const seen = new Set<string>();
  for (const { root, agent, scope } of roots) {
    const resolvedRoot = resolve(root);
    if (seen.has(resolvedRoot) || !isDirectory(resolvedRoot)) continue;
    seen.add(resolvedRoot);
    for (const name of readdirSync(root)) {
      const file = join(root, name, SKILL_FILE);
      // statSync follows symlinks, so a symlinked skill directory (the shape
      // `dosu skill install` produces) is included; a dangling one is not.
      if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) continue;
      const parsed = parseMarker(readFileSync(file, "utf-8"));
      if (parsed.kind !== "ok") continue;
      entries.push({
        name,
        agent,
        scope,
        path: file,
        marker: parsed.marker,
        edited: parsed.edited,
      });
    }
  }
  return entries.sort(compareEntries);
}

export type RemoveResult =
  | { removed: true; directory_removed: boolean; leftover: string[] }
  | { removed: false; reason: "not_found" | "not_a_dosu_link" | "corrupt"; message: string };

/** Remove SKILL.md only when it carries a valid marker; then rmdir the directory only if empty. */
export function removeLinkedSkill(file: string): RemoveResult {
  const existing = readExistingBinding(file);
  if (existing.kind === "absent") {
    return { removed: false, reason: "not_found", message: `No skill file at ${file}.` };
  }
  if (existing.kind === "foreign") {
    return {
      removed: false,
      reason: "not_a_dosu_link",
      message: `${file} is not a Dosu skill link; leaving it untouched.`,
    };
  }
  if (existing.kind === "corrupt") {
    return { removed: false, reason: "corrupt", message: existing.message };
  }

  unlinkSync(file);
  const dir = dirname(file);
  const leftover = readdirSync(dir).sort();
  if (leftover.length > 0) return { removed: true, directory_removed: false, leftover };
  rmdirSync(dir);
  return { removed: true, directory_removed: true, leftover: [] };
}
