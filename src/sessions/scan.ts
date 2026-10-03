/** Native agent-session scanner replacing the pinned deja-vu binary: enumerates each harness's
 * session logs directly and uses file mtime as `updated`. No index, no download, no subprocess. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The agents whose sessions the scanner finds, by the id the ledger keys them with. */
export const SESSION_HARNESSES = ["claude", "cursor", "codex", "opencode"] as const;
export type SessionHarness = (typeof SESSION_HARNESSES)[number];

export interface AgentSession {
  /** Session id: the log filename stem, or the DB row id for opencode. */
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

/** Codex: `sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, three fixed levels. */
function scanCodex(home: string, env: NodeJS.ProcessEnv): AgentSession[] {
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

/** opencode: sqlite rows, top-level sessions only (parent_id rows are subagent children that
 * would inflate the backlog). */
function scanOpencode(home: string, env: NodeJS.ProcessEnv): AgentSession[] {
  const dataDir = env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const dbPath = join(dataDir, "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];

  const rows = querySqlite(
    dbPath,
    "SELECT id, directory, time_updated FROM session WHERE parent_id IS NULL",
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
    });
  }
  return sessions;
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
 * CODEX_HOME, XDG_DATA_HOME). */
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
  }
}

/** Whether every scan lists the transcript at `path`, whatever its environment: one found only
 * under a relocated root is missed by a sync started from another agent's hook or a shell. */
export function scannedEverywhere(
  harness: SessionHarness,
  path: string,
  home: string = homedir(),
): boolean {
  return path.startsWith(`${defaultRoot(harness, home)}/`);
}

/** All local agent sessions across supported harnesses, newest first; missing harnesses
 * simply contribute nothing. */
export function scanAgentSessions(options: ScanSessionsOptions = {}): AgentSession[] {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  let sessions = [
    ...scanClaude(home, env),
    ...scanCursor(home),
    ...scanCodex(home, env),
    ...scanOpencode(home, env),
  ];
  if (options.since !== undefined) {
    // ISO-8601 strings with identical precision compare correctly as strings.
    const cutoff = options.since.toISOString();
    sessions = sessions.filter((s) => s.updated >= cutoff);
  }
  sessions.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return options.limit !== undefined ? sessions.slice(0, options.limit) : sessions;
}
