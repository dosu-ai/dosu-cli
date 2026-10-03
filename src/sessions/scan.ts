/** Native agent-session scanner replacing the pinned deja-vu binary: enumerates each harness's
 * session logs directly and uses file mtime as `updated`. No index, no download, no subprocess. */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readPiHeader } from "./pi";

/** The agents whose sessions the scanner finds, by the id the ledger keys them with. */
export const SESSION_HARNESSES = ["claude", "cursor", "codex", "opencode", "pi"] as const;
export type SessionHarness = (typeof SESSION_HARNESSES)[number];

export interface AgentSession {
  /** Session id: the log filename stem, the DB row id for opencode, or for pi the id in the
   * transcript's header. */
  id: string;
  harness: SessionHarness;
  /** Where the session content lives: the .jsonl log, or the sqlite DB for opencode. */
  path: string;
  /** Harness project directory/worktree, when the layout has one. */
  project?: string;
  /** ISO timestamp of the session's last activity. */
  updated: string;
  /** The parent session's id, for a subagent or other child session (shipped as
   * parent_session_id). */
  parentId?: string;
  /** The session this one was forked or cloned from (pi's /fork, /clone, --fork): its transcript
   * opens with a copy of that one's history. Not a subagent: it lives on after that session ends.
   * Shipped as its child, without the copied history. */
  forkOf?: { id: string; path: string };
  /** Normalized origin repo (`host/owner/repo`), attached once the study scope resolves it. */
  repo?: string;
  /** Git branch the session ran on, attached once sync resolves it for a study batch. */
  branch?: string;
}

export interface ScanSessionsOptions {
  /** Home directory override, injectable for tests. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Keep only sessions updated at or after this time. */
  since?: Date;
  /** Keep only the N most recently updated sessions. */
  limit?: number;
}

/** readdir that treats a missing or unreadable directory as empty. */
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

function sessionFromFile(
  filePath: string,
  harness: SessionHarness,
  project?: string,
): AgentSession | null {
  const name = basename(filePath);
  if (!name.endsWith(".jsonl")) return null;
  let mtime: Date;
  try {
    mtime = statSync(filePath).mtime;
  } catch {
    return null;
  }
  return {
    id: name.slice(0, -".jsonl".length),
    harness,
    path: filePath,
    ...(project ? { project } : {}),
    updated: mtime.toISOString(),
  };
}

/** Claude Code keeps each subagent's transcript in a directory named for its session:
 * `<project>/<session id>/subagents/agent-<agent id>.jsonl`, and a workflow's agents one level
 * down, in `subagents/workflows/<workflow id>/`. Every one is a session of its own, shipped with
 * its parent's id (a nested subagent's parent is the top-level session too). */
const CLAUDE_SUBAGENTS_DIR = "subagents";
const CLAUDE_WORKFLOWS_DIR = "workflows";

function claudeSubagents(sessionDir: string, parentId: string, project: string): AgentSession[] {
  const subagentsDir = join(sessionDir, CLAUDE_SUBAGENTS_DIR);
  const dirs = [
    subagentsDir,
    ...listDir(join(subagentsDir, CLAUDE_WORKFLOWS_DIR))
      .filter((workflow) => workflow.isDir)
      .map((workflow) => workflow.path),
  ];
  const sessions: AgentSession[] = [];
  for (const entry of dirs.flatMap(listDir)) {
    if (entry.isDir || !entry.name.startsWith("agent-")) continue;
    const session = sessionFromFile(entry.path, "claude", project);
    if (session) sessions.push({ ...session, parentId });
  }
  return sessions;
}

/** The directory of the session a subagent's transcript belongs to, or null for a top-level
 * transcript. */
function claudeSessionDirOf(path: string): string | null {
  const dir = dirname(path);
  if (basename(dir) === CLAUDE_SUBAGENTS_DIR) return dirname(dir);
  const workflows = dirname(dir);
  if (
    basename(workflows) === CLAUDE_WORKFLOWS_DIR &&
    basename(dirname(workflows)) === CLAUDE_SUBAGENTS_DIR
  ) {
    return dirname(dirname(workflows));
  }
  return null;
}

/** Claude Code: one level of project dirs, session logs directly inside, under `~/.claude` and
 * under CLAUDE_CONFIG_DIR when the agent was relocated there (the hooks install there too). Both,
 * because a sync triggered by another agent's hook does not have the variable. */
function scanClaude(home: string, env: NodeJS.ProcessEnv): AgentSession[] {
  const relocated = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : null;
  const roots = new Set([join(home, ".claude"), relocated ?? join(home, ".claude")]);
  const sessions: AgentSession[] = [];
  for (const root of roots) {
    for (const project of listDir(join(root, "projects"))) {
      if (!project.isDir) continue;
      for (const entry of listDir(project.path)) {
        if (entry.isDir) {
          sessions.push(...claudeSubagents(entry.path, entry.name, project.name));
          continue;
        }
        const session = sessionFromFile(entry.path, "claude", project.name);
        if (session) sessions.push(session);
      }
    }
  }
  return sessions;
}

/** The Claude Code session a transcript path belongs to, read off the layout: the project slug,
 * and for a subagent's transcript the parent session's id. */
function claudeLayoutOf(path: string): Pick<AgentSession, "project" | "parentId"> {
  const sessionDir = claudeSessionDirOf(path);
  if (sessionDir) {
    return { project: basename(dirname(sessionDir)), parentId: basename(sessionDir) };
  }
  return { project: basename(dirname(path)) };
}

/** Cursor: per-project `agent-transcripts/<uuid>/<uuid>.jsonl`. */
function scanCursor(home: string): AgentSession[] {
  const sessions: AgentSession[] = [];
  for (const project of listDir(join(home, ".cursor", "projects"))) {
    if (!project.isDir) continue;
    for (const entry of listDir(join(project.path, "agent-transcripts"))) {
      // Each transcript is a directory holding a single <uuid>.jsonl, but
      // tolerate bare .jsonl files in case the layout flattens again.
      const files = entry.isDir ? listDir(entry.path).filter((f) => !f.isDir) : [entry];
      for (const file of files) {
        const session = sessionFromFile(file.path, "cursor", project.name);
        if (session) sessions.push(session);
      }
    }
  }
  return sessions;
}

/** How much of a rollout to read for its lineage: the `session_meta` fields naming a parent come
 * before the instructions Codex inlines into that first, long line. */
const CODEX_META_PREFIX_BYTES = 16 * 1024;

/** A rollout's name ends in its thread id: `rollout-<time>-<uuid>`. */
const ROLLOUT_THREAD_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The thread that spawned a Codex subagent rollout (`thread_source: "subagent"`, with
 * `parent_thread_id` in its `session_meta`); null for any other rollout, forks included. */
function codexParentThread(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(CODEX_META_PREFIX_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.toString("utf8", 0, read).split("\n", 1)[0];
    if (!head.includes('"type":"session_meta"')) return null;
    if (!head.includes('"thread_source":"subagent"') && !head.includes('"source":{"subagent"')) {
      return null;
    }
    return /"parent_thread_id":"([^"]+)"/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Codex: `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, three fixed levels, plus the rollouts it
 * archived, flat in `archived_sessions/`. A subagent's rollout names its parent's rollout, the
 * scanner's id for that session, or the bare thread id when that rollout is gone. Only sessions
 * at or after `since` are opened for that. */
function scanCodex(home: string, env: NodeJS.ProcessEnv, since?: Date): AgentSession[] {
  const codexHome = env.CODEX_HOME ?? join(home, ".codex");
  const sessions: AgentSession[] = [];
  for (const year of listDir(join(codexHome, "sessions"))) {
    if (!year.isDir) continue;
    for (const month of listDir(year.path)) {
      if (!month.isDir) continue;
      for (const day of listDir(month.path)) {
        if (!day.isDir) continue;
        for (const entry of listDir(day.path)) {
          if (entry.isDir) continue;
          const session = sessionFromFile(entry.path, "codex");
          if (session) sessions.push(session);
        }
      }
    }
  }
  for (const entry of listDir(join(codexHome, "archived_sessions"))) {
    if (entry.isDir) continue;
    const session = sessionFromFile(entry.path, "codex");
    if (session) sessions.push(session);
  }

  const rolloutOfThread = new Map<string, string>();
  for (const session of sessions) {
    const thread = ROLLOUT_THREAD_ID.exec(session.id)?.[1];
    if (thread) rolloutOfThread.set(thread.toLowerCase(), session.id);
  }
  const cutoff = since?.toISOString();
  for (const session of sessions) {
    if (cutoff !== undefined && session.updated < cutoff) continue;
    const parent = codexParentThread(session.path);
    if (parent) session.parentId = rolloutOfThread.get(parent.toLowerCase()) ?? parent;
  }
  return sessions;
}

export type SqliteRows = Record<string, unknown>[];

interface BunSqliteModule {
  Database: new (
    path: string,
    options: { readonly: boolean },
  ) => { query(sql: string): { all(): SqliteRows }; close(): void };
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean },
  ) => { prepare(sql: string): { all(): SqliteRows }; close(): void };
}

/** Read-only sqlite query via the runtime's builtin; `createRequire` keeps both module ids out
 * of the bundler's static graph. Null when no builtin exists or the file is not a database. */
export function querySqlite(dbPath: string, sql: string): SqliteRows | null {
  const requireRuntime = createRequire(import.meta.url);
  /* v8 ignore start -- exercised only when the test runner is Bun */
  if (process.versions.bun) {
    try {
      const { Database } = requireRuntime("bun:sqlite") as BunSqliteModule;
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.query(sql).all();
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }
  /* v8 ignore stop */
  try {
    // node:sqlite emits an ExperimentalWarning on first load; silence it so
    // hook-quiet runs and --json output stay clean on stderr.
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    let sqlite: NodeSqliteModule;
    try {
      sqlite = requireRuntime("node:sqlite") as NodeSqliteModule;
    } finally {
      process.emitWarning = emitWarning;
    }
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** opencode: sqlite rows. A subagent's work is a child session (parent_id set), listed as its own
 * session that names its parent, like Claude Code's subagent transcripts. `id` reads that one
 * session's row alone. */
function scanOpencode(home: string, env: NodeJS.ProcessEnv, id?: string): AgentSession[] {
  const dataDir = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const dbPath = join(dataDir, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];

  const where = id === undefined ? "" : ` WHERE id = '${id}'`;
  const rows = querySqlite(
    dbPath,
    `SELECT id, parent_id, directory, time_updated FROM session${where}`,
  );
  if (!rows) return [];

  const sessions: AgentSession[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.time_updated !== "number") continue;
    sessions.push({
      id: row.id,
      harness: "opencode",
      path: dbPath,
      ...(typeof row.directory === "string" && row.directory !== ""
        ? { project: row.directory }
        : {}),
      updated: new Date(row.time_updated).toISOString(),
      ...(typeof row.parent_id === "string" && row.parent_id !== ""
        ? { parentId: row.parent_id }
        : {}),
    });
  }
  return sessions;
}

/** pi names a transcript `<timestamp>_<session id>.jsonl` (the timestamp has no underscore): the
 * id of a transcript whose header cannot say. */
function piSessionIdOfName(path: string): string {
  const stem = basename(path, ".jsonl");
  const cut = stem.indexOf("_");
  return cut === -1 ? stem : stem.slice(cut + 1);
}

/** A pi session, keyed by its header's id; a fork or clone (`/fork`, `/clone`, `--fork`) names
 * the transcript it copied in the header. `id` is what a hook already called it, when one did. */
function piSession(path: string, project?: string, id?: string): AgentSession | null {
  let mtime: Date;
  try {
    mtime = statSync(path).mtime;
  } catch {
    return null;
  }
  const header = readPiHeader(path);
  const parent = header?.parentSession;
  return {
    id: id ?? header?.id ?? piSessionIdOfName(path),
    harness: "pi",
    path,
    ...(project ? { project } : {}),
    updated: mtime.toISOString(),
    ...(parent
      ? { forkOf: { id: readPiHeader(parent)?.id ?? piSessionIdOfName(parent), path: parent } }
      : {}),
  };
}

/** `~` and `~/x` as pi expands them; null for a relative path, which pi resolves against a
 * working directory the scan does not have. */
function piPath(value: unknown, home: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const path = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return isAbsolute(path) ? resolve(path) : null;
}

/** The `sessionDir` setting of a pi agent directory's settings.json, when it names a place. */
function piSessionDirSetting(agentDir: string, home: string): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    return piPath(settings?.sessionDir, home);
  } catch {
    return null;
  }
}

/** pi: `<agent dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl`, under `~/.pi/agent` and under
 * PI_CODING_AGENT_DIR (both, as for Claude Code: a sync another agent's hook started does not
 * have the variable), plus the flat folder a session-dir override writes straight into:
 * PI_CODING_AGENT_SESSION_DIR, or the `sessionDir` setting. */
function scanPi(home: string, env: NodeJS.ProcessEnv): AgentSession[] {
  const agentDirs = new Set([join(home, ".pi", "agent")]);
  const relocated = piPath(env.PI_CODING_AGENT_DIR, home);
  if (relocated) agentDirs.add(relocated);
  const flatDirs = new Set<string>();
  const envSessionDir = piPath(env.PI_CODING_AGENT_SESSION_DIR, home);
  if (envSessionDir) flatDirs.add(envSessionDir);
  for (const agentDir of agentDirs) {
    const setting = piSessionDirSetting(agentDir, home);
    if (setting) flatDirs.add(setting);
  }

  // By path: an override may point into a folder the default layout lists too.
  const sessions = new Map<string, AgentSession>();
  const add = (path: string, name: string, project?: string) => {
    if (!name.endsWith(".jsonl") || sessions.has(path)) return;
    const session = piSession(path, project);
    if (session) sessions.set(path, session);
  };
  for (const agentDir of agentDirs) {
    for (const project of listDir(join(agentDir, "sessions"))) {
      if (!project.isDir) continue;
      for (const entry of listDir(project.path)) {
        if (!entry.isDir) add(entry.path, entry.name, project.name);
      }
    }
  }
  for (const dir of flatDirs) {
    for (const entry of listDir(dir)) if (!entry.isDir) add(entry.path, entry.name);
  }
  return [...sessions.values()];
}

/** One opencode session, as the scan would report it, read by its id (which opencode's plugin
 * names): null when the DB has no such session. */
export function opencodeSessionById(
  id: string,
  options: Pick<ScanSessionsOptions, "homeDir" | "env"> = {},
): AgentSession | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const [session] = scanOpencode(options.homeDir ?? homedir(), options.env ?? process.env, id);
  return session ?? null;
}

/** One session whose transcript the caller already knows (a session-end hook named it), as the
 * scan would report it; it may live outside the roots the scan walks (e.g. a relocated Claude
 * config dir). Null when the file is gone. */
export function sessionAtPath(
  harness: SessionHarness,
  id: string,
  path: string,
): AgentSession | null {
  let mtime: Date;
  try {
    mtime = statSync(path).mtime;
  } catch {
    return null;
  }
  if (harness === "pi") {
    // pi's per-directory folder, as scanPi reports it; a flat override folder is no project.
    const folder = basename(dirname(path));
    return piSession(path, /^--.*--$/.test(folder) ? folder : undefined, id);
  }
  // Claude Code keeps transcripts in their project dir, like scanClaude reads them.
  const layout = harness === "claude" ? claudeLayoutOf(path) : {};
  return {
    id,
    harness,
    path,
    ...(layout.project ? { project: layout.project } : {}),
    ...(layout.parentId ? { parentId: layout.parentId } : {}),
    updated: mtime.toISOString(),
  };
}

/** The child sessions (subagents' transcripts) of a session the scan may not list, read beside
 * its transcript; none for a harness without them. */
export function childSessionsOf(session: AgentSession): AgentSession[] {
  if (session.harness !== "claude" || session.parentId || !session.path.endsWith(".jsonl")) {
    return [];
  }
  const stem = session.path.slice(0, -".jsonl".length);
  return claudeSubagents(stem, session.id, basename(dirname(session.path)));
}

/** The session a child session (a subagent's transcript) belongs to, as the scan would report
 * it; null for a top-level session, or when the parent's transcript is gone. Children inherit
 * what their parent decided: whether it ended, its incognito opt-out, and its project key. */
export function parentSessionOf(session: AgentSession): AgentSession | null {
  if (!session.parentId || session.harness !== "claude") return null;
  // <project>/<parent id>/subagents/[workflows/<wf>/]agent-<id>.jsonl → <project>/<parent id>.jsonl
  const sessionDir = claudeSessionDirOf(session.path);
  if (!sessionDir) return null;
  return sessionAtPath("claude", session.parentId, `${sessionDir}.jsonl`);
}

/** Where each harness keeps its sessions when no variable relocates it (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, XDG_DATA_HOME, PI_CODING_AGENT_DIR). */
function defaultRoot(harness: SessionHarness, home: string): string {
  switch (harness) {
    case "claude":
      return join(home, ".claude", "projects");
    case "cursor":
      return join(home, ".cursor", "projects");
    case "codex":
      return join(home, ".codex", "sessions");
    case "opencode":
      return join(home, ".local", "share", "opencode");
    case "pi":
      return join(home, ".pi", "agent", "sessions");
  }
}

/** Whether every scan lists the transcript at `path`, whatever its environment: one found only
 * under a relocated root is missed by a sync started from another agent's hook or a shell. */
export function scannedEverywhere(
  harness: SessionHarness,
  path: string,
  home: string = homedir(),
): boolean {
  const roots = [defaultRoot(harness, home)];
  if (harness === "codex") roots.push(join(home, ".codex", "archived_sessions"));
  return roots.some((root) => path.startsWith(`${root}/`));
}

/** All local agent sessions across supported harnesses, newest first; missing harnesses
 * simply contribute nothing. */
export function scanAgentSessions(options: ScanSessionsOptions = {}): AgentSession[] {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  let sessions = [
    ...scanClaude(home, env),
    ...scanCursor(home),
    ...scanCodex(home, env, options.since),
    ...scanOpencode(home, env),
    ...scanPi(home, env),
  ];
  if (options.since !== undefined) {
    // ISO-8601 strings with identical precision compare correctly as strings.
    const cutoff = options.since.toISOString();
    sessions = sessions.filter((s) => s.updated >= cutoff);
  }
  sessions.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return options.limit !== undefined ? sessions.slice(0, options.limit) : sessions;
}
