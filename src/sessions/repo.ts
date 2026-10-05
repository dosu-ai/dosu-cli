/** Git repository identity for session working directories: the `origin` remote, normalized to
 * the backend's `host/owner/repo` note key so study scope and notes speak the same name. */

import { execFileSync } from "node:child_process";

/** Git's own repo-selection variables, which a hook environment may carry; they would point every
 * `git -C <dir>` at the same repository. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

/** `host/owner/repo` for an scp-style or URL remote; null for local paths and unparseable input. */
export function normalizeRepoRemote(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  let host: string;
  let path: string;
  const scp = value.includes("://") ? null : /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !path.includes("/")) return null;
  const lowerHost = host.toLowerCase();
  // Matches the backend's normalize_repo: GitHub slugs are case-insensitive, others keep case.
  return `${lowerHost}/${lowerHost === "github.com" ? path.toLowerCase() : path}`;
}

/** Stdout of `git -C dir <args>`; null on a non-zero exit, a timeout, or no git. */
function gitOutput(dir: string, args: string[], timeout: number): string | null {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The normalized `origin` of the repository containing `dir`; null outside a git repo, without
 * an origin, or when git is unavailable. */
export function originRepoOfDir(dir: string): string | null {
  // Under Cursor's 2 s status-line kill, which also runs this.
  const out = gitOutput(dir, ["remote", "get-url", "origin"], 1_000);
  return out === null ? null : normalizeRepoRemote(out);
}

/** The branch checked out in `dir` right now; null on a detached HEAD or outside a repo. */
export function currentBranchOfDir(dir: string): string | null {
  const out = gitOutput(dir, ["symbolic-ref", "--short", "-q", "HEAD"], 1_000)?.trim();
  return out ? out : null;
}

/** `dir`'s HEAD reflog, newest first, one `HEAD@{<unix seconds>}\t<subject>` line per entry;
 * null outside a repo. */
export function headReflogOfDir(dir: string): string | null {
  return gitOutput(dir, ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", "HEAD"], 5_000);
}

/** Short display form of a repo key: `owner/repo`. */
export function displayRepo(repo: string): string {
  return repo.split("/").slice(1).join("/") || repo;
}
