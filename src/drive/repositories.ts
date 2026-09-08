import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DejaSession, RepositoryIdentity } from "./types";

export function repositoryIdentity(path: string): RepositoryIdentity {
  const requested = resolve(path);
  const root = git(requested, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(`${requested} is not inside a Git repository`);
  const canonicalRoot = realpathSync(root);
  const remote = git(canonicalRoot, ["remote", "get-url", "origin"]);
  return {
    root: canonicalRoot,
    name: basename(canonicalRoot),
    ...(remote ? { remote } : {}),
  };
}

export function dedupeRepositories(
  repositories: readonly RepositoryIdentity[],
): RepositoryIdentity[] {
  const unique = new Map<string, RepositoryIdentity>();
  for (const repository of repositories) unique.set(repository.root, repository);
  return [...unique.values()];
}

export function matchSessionRepository(
  session: DejaSession,
  repositories: readonly RepositoryIdentity[],
): RepositoryIdentity | undefined {
  const strong = repositories.filter((repository) => stronglyMatches(session, repository));
  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return undefined;

  const project = normalizeProject(session.project);
  const weak = repositories.filter((repository) => {
    const tail = `${basename(dirname(repository.root))}/${repository.name}`;
    return project === repository.name || project === tail;
  });
  return weak.length === 1 ? weak[0] : undefined;
}

function stronglyMatches(session: DejaSession, repository: RepositoryIdentity): boolean {
  if (pathInside(session.project, repository.root)) return true;
  if (session.touched?.some((path) => pathInside(path, repository.root))) return true;

  if (session.harness === "codex" && session.path) {
    const cwd = codexSessionCwd(session.path);
    if (cwd && pathInside(cwd, repository.root)) return true;
  }

  if (session.harness === "claude" && session.path) {
    const encodedRoot = repository.root.split(sep).join("-");
    const projectDir = basename(dirname(session.path));
    if (projectDir === encodedRoot) return true;
  }
  return false;
}

function codexSessionCwd(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const head = readFileSync(path, "utf8").slice(0, 256 * 1024);
    for (const line of head.split("\n")) {
      if (!line.includes('"session_meta"')) continue;
      const value = JSON.parse(line) as { payload?: { cwd?: unknown } };
      if (typeof value.payload?.cwd === "string") return value.payload.cwd;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function pathInside(candidate: string, repositoryRoot: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const rel = relative(repositoryRoot, canonicalPath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...suffix);
}

function normalizeProject(project: string): string {
  return project
    .replaceAll("\\", "/")
    .replace(/^imported:/, "")
    .replace(/^\/+|\/+$/g, "");
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
