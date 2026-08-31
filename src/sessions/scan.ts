/**
 * Native agent-session scanner — replaces the pinned deja-vu binary.
 *
 * The sync pipeline only ever needed "recent local sessions with updated
 * timestamps" for the watermark gate, so instead of downloading a Go binary
 * we enumerate each harness's session log files directly and use file mtime
 * as the session's `updated` time. No index, no download, no subprocess —
 * a scan is a handful of readdir/stat calls.
 *
 * Verified on-disk layouts (2026-08):
 * - Claude Code: `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`
 * - Cursor:      `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`
 * - Codex:       `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`
 *   (Codex honors `CODEX_HOME`, same as the hook registry.)
 * - opencode:    SQLite `session` table in `~/.local/share/opencode/opencode.db`
 *   (post file-storage migration; honors `XDG_DATA_HOME`). Read via the
 *   runtime's builtin sqlite — `bun:sqlite` in the compiled binary,
 *   `node:sqlite` on Node ≥22.13 — and silently skipped when neither exists,
 *   keeping the npm bundle dependency-free.
 *
 * Everything scanned here is by definition local-origin — the imported-vs-
 * local distinction deja tracked does not exist in this model.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join } from "node:path";

type SessionHarness = "claude" | "cursor" | "codex" | "opencode";

export interface AgentSession {
  /** Session id: the log filename stem, or the DB row id for opencode. */
  id: string;
  harness: SessionHarness;
  /**
   * Absolute path to where the session content lives — the .jsonl log for
   * file-based harnesses, the sqlite DB for opencode. What a miner would read.
   */
  path: string;
  /** Harness project directory/worktree, when the layout has one. */
  project?: string;
  /** ISO timestamp of the session's last activity. */
  updated: string;
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

/** Claude Code: one level of project dirs, session logs directly inside. */
function scanClaude(home: string): AgentSession[] {
  const sessions: AgentSession[] = [];
  for (const project of listDir(join(home, ".claude", "projects"))) {
    if (!project.isDir) continue;
    for (const entry of listDir(project.path)) {
      if (entry.isDir) continue;
      const session = sessionFromFile(entry.path, "claude", project.name);
      if (session) sessions.push(session);
    }
  }
  return sessions;
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

/**
 * Read-only query against a sqlite file using whichever builtin the current
 * runtime has. `createRequire` keeps both module ids out of the bundler's
 * static graph, so the node bundle never hard-references `bun:sqlite` and
 * vice versa. Returns null when no builtin is available (Node <22.13) or the
 * file is not a readable database. Exported for the session reader.
 */
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

/**
 * opencode: sessions live as rows in a sqlite DB, not per-session files.
 * Top-level sessions only — rows with a parent_id are subagent children and
 * would inflate the backlog. `time_updated` is epoch milliseconds.
 */
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

/**
 * All local agent sessions across supported harnesses, newest first.
 * Missing harnesses simply contribute nothing — no errors, no detection step.
 */
export function scanAgentSessions(options: ScanSessionsOptions = {}): AgentSession[] {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  let sessions = [
    ...scanClaude(home),
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
