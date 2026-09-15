/** Session display names for the Activity view's session rows; a name beats a UUID. Claude
 * sessions carry a generated summary line; every harness falls back to the first user message.
 * Results are cached per session on disk (a session's opening exchange never changes once the
 * file stops growing; failures retry when the mtime moves). */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import { readSessionTurns } from "./read";
import type { AgentSession } from "./scan";

type SessionHarness = AgentSession["harness"];

const CACHE_FILENAME = "session-titles.json";
const CACHE_SCHEMA_VERSION = 1;
const HEAD_LINES = 50;
const SESSION_NAME_MAX = 80;

interface CacheEntry {
  /** Resolved name; null = tried and failed (retried when mtime moves). */
  title: string | null;
  /** Session file mtime at resolution time, for retrying failures. */
  mtime: string;
}

interface CacheFile {
  schema_version: number;
  entries: Record<string, CacheEntry>;
}

function cachePath(configDir: string): string {
  return join(configDir, CACHE_FILENAME);
}

function loadCacheFile(configDir: string): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(readFileSync(cachePath(configDir), "utf-8")) as CacheFile;
    if (raw.schema_version !== CACHE_SCHEMA_VERSION || typeof raw.entries !== "object") return {};
    return raw.entries;
  } catch {
    return {};
  }
}

function saveCacheFile(configDir: string, entries: Record<string, CacheEntry>): void {
  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const path = cachePath(configDir);
    const tmp = `${path}.${process.pid}.tmp`;
    const file: CacheFile = { schema_version: CACHE_SCHEMA_VERSION, entries };
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Cache persistence is best-effort; next view recomputes.
  }
}

/** One-line cleanup: collapse whitespace and clip; empty becomes null. */
function cleanSessionName(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > SESSION_NAME_MAX ? `${line.slice(0, SESSION_NAME_MAX - 1)}…` : line;
}

/** Claude Code writes generated conversation titles as `{"type":"summary","summary":…}` lines. */
function claudeSummaryFromHead(text: string): string | null {
  for (const line of text.split("\n").slice(0, HEAD_LINES)) {
    if (!line.includes('"summary"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; summary?: unknown };
      if (obj.type === "summary" && typeof obj.summary === "string") {
        return cleanSessionName(obj.summary);
      }
    } catch {
      // A truncated line is expected near the head cap; keep scanning.
    }
  }
  return null;
}

/** Rebuild a session's file location from its store slug + id; only the layouts that encode
 * both (claude, cursor) reconstruct — other harnesses resolve only while still scannable. */
export function reconstructSession(
  harness: SessionHarness,
  id: string,
  slug: string | undefined,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): AgentSession | null {
  if (!slug) return null;
  const candidates: string[] = [];
  if (harness === "claude") {
    candidates.push(join(home, ".claude", "projects", slug, `${id}.jsonl`));
  } else if (harness === "cursor") {
    const project = join(home, ".cursor", "projects", slug);
    candidates.push(
      join(project, "agent-transcripts", id, `${id}.jsonl`),
      join(project, "agent-transcripts", `${id}.jsonl`),
    );
  } else {
    return null;
  }
  for (const path of candidates) {
    if (exists(path)) return { id, harness, path, project: slug, updated: "" };
  }
  return null;
}

/** Injectable boundaries, for tests. */
export interface SessionTitleDeps {
  readHead?: (path: string) => string | null;
  readTurns?: typeof readSessionTurns;
  mtime?: (path: string) => string;
}

function readHead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8").slice(0, 128 * 1024);
  } catch {
    return null;
  }
}

function fileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "";
  }
}

export interface SessionTitleResolver {
  /** The session's display name, or null when it can't be determined. */
  resolve(session: AgentSession): string | null;
  /** Cache-only lookup by `harness/id` key — for history rows with no session file at hand. */
  cached(key: string): string | null;
  /** Persist any newly resolved entries; call once after a batch. */
  flush(): void;
}

/** Cached resolver over one loaded cache file; misses read the session and are memoized. */
export function createSessionTitleResolver(
  configDir: string = getConfigDir(),
  deps: SessionTitleDeps = {},
): SessionTitleResolver {
  const head = deps.readHead ?? readHead;
  const turns = deps.readTurns ?? readSessionTurns;
  const mtime = deps.mtime ?? fileMtime;
  const entries = loadCacheFile(configDir);
  let dirty = false;

  const compute = (session: AgentSession): string | null => {
    if (session.harness === "claude") {
      const text = head(session.path);
      const summary = text ? claudeSummaryFromHead(text) : null;
      if (summary) return summary;
    }
    const firstUser = turns(session).find((t) => t.role === "user");
    return firstUser ? cleanSessionName(firstUser.text) : null;
  };

  return {
    cached(key) {
      return entries[key]?.title ?? null;
    },
    resolve(session) {
      const key = `${session.harness}/${session.id}`;
      const cached = entries[key];
      if (cached && (cached.title !== null || cached.mtime === mtime(session.path))) {
        return cached.title;
      }
      const title = compute(session);
      entries[key] = { title, mtime: mtime(session.path) };
      dirty = true;
      return title;
    },
    flush() {
      if (!dirty) return;
      saveCacheFile(configDir, entries);
      dirty = false;
    },
  };
}
