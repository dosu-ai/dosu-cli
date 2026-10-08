/** A Codex rollout's lineage. A subagent's rollout names the session that spawned it
 * (`parent_thread_id`), a fork's the session it was forked from (`forked_from_id`), in the
 * `session_meta` that opens it; the rollout of that session is found again among the others
 * under the same Codex home (`sessions/<yyyy>/<mm>/<dd>/` or `archived_sessions/`). */

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The `session_meta` fields naming the origin come before the instructions Codex inlines into
 * that first, long line. */
const META_PREFIX_BYTES = 16 * 1024;

/** A chain deeper than this (a fork of a fork of a subagent ...) is not followed further. */
const MAX_DEPTH = 8;

const THREAD_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PARENT_THREAD = new RegExp(`"parent_thread_id":"(${THREAD_ID})"`, "i");
const FORKED_FROM = new RegExp(`"forked_from_id":"(${THREAD_ID})"`, "i");

/** Where a rollout comes from: the thread it descends from, and whether it is that thread's
 * subagent (`thread_source: "subagent"`) rather than a fork or other continuation of it. */
export interface CodexOrigin {
  thread: string;
  subagent: boolean;
}

/** The thread a rollout descends from: a subagent's parent, else a fork's source; null for a
 * session of its own or a file this cannot read. */
export function codexOrigin(path: string): CodexOrigin | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(META_PREFIX_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8", 0, read).split("\n", 1)[0];
    if (!head.includes('"type":"session_meta"')) return null;
    const thread = PARENT_THREAD.exec(head)?.[1] ?? FORKED_FROM.exec(head)?.[1];
    if (!thread) return null;
    const subagent =
      head.includes('"thread_source":"subagent"') || head.includes('"source":{"subagent"');
    return { thread: thread.toLowerCase(), subagent };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function listDir(dir: string): { name: string; path: string; isDir: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      isDir: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/** The Codex home a rollout lives under, or null when it is not under one. */
function codexHomeOf(path: string): string | null {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const name = basename(dir);
    if (name === "sessions" || name === "archived_sessions") return dirname(dir);
  }
  return null;
}

function isRolloutOf(thread: string, name: string): boolean {
  return name.startsWith("rollout-") && name.toLowerCase().endsWith(`-${thread}.jsonl`);
}

/** The rollout of `thread`: beside `near` first (a subagent and its parent usually share a day),
 * then anywhere under the same Codex home. */
export function codexRolloutNear(thread: string, near: string): string | null {
  const besides = listDir(dirname(near)).find(
    (entry) => !entry.isDir && isRolloutOf(thread, entry.name),
  );
  if (besides) return besides.path;
  const home = codexHomeOf(near);
  return home === null ? null : codexRolloutOfThread(thread, home);
}

/** The rollout of `thread` (a Codex thread id) anywhere under the Codex home `home`, newest day
 * first; null when there is none. */
export function codexRolloutOfThread(thread: string, home: string): string | null {
  const id = thread.toLowerCase();
  const dirs: string[] = [];
  for (const year of listDir(join(home, "sessions"))) {
    for (const month of listDir(year.path)) {
      for (const day of listDir(month.path)) dirs.push(day.path);
    }
  }
  dirs.reverse().push(join(home, "archived_sessions"));
  for (const dir of dirs) {
    const found = listDir(dir).find((entry) => !entry.isDir && isRolloutOf(id, entry.name));
    if (found) return found.path;
  }
  return null;
}

/** The rollouts `path` descends from, nearest first, lazily: each is looked up only when the
 * caller asks for the next. Stops where a rollout names no origin, or its origin is gone. */
export function* codexAncestorRollouts(path: string): Generator<string> {
  const seen = new Set([path]);
  let current = path;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const thread = codexOrigin(current)?.thread;
    if (thread === undefined) return;
    const origin = codexRolloutNear(thread, current);
    if (origin === null || seen.has(origin)) return;
    seen.add(origin);
    yield origin;
    current = origin;
  }
}
