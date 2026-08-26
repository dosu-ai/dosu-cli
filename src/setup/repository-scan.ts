import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { hasSymlinkInPath } from "./project-root";

export interface ScannedRepository {
  path: string;
  kind: "repository" | "worktree";
}

function expandInputPath(value: string, home: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(home, trimmed.slice(2));
  }
  return resolve(trimmed);
}

function containsPath(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== ".." && !isAbsolute(childRelative))
  );
}

/** Validate user-approved scan roots without ever accepting Home or a parent of Home. */
export function validateScanDirectories(
  inputs: readonly string[],
  home: string = homedir(),
): string[] {
  const resolvedHome = realpathSync(home);
  const directories: string[] = [];

  for (const input of inputs) {
    const candidate = expandInputPath(input, resolvedHome);
    if (existsSync(candidate) && hasSymlinkInPath(candidate)) {
      throw new Error(`Scan path contains a symbolic link: ${candidate}`);
    }
    if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
      throw new Error(`Scan path is not a directory: ${candidate}`);
    }
    const canonical = realpathSync(candidate);
    if (containsPath(canonical, resolvedHome)) {
      throw new Error("Choose a directory inside Home, not Home itself or one of its parents.");
    }
    if (!directories.includes(canonical)) directories.push(canonical);
  }

  if (directories.length === 0) throw new Error("Choose at least one scan directory.");
  return directories;
}

function gitCheckoutKind(path: string): ScannedRepository["kind"] | null {
  const marker = join(path, ".git");
  if (!existsSync(marker)) return null;
  let kind: ScannedRepository["kind"];
  try {
    const stat = lstatSync(marker);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) kind = "repository";
    else if (stat.isFile()) kind = "worktree";
    else return null;
    const reportedRoot = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (realpathSync(reportedRoot) !== realpathSync(path)) return null;
    return kind;
  } catch {
    return null;
  }
}

/** Recursively find checkout roots while skipping every symbolic-link directory. */
export function scanGitRepositories(scanDirectories: readonly string[]): ScannedRepository[] {
  const repositories = new Map<string, ScannedRepository>();
  const visited = new Set<string>();

  const visit = (path: string): void => {
    let canonical: string;
    try {
      if (lstatSync(path).isSymbolicLink()) return;
      canonical = realpathSync(path);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    const kind = gitCheckoutKind(canonical);
    if (kind) {
      repositories.set(canonical, { path: canonical, kind });
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(canonical, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      visit(join(canonical, entry.name));
    }
  };

  for (const directory of scanDirectories) visit(directory);
  return [...repositories.values()].sort((left, right) => left.path.localeCompare(right.path));
}
