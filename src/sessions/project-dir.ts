/**
 * Session → working-directory resolution, the identity behind the mining
 * project filter. Each harness leaks the directory differently: Claude logs
 * carry `cwd` in their first lines, Codex in the session_meta line, opencode
 * stores the real path, and Cursor only a munged slug (`Users-james-...`)
 * that is resolved back against the live filesystem. Results are cached per
 * session (a session's cwd never changes) in the CLI config dir.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import type { AgentSession } from "./scan";

const CACHE_FILENAME = "project-dirs.json";
const CACHE_SCHEMA_VERSION = 1;

/** How much of a session log the cwd probe reads, and how many lines it tries. */
const HEAD_BYTES = 128 * 1024;
const HEAD_LINES = 50;

interface CacheEntry {
  /** Resolved directory; null = tried and failed (retried when mtime moves). */
  dir: string | null;
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
    // The cache is purely an optimization; failing to persist it is fine.
  }
}

/** First chunk of a file as text; null when unreadable. */
function readHead(path: string, bytes: number = HEAD_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Scan the head of a JSONL log for a cwd field (top-level or Codex meta). */
export function cwdFromJsonlHead(text: string): string | null {
  for (const line of text.split("\n").slice(0, HEAD_LINES)) {
    if (!line.includes('"cwd"')) continue;
    try {
      const obj = JSON.parse(line) as {
        cwd?: unknown;
        payload?: { cwd?: unknown };
      };
      const cwd = obj.cwd ?? obj.payload?.cwd;
      if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
    } catch {
      // A truncated final line is expected; keep scanning.
    }
  }
  return null;
}

/**
 * Resolve a munged path slug (`/` → `-`, e.g. `Users-james-Documents-dosu-cli`)
 * back to the real absolute path by trying both readings of every `-` against
 * the filesystem. Prefers new path segments and prunes on missing parents, so
 * lookups stay cheap; returns null when nothing on disk matches (e.g. the
 * directory was deleted).
 */
export function unmungeSlug(
  slug: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const tokens = slug.replace(/^-/, "").split("-");
  if (tokens.length === 0 || tokens[0] === "") return null;
  let budget = 5_000;

  const walk = (prefix: string, index: number): string | null => {
    if (budget-- <= 0) return null;
    if (index === tokens.length) return exists(prefix) ? prefix : null;
    // Descend into a new path segment only when the prefix is a real dir —
    // but never prune the hyphen branch: the prefix may be a partial segment
    // ("/tmp/dosu" on the way to "/tmp/dosu-cli") that exists only once the
    // remaining hyphenated tokens are appended.
    const asSegment =
      prefix === "" || exists(prefix) ? walk(`${prefix}/${tokens[index]}`, index + 1) : null;
    if (asSegment) return asSegment;
    return prefix === "" ? null : walk(`${prefix}-${tokens[index]}`, index + 1);
  };

  return walk("", 0);
}

/** Injectable boundaries, for tests. */
export interface ProjectDirDeps {
  exists?: (path: string) => boolean;
  readHead?: (path: string) => string | null;
  mtime?: (path: string) => string;
}

function fileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return "";
  }
}

export interface ProjectDirResolver {
  /** The session's working directory, or null when it can't be determined. */
  resolve(session: AgentSession): string | null;
  /** Persist any newly resolved entries; call once after a batch. */
  flush(): void;
}

/**
 * Cached resolver over one loaded cache file. Cache hits are pure map reads;
 * misses read the session head or probe the filesystem, then are memoized.
 */
export function createProjectDirResolver(
  configDir: string = getConfigDir(),
  deps: ProjectDirDeps = {},
): ProjectDirResolver {
  const exists = deps.exists ?? existsSync;
  const head = deps.readHead ?? readHead;
  const mtime = deps.mtime ?? fileMtime;
  const entries = loadCacheFile(configDir);
  let dirty = false;

  const compute = (session: AgentSession): string | null => {
    switch (session.harness) {
      case "opencode":
        // The scanner already read the real path out of the sqlite row.
        return session.project ?? null;
      case "claude": {
        const text = head(session.path);
        const cwd = text ? cwdFromJsonlHead(text) : null;
        if (cwd) return cwd;
        // Old or truncated logs: fall back to un-munging the project dir.
        return session.project ? unmungeSlug(session.project, exists) : null;
      }
      case "codex": {
        const text = head(session.path);
        return text ? cwdFromJsonlHead(text) : null;
      }
      case "cursor":
        return session.project ? unmungeSlug(session.project, exists) : null;
      default:
        return null;
    }
  };

  return {
    resolve(session) {
      const key = `${session.harness}/${session.id}`;
      const cached = entries[key];
      // Hits are final; failures are retried once the session file changes
      // (a young log may simply not have written its cwd line yet).
      if (cached && (cached.dir !== null || cached.mtime === mtime(session.path))) {
        return cached.dir;
      }
      const dir = compute(session);
      entries[key] = { dir, mtime: mtime(session.path) };
      dirty = true;
      return dir;
    },
    flush() {
      if (!dirty) return;
      saveCacheFile(configDir, entries);
      dirty = false;
    },
  };
}
