/** The git branch a session ran on, read from what was recorded at the time: sync can run days
 * after a session, so the checkout's current branch is only trusted when the reflog shows no
 * checkout since. */

/** Lines of a Codex log searched for its `session_meta` record. */
const CODEX_META_LINES = 50;

/** A recorded branch name, or null for the detached (`HEAD`) and empty values agents record. */
function recordedBranch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  return branch && branch !== "HEAD" ? branch : null;
}

/** Claude Code stamps `gitBranch` on every line; the last real one wins, since a session that
 * creates its feature branch partway through commits there. */
export function branchFromClaudeTranscript(text: string): string | null {
  let last: string | null = null;
  for (const match of text.matchAll(/"gitBranch":\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      last = recordedBranch(JSON.parse(match[1])) ?? last;
    } catch {
      // Malformed escape; keep the previous value.
    }
  }
  return last;
}

/** Codex records the branch once, in `session_meta.payload.git`, when the session starts. */
export function branchFromCodexTranscript(text: string): string | null {
  for (const line of text.split("\n", CODEX_META_LINES)) {
    if (!line.includes('"session_meta"')) continue;
    try {
      const record = JSON.parse(line) as {
        type?: unknown;
        payload?: { git?: { branch?: unknown } | null };
      };
      if (record.type === "session_meta") return recordedBranch(record.payload?.git?.branch);
    } catch {
      // Truncated line; keep looking.
    }
  }
  return null;
}

interface ReflogEntry {
  /** Unix seconds. */
  at: number;
  subject: string;
}

/** Parse `git reflog show --date=unix --format=%gd%x09%gs` output. */
export function parseReflog(out: string): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  for (const line of out.split("\n")) {
    const match = /^HEAD@\{(\d+)\}\t(.*)$/.exec(line);
    if (match) entries.push({ at: Number(match[1]), subject: match[2] });
  }
  return entries;
}

/** A checkout's branch side; a detached checkout records a commit id there instead. */
function checkoutBranch(name: string): string | null {
  return /^[0-9a-f]{7,40}$/.test(name) ? null : recordedBranch(name);
}

const CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/;

/** The branch checked out at `endSec`, reconstructed from the HEAD reflog (newest first): the
 * target of the last checkout before it, else the source of the first checkout after it, else
 * (no checkout at all) the current branch. Unknown when the reflog does not reach back that far. */
export function branchFromReflog(
  entries: readonly ReflogEntry[],
  endSec: number,
  currentBranch: () => string | null,
): string | null {
  if (entries.length === 0) return null;
  let oldest = Number.POSITIVE_INFINITY;
  let before: { at: number; to: string } | null = null;
  let after: { at: number; from: string } | null = null;
  for (const entry of entries) {
    oldest = Math.min(oldest, entry.at);
    const match = CHECKOUT.exec(entry.subject);
    if (!match) continue;
    // Newest first: on equal timestamps, the first seen is the later checkout.
    if (entry.at <= endSec) {
      if (!before || entry.at > before.at) before = { at: entry.at, to: match[2] };
    } else if (!after || entry.at <= after.at) {
      after = { at: entry.at, from: match[1] };
    }
  }
  if (endSec < oldest) return null;
  if (before) return checkoutBranch(before.to);
  if (after) return checkoutBranch(after.from);
  return currentBranch();
}
