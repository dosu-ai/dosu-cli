import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { assertSafeProjectPath } from "../setup/project-path";

const LOCK_NAME = "skills-lock.json";
const DOSU_SOURCE = "dosu-ai/dosu-skill";
const DOSU_SKILL_PATH = "skills/dosu/SKILL.md";

export interface ProjectSkillTarget {
  path: string;
  symlink: boolean;
}

export type ProjectSkillEvidence =
  | { kind: "file"; path: string; realPath: string; hash: string }
  | { kind: "directory"; path: string; realPath: string; hash: string }
  | { kind: "symlink"; path: string; realPath: string };

export type ProjectSkillVerification =
  | { ok: true; evidence: ProjectSkillEvidence[] }
  | { ok: false; reason: string; path?: string };

interface OwnedLock {
  kind: "owned";
  computedHash: string;
  evidence: ProjectSkillEvidence;
}

type LockInspection =
  | { kind: "absent" }
  | { kind: "unclaimed"; evidence: ProjectSkillEvidence }
  | OwnedLock
  | { kind: "invalid"; path: string };

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  const separator = process.platform === "win32" ? "\\" : "/";
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${separator}`) && !isAbsolute(rel));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function duplicateJsonKey(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const key = keyNode ? getNodeValue(keyNode) : undefined;
      if (typeof key !== "string") continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(duplicateJsonKey);
}

function parseStrictJsonObject(content: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, { allowTrailingComma: false, disallowComments: true });
  if (root?.type !== "object" || errors.length > 0 || duplicateJsonKey(root)) return null;
  const value: unknown = getNodeValue(root);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inspectLock(projectRoot: string): LockInspection {
  const path = join(projectRoot, LOCK_NAME);
  if (!entryExists(path)) return { kind: "absent" };
  try {
    const stat = lstatSync(path);
    const realRoot = realpathSync(projectRoot);
    const realPath = realpathSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(realRoot, realPath)) {
      return { kind: "invalid", path };
    }
    const content = readFileSync(path, "utf8");
    const parsed = parseStrictJsonObject(content);
    if (parsed?.version !== 1 || !isRecord(parsed.skills)) {
      return { kind: "invalid", path };
    }
    const evidence: ProjectSkillEvidence = {
      kind: "file",
      path,
      realPath,
      hash: createHash("sha256").update(content).digest("hex"),
    };
    if (!Object.hasOwn(parsed.skills, "dosu")) return { kind: "unclaimed", evidence };
    const entry = parsed.skills.dosu;
    if (
      !isRecord(entry) ||
      entry.source !== DOSU_SOURCE ||
      entry.sourceType !== "github" ||
      entry.skillPath !== DOSU_SKILL_PATH ||
      typeof entry.computedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.computedHash)
    ) {
      return { kind: "invalid", path };
    }
    return { kind: "owned", computedHash: entry.computedHash, evidence };
  } catch {
    return { kind: "invalid", path };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDirectoryFiles(
  base: string,
  current: string,
  files: Array<{ relativePath: string; content: Buffer }>,
): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) return false;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!collectDirectoryFiles(base, path, files)) return false;
    } else if (entry.isFile()) {
      files.push({
        relativePath: relative(base, path).split("\\").join("/"),
        content: readFileSync(path),
      });
    } else {
      return false;
    }
  }
  return true;
}

function inspectDirectory(
  path: string,
  projectRoot: string,
  expectedHash: string,
): Extract<ProjectSkillEvidence, { kind: "directory" }> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const realRoot = realpathSync(projectRoot);
    const realPath = realpathSync(path);
    if (!isInside(realRoot, realPath)) return null;
    const files: Array<{ relativePath: string; content: Buffer }> = [];
    if (!collectDirectoryFiles(path, path, files)) return null;
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const hash = createHash("sha256");
    for (const file of files) hash.update(file.relativePath).update(file.content);
    const digest = hash.digest("hex");
    if (digest !== expectedHash) return null;
    const skillPath = join(path, "SKILL.md");
    const frontmatter = readFileSync(skillPath, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    if (!frontmatter?.split(/\r?\n/).some((line) => /^name:\s*dosu\s*$/.test(line))) return null;
    return { kind: "directory", path, realPath, hash: digest };
  } catch {
    return null;
  }
}

function inspectTargets(input: {
  projectRoot: string;
  targets: readonly ProjectSkillTarget[];
  expectedHash: string;
  requireAll: boolean;
}): ProjectSkillVerification {
  const uniqueTargets = [
    ...new Map(input.targets.map((target) => [resolve(target.path), target])).values(),
  ];
  const evidence: ProjectSkillEvidence[] = [];
  const directRealPaths = new Set<string>();
  const sharedCanonicalPath = join(input.projectRoot, ".agents", "skills", "dosu");
  const claudeTargetPath = join(input.projectRoot, ".claude", "skills", "dosu");
  const factoryTargetPath = join(input.projectRoot, ".factory", "skills", "dosu");
  const reusableCanonicalAdapterPaths = new Set(
    [claudeTargetPath, factoryTargetPath].map((path) => resolve(path)),
  );
  let sharedCanonical: Extract<ProjectSkillEvidence, { kind: "directory" }> | null | undefined;
  const inspectSharedCanonical = () => {
    if (sharedCanonical === undefined) {
      sharedCanonical = inspectDirectory(
        sharedCanonicalPath,
        input.projectRoot,
        input.expectedHash,
      );
    }
    return sharedCanonical;
  };

  for (const target of uniqueTargets) {
    if (!entryExists(target.path)) {
      if (input.requireAll)
        return { ok: false, reason: "project_skill_missing", path: target.path };
      continue;
    }
    const stat = lstatSync(target.path);
    if (stat.isSymbolicLink()) continue;
    const directory = inspectDirectory(target.path, input.projectRoot, input.expectedHash);
    if (!directory) return { ok: false, reason: "project_skill_modified", path: target.path };
    directRealPaths.add(directory.realPath);
    evidence.push(directory);
  }

  for (const target of uniqueTargets) {
    if (!entryExists(target.path) || !lstatSync(target.path).isSymbolicLink()) continue;
    try {
      const realPath = realpathSync(target.path);
      if (!directRealPaths.has(realPath)) {
        // A prior multi-agent install uses `.agents/skills/dosu` as the owned
        // canonical directory and makes a non-universal agent's target a
        // symlink to it. A later single-agent run asks skills@1.5.22 for a
        // direct target, but the existing exact Claude or Factory layout is
        // still ours and must remain idempotent.
        if (target.symlink || !reusableCanonicalAdapterPaths.has(resolve(target.path))) {
          return { ok: false, reason: "project_skill_foreign_symlink", path: target.path };
        }
        let canonicalRealPath: string;
        try {
          canonicalRealPath = realpathSync(sharedCanonicalPath);
        } catch {
          return { ok: false, reason: "project_skill_foreign_symlink", path: target.path };
        }
        if (realPath !== canonicalRealPath) {
          return { ok: false, reason: "project_skill_foreign_symlink", path: target.path };
        }
        const canonical = inspectSharedCanonical();
        if (!canonical) {
          return { ok: false, reason: "project_skill_modified", path: sharedCanonicalPath };
        }
        directRealPaths.add(canonical.realPath);
        if (!evidence.some((item) => item.path === canonical.path)) evidence.push(canonical);
      }
      evidence.push({ kind: "symlink", path: target.path, realPath });
    } catch {
      return { ok: false, reason: "project_skill_foreign_symlink", path: target.path };
    }
  }

  return { ok: true, evidence };
}

export function assertProjectSkillInstallSafe(input: {
  projectRoot: string;
  targets: readonly ProjectSkillTarget[];
}): void {
  const lockPath = join(input.projectRoot, LOCK_NAME);
  assertSafeProjectPath(input.projectRoot, lockPath);
  for (const target of input.targets) {
    assertSafeProjectPath(input.projectRoot, join(target.path, ".."));
  }

  const lock = inspectLock(input.projectRoot);
  const anyTargetExists = input.targets.some((target) => entryExists(target.path));
  if (lock.kind === "invalid" || (lock.kind === "absent" && anyTargetExists)) {
    throw new Error("Cannot prove ownership of the existing project Dosu skill");
  }
  if (lock.kind === "unclaimed" && anyTargetExists) {
    throw new Error("Cannot prove ownership of the existing project Dosu skill");
  }
  if (lock.kind !== "owned") return;

  const targets = inspectTargets({
    ...input,
    expectedHash: lock.computedHash,
    requireAll: false,
  });
  if (!targets.ok) throw new Error("Cannot prove ownership of the existing project Dosu skill");
}

export function verifyProjectSkillInstallation(input: {
  projectRoot: string;
  targets: readonly ProjectSkillTarget[];
}): ProjectSkillVerification {
  const lock = inspectLock(input.projectRoot);
  if (lock.kind !== "owned") {
    return {
      ok: false,
      reason: "project_skill_lock_mismatch",
      path: join(input.projectRoot, LOCK_NAME),
    };
  }
  const targets = inspectTargets({
    ...input,
    expectedHash: lock.computedHash,
    requireAll: true,
  });
  return targets.ok ? { ok: true, evidence: [lock.evidence, ...targets.evidence] } : targets;
}

export function projectSkillEvidenceUnchanged(
  evidence: ProjectSkillEvidence,
  projectRoot: string,
): boolean {
  try {
    const stat = lstatSync(evidence.path);
    if (evidence.kind === "symlink") {
      return stat.isSymbolicLink() && realpathSync(evidence.path) === evidence.realPath;
    }
    if (stat.isSymbolicLink() || realpathSync(evidence.path) !== evidence.realPath) return false;
    if (evidence.kind === "file") {
      return (
        stat.isFile() &&
        createHash("sha256").update(readFileSync(evidence.path)).digest("hex") === evidence.hash
      );
    }
    return Boolean(inspectDirectory(evidence.path, projectRoot, evidence.hash));
  } catch {
    return false;
  }
}
