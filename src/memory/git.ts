/** Git reads for agent memory: the session's starting commit and the diff snapshot. Every call
 * runs with optional locks off, so the user's index is never rewritten (not even the stat
 * refresh `git diff` normally writes) and never locked under their own git commands. */

import { spawnSync } from "node:child_process";

/** Git's repo-selection variables a hook environment may carry. */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"];

/** Lines kept per file, as the frozen memwriter's `head -n 80`. */
const LINES_PER_FILE = 80;
/** Snapshot budget; files past it keep only their `diff --git` header line. */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** Pin the default patch format whatever the user's git config says (prefixes, color, external
 * drivers, textconv, quoting), so the snapshot matches what the frozen memwriter captured. */
const DIFF_FLAGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

interface GitResult {
  status: number | null;
  stdout: string;
}

function git(dir: string, args: string[], timeoutMs = 10_000): GitResult {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  const result = spawnSync("git", ["-c", "core.quotePath=true", ...args], {
    cwd: dir,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  // A diff past maxBuffer is cut, which is fine: only its first lines are kept.
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** The commit checked out in `dir`; null outside a repo or before the first commit. */
export function headCommit(dir: string): string | null {
  const { status, stdout } = git(dir, ["rev-parse", "--verify", "-q", "HEAD"], 2_000);
  return status === 0 && stdout.trim() ? stdout.trim() : null;
}

function nulList(stdout: string): string[] {
  return stdout.split("\0").filter((name) => name !== "");
}

/** First `LINES_PER_FILE` lines, newlines kept, like `head -n 80`. */
function headLines(text: string): string {
  let end = -1;
  for (let i = 0; i < LINES_PER_FILE; i++) {
    end = text.indexOf("\n", end + 1);
    if (end === -1) return text;
  }
  return text.slice(0, end + 1);
}

/** The working tree's changes since `base` (null: since the empty tree) as per-file patches, each
 * cut to its first 80 lines, files in git's byte order with untracked (not ignored) files
 * interleaved, as the frozen memwriter's `git add -N . && git diff HEAD` capture produced them.
 * Past `SNAPSHOT_MAX_BYTES` a file contributes only its header line. Null when git fails. */
export function diffSnapshot(dir: string, base: string | null): string | null {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const from = base ?? git(root, ["hash-object", "-t", "tree", "--stdin"], 2_000).stdout.trim();
  const tracked = git(root, ["diff", "--name-only", "-z", from]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (tracked.status !== 0 || untracked.status !== 0) return null;

  const isUntracked = new Set(nulList(untracked.stdout).filter((name) => !name.endsWith("/")));
  const files = [...new Set([...nulList(tracked.stdout), ...isUntracked])].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );

  let snapshot = "";
  let size = 0;
  let full = false;
  for (const file of files) {
    const patch = isUntracked.has(file)
      ? git(root, ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", file]).stdout
      : git(root, ["diff", ...DIFF_FLAGS, from, "--", file]).stdout;
    if (!patch) continue;
    let part = headLines(patch);
    const partSize = Buffer.byteLength(part);
    if (full || size + partSize > SNAPSHOT_MAX_BYTES) {
      full = true;
      part = patch.slice(0, patch.indexOf("\n") + 1);
    }
    snapshot += part;
    size += Buffer.byteLength(part);
  }
  return snapshot.trim();
}
