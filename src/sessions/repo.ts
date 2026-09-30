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

/** The normalized `origin` of the repository containing `dir`; null outside a git repo, without
 * an origin, or when git is unavailable. */
export function originRepoOfDir(dir: string): string | null {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  try {
    const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      // Under Cursor's 2 s status-line kill, which also runs this.
      timeout: 1_000,
    });
    return normalizeRepoRemote(out);
  } catch {
    return null;
  }
}

/** Short display form of a repo key: `owner/repo`. */
export function displayRepo(repo: string): string {
  return repo.split("/").slice(1).join("/") || repo;
}
