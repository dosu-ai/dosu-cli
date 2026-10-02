/** Session working-directory, repo, and project resolution; each harness leaks the cwd
 * differently. Results are cached per session (a session's cwd never changes). */

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
import {
  branchFromClaudeTranscript,
  branchFromCodexTranscript,
  branchFromReflog,
  parseReflog,
} from "./branch";
import { type CapturedSession, readCapturedSession } from "./capture";
import { gitProjectOfDir, type ProjectKey, projectOverride } from "./project";
import { currentBranchOfDir, headReflogOfDir, originRepoOfDir } from "./repo";
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
  /** Normalized origin repo of `dir`; null = not a repo (retried when mtime moves); absent =
   * never looked up. */
  repo?: string | null;
  /** What git says the project of `dir` is (project.ts rules 3-5); a `path` fallback is retried
   * when mtime moves, like a null repo. Links and DOSU_PROJECT are never cached. */
  project?: ProjectKey;
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

/** Resolve a munged path slug (slashes replaced by hyphens) back to a real absolute path by
 * trying both readings of every hyphen against the filesystem; null when nothing matches. */
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
    // Descend into a new segment only when the prefix is a real dir, but never prune the
    // hyphen branch: the prefix may be a partial segment that only exists once completed.
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
  repoOfDir?: (dir: string) => string | null;
  readTranscript?: (path: string) => string | null;
  captured?: (key: string) => CapturedSession | null;
  reflogOfDir?: (dir: string) => string | null;
  currentBranch?: (dir: string) => string | null;
  gitProjectOfDir?: (dir: string) => ProjectKey;
  /** Source of DOSU_PROJECT; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

function readWholeFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
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

export interface ProjectDirResolver {
  /** The session's working directory, or null when it can't be determined. */
  resolve(session: AgentSession): string | null;
  /** The normalized origin repo of the session's working directory, or null outside a repo. */
  resolveRepo(session: AgentSession): string | null;
  /** The session's project key; null only when neither its working directory nor DOSU_PROJECT
   * is known. */
  resolveProject(session: AgentSession): ProjectKey | null;
  /** The project key for a session whose working directory the caller already knows (a hook
   * payload's cwd), cached under the same `harness/id` key so the shipped session agrees. */
  resolveProjectAt(key: string, dir: string): ProjectKey;
  /** The branch the session ran on, or null when nothing recorded it. Not cached: a session's
   * branch can move until it ends, and each session is resolved about once. */
  resolveBranch(session: AgentSession): string | null;
  /** Cache-only lookup by `harness/id` key — for history rows with no session file at hand. */
  cached(key: string): string | null;
  /** Persist any newly resolved entries; call once after a batch. */
  flush(): void;
}

/** Cached resolver over one loaded cache file; misses read the session head or probe the
 * filesystem, then are memoized. */
export function createProjectDirResolver(
  configDir: string = getConfigDir(),
  deps: ProjectDirDeps = {},
): ProjectDirResolver {
  const exists = deps.exists ?? existsSync;
  const head = deps.readHead ?? readHead;
  const mtime = deps.mtime ?? fileMtime;
  const captured = deps.captured ?? ((key: string) => readCapturedSession(key, configDir));
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
      case "cursor": {
        // The stop hook records the real workspace root; the slug is only a guess at it.
        const hookDir = captured(`cursor/${session.id}`)?.dir;
        if (hookDir) return hookDir;
        return session.project ? unmungeSlug(session.project, exists) : null;
      }
      default:
        return null;
    }
  };

  const repoOfDir = deps.repoOfDir ?? originRepoOfDir;
  // Many sessions share a directory; one git call per directory per resolver.
  const repoByDir = new Map<string, string | null>();
  const readTranscript = deps.readTranscript ?? readWholeFile;
  const reflogOfDir = deps.reflogOfDir ?? headReflogOfDir;
  const currentBranch = deps.currentBranch ?? currentBranchOfDir;
  const reflogByDir = new Map<string, ReturnType<typeof parseReflog>>();
  const currentByDir = new Map<string, string | null>();

  const transcriptBranch = (session: AgentSession): string | null => {
    if (session.harness !== "claude" && session.harness !== "codex") return null;
    const text = readTranscript(session.path);
    if (text === null) return null;
    return session.harness === "claude"
      ? branchFromClaudeTranscript(text)
      : branchFromCodexTranscript(text);
  };

  const reflogBranch = (session: AgentSession): string | null => {
    const dir = resolve(session);
    const end = Date.parse(session.updated);
    if (dir === null || Number.isNaN(end)) return null;
    let entries = reflogByDir.get(dir);
    if (!entries) {
      entries = parseReflog(reflogOfDir(dir) ?? "");
      reflogByDir.set(dir, entries);
    }
    return branchFromReflog(entries, Math.floor(end / 1000), () => {
      if (!currentByDir.has(dir)) currentByDir.set(dir, currentBranch(dir));
      return currentByDir.get(dir) ?? null;
    });
  };

  const resolve = (session: AgentSession): string | null => {
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
  };

  const gitProject = deps.gitProjectOfDir ?? gitProjectOfDir;
  const projectByDir = new Map<string, ProjectKey>();
  const overrideFor = (dir: string | null) => projectOverride(dir, { configDir, env: deps.env });

  /** Rules 3-5 for `dir`, through the session's cache entry when it is about the same dir. */
  const cachedGitProject = (key: string, dir: string, currentMtime: string): ProjectKey => {
    const entry = entries[key];
    const cacheable = entry !== undefined && entry.dir === dir;
    const hit = cacheable ? entry.project : undefined;
    if (hit && (hit.rule !== "path" || entry.mtime === currentMtime)) return hit;
    let project = projectByDir.get(dir);
    if (!project) {
      project = gitProject(dir);
      projectByDir.set(dir, project);
    }
    if (cacheable) {
      entry.project = project;
      entry.mtime = currentMtime;
      dirty = true;
    }
    return project;
  };

  return {
    cached(key) {
      return entries[key]?.dir ?? null;
    },
    resolve,
    resolveRepo(session) {
      const dir = resolve(session);
      if (dir === null) return null;
      const entry = entries[`${session.harness}/${session.id}`];
      // Cached per session, so a checkout deleted since still resolves to its repo.
      if (
        entry.repo !== undefined &&
        (entry.repo !== null || entry.mtime === mtime(session.path))
      ) {
        return entry.repo;
      }
      if (!repoByDir.has(dir)) repoByDir.set(dir, repoOfDir(dir));
      const repo = repoByDir.get(dir) ?? null;
      entry.repo = repo;
      entry.mtime = mtime(session.path);
      dirty = true;
      return repo;
    },
    resolveProject(session) {
      const dir = resolve(session);
      const override = overrideFor(dir);
      if (override) return override;
      if (dir === null) return null;
      return cachedGitProject(`${session.harness}/${session.id}`, dir, mtime(session.path));
    },
    resolveProjectAt(key, dir) {
      const override = overrideFor(dir);
      if (override) return override;
      if (!entries[key]) {
        // No session file to stamp yet: a `path` fallback answers the session's later prompts,
        // and is retried once the sync stamps the real file's mtime.
        entries[key] = { dir, mtime: "" };
        dirty = true;
      }
      return cachedGitProject(key, dir, entries[key].mtime);
    },
    resolveBranch(session) {
      return (
        transcriptBranch(session) ??
        captured(`${session.harness}/${session.id}`)?.branch ??
        reflogBranch(session)
      );
    },
    flush() {
      if (!dirty) return;
      saveCacheFile(configDir, entries);
      dirty = false;
    },
  };
}
