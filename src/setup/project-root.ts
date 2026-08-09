import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Resolve the Git worktree root that owns `cwd`; bare and non-Git directories return null. */
export function resolveProjectRoot(cwd: string = process.cwd()): string | null {
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (inside !== "true") return null;

    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return root ? resolve(root) : null;
  } catch {
    return null;
  }
}

/** Project-scoped commands must never fall back to writing in an arbitrary cwd. */
export function requireProjectRoot(cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(cwd);
  if (!root) {
    throw new Error(
      "Project-scoped setup must run inside a Git worktree. Change to the project and retry.",
    );
  }
  return root;
}
