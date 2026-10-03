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
import { type CapturedSession, type EndedSession, readCapturedSession } from "./capture";
import {
  GIT_BUDGETS,
  type GitBudget,
  gitProjectOfDir,
  type ProjectKey,
  projectOverride,
} from "./project";
import { currentBranchOfDir, headReflogOfDir, originRepoOfDir } from "./repo";
import { type AgentSession, sessionAtPath } from "./scan";

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
  /** The session's project key (project.ts), as first resolved for it, by whichever rule; a
   * `path` fallback is retried when mtime moves, like a null repo. */
  project?: ProjectKey;
  /** A prompt hook's git lookup ran out of time: the session's later prompts skip git (and send
   * no key) rather than keep the user waiting again, and the sync resolves it patiently. */
  git_timed_out?: true;
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
  gitProjectOfDir?: (dir: string, budget: GitBudget, knownRoot?: string) => ProjectKey | null;
  /** The hook's environment, for resolveProjectAt's DOSU_PROJECT; defaults to process.env. */
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
  /** The session's project key, as first resolved for it and cached from then on, so prompt-time
   * memory and the shipped session agree and a deleted checkout still resolves. `agentEnv` is the
   * environment the session's own agent ran in, when the caller runs inside it (a hook for this
   * very session): only then does DOSU_PROJECT apply, since a sync shipping many sessions runs in
   * whichever agent's environment triggered it. Git gets the background budget. Null when
   * neither the working directory nor that DOSU_PROJECT is known, or git ran out of time. */
  resolveProject(session: AgentSession, agentEnv?: NodeJS.ProcessEnv): ProjectKey | null;
  /** The project key for a session whose working directory the caller already knows (a hook
   * payload's cwd), resolved in the hook's environment (`deps.env`) and cached under the same
   * `harness/id` key so the shipped session agrees. Git gets the prompt budget; null when it ran
   * out, then and on the session's later prompts. */
  resolveProjectAt(key: string, dir: string): ProjectKey | null;
  /** The branch the session ran on, or null when nothing recorded it. Not cached: a session's
   * branch can move until it ends, and each session is resolved about once. */
  resolveBranch(session: AgentSession): string | null;
  /** Cache-only lookup by `harness/id` key — for history rows with no session file at hand. */
  cached(key: string): string | null;
  /** Persist any newly resolved entries, merged into the file as it is now; call once after a
   * batch. */
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
  // Keys this resolver changed: a flush writes only these over the file as it is then, so it
  // never drops what a concurrent hook or sync cached since this one loaded.
  const touched = new Set<string>();

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
      case "codex":
      case "pi": {
        // Codex's session_meta and pi's session header both open the log with the cwd.
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
    // A key pinned while the directory was unknown (DOSU_PROJECT) stays the session's.
    const project = cached?.project;
    entries[key] = { dir, mtime: mtime(session.path), ...(project ? { project } : {}) };
    touched.add(key);
    return dir;
  };

  const gitProject = deps.gitProjectOfDir ?? gitProjectOfDir;
  const projectByDir = new Map<string, ProjectKey>();

  /** A root commit some session in `dir` was keyed by: the history walk is done once per
   * directory, not once per session (a long one may only fit a background budget). */
  const knownRootOf = (dir: string): string | undefined => {
    for (const entry of Object.values(entries)) {
      if (entry.dir === dir && entry.project?.rule === "root-commit") {
        return entry.project.project.slice("git:".length);
      }
    }
    return undefined;
  };

  /** All five rules for `dir` (only DOSU_PROJECT without one), git asked once per directory;
   * `budget` null skips git. Null when git ran out of time. */
  const freshProject = (
    dir: string | null,
    env: NodeJS.ProcessEnv,
    budget: GitBudget | null,
  ): ProjectKey | null => {
    const override = projectOverride(dir, { configDir, env });
    if (override || dir === null || budget === null) return override;
    let project = projectByDir.get(dir) ?? null;
    if (!project) {
      project = gitProject(dir, budget, knownRootOf(dir));
      if (project) projectByDir.set(dir, project);
    }
    return project;
  };

  /** The session's cached key, or a fresh one cached on its entry. Every rule is cached: the
   * session keeps the key it was first served or shipped under. A `path` answer, the last
   * resort, is retried once the session file changes (a repo may have its first commit now). */
  const sessionProject = (
    key: string,
    dir: string | null,
    currentMtime: string,
    env: NodeJS.ProcessEnv,
    patience: keyof typeof GIT_BUDGETS,
  ): ProjectKey | null => {
    const entry = entries[key];
    const hit = entry?.project;
    if (hit && (hit.rule !== "path" || entry.mtime === currentMtime)) return hit;
    const waitedBefore = patience === "prompt" && entry?.git_timed_out === true;
    const project = freshProject(dir, env, waitedBefore ? null : GIT_BUDGETS[patience]);
    if (entry && project) {
      entry.project = project;
      entry.mtime = currentMtime;
      delete entry.git_timed_out;
      touched.add(key);
    } else if (entry && dir !== null && patience === "prompt" && !waitedBefore) {
      // Git ran out of the prompt's budget.
      entry.git_timed_out = true;
      touched.add(key);
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
      const key = `${session.harness}/${session.id}`;
      const entry = entries[key];
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
      touched.add(key);
      return repo;
    },
    resolveProject(session, agentEnv = {}) {
      const dir = resolve(session);
      const key = `${session.harness}/${session.id}`;
      return sessionProject(key, dir, mtime(session.path), agentEnv, "background");
    },
    resolveProjectAt(key, dir) {
      if (!entries[key]) {
        // No session file to stamp yet: a `path` fallback answers the session's later prompts,
        // and is retried once the sync stamps the real file's mtime.
        entries[key] = { dir, mtime: "" };
        touched.add(key);
      }
      return sessionProject(key, dir, entries[key].mtime, deps.env ?? process.env, "prompt");
    },
    resolveBranch(session) {
      return (
        transcriptBranch(session) ??
        captured(`${session.harness}/${session.id}`)?.branch ??
        reflogBranch(session)
      );
    },
    flush() {
      if (touched.size === 0) return;
      const latest = loadCacheFile(configDir);
      for (const key of touched) latest[key] = entries[key];
      saveCacheFile(configDir, latest);
      touched.clear();
    },
  };
}

/** Resolve, in this process's environment, the projects of sessions a hook running in their own
 * agent's environment just reported as ended (`knowledge sync --ended`): besides the prompt hook,
 * the one place DOSU_PROJECT applies to a session. Cached like any answer, so the session ships
 * under that key whichever later run ships it; every other session in the run's batch is resolved
 * without this environment. */
export function pinEndedSessionProjects(
  ended: readonly EndedSession[],
  configDir: string = getConfigDir(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const resolver = createProjectDirResolver(configDir, { env });
  for (const { harness, id, path } of ended) {
    if (!harness || !id || !path) continue;
    const session = sessionAtPath(harness, id, path);
    if (session) resolver.resolveProject(session, env);
  }
  resolver.flush();
}
