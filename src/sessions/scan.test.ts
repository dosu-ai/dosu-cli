import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanAgentSessions } from "./scan";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-scan-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Hermetic scan: never let the host's CODEX_HOME/XDG_DATA_HOME leak in. */
function scan(overrides: { env?: NodeJS.ProcessEnv; since?: Date; limit?: number } = {}) {
  return scanAgentSessions({ homeDir: home, env: {}, ...overrides });
}

/** Create a file and pin its mtime so ordering assertions are deterministic. */
function makeLog(path: string, mtime: Date): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{}\n");
  utimesSync(path, mtime, mtime);
}

const T1 = new Date("2026-08-25T10:00:00Z");
const T2 = new Date("2026-08-25T11:00:00Z");
const T3 = new Date("2026-08-25T12:00:00Z");

function claudeLog(project: string, id: string, mtime: Date): void {
  makeLog(join(home, ".claude", "projects", project, `${id}.jsonl`), mtime);
}

function cursorLog(project: string, id: string, mtime: Date): void {
  makeLog(
    join(home, ".cursor", "projects", project, "agent-transcripts", id, `${id}.jsonl`),
    mtime,
  );
}

function codexLog(id: string, mtime: Date): void {
  makeLog(join(home, ".codex", "sessions", "2026", "08", "25", `${id}.jsonl`), mtime);
}

/**
 * Builds an opencode fixture DB with the runtime's sqlite builtin, mirroring
 * the scanner's own fallback. Returns false when the runtime has none, so
 * DB-backed tests skip instead of failing.
 */
function makeOpencodeDb(
  dbPath: string,
  rows: { id: string; parent_id?: string; directory?: string; time_updated: number }[],
): boolean {
  const requireRuntime = createRequire(import.meta.url);
  let exec: ((sql: string) => void) | null = null;
  let close: (() => void) | null = null;
  try {
    /* v8 ignore next 5 -- exercised only when the test runner is Bun */
    if (process.versions.bun) {
      const { Database } = requireRuntime("bun:sqlite");
      const db = new Database(dbPath, { create: true });
      exec = (sql) => db.exec(sql);
      close = () => db.close();
    } else {
      const { DatabaseSync } = requireRuntime("node:sqlite");
      const db = new DatabaseSync(dbPath);
      exec = (sql: string) => db.exec(sql);
      close = () => db.close();
    }
  } catch {
    return false;
  }
  exec(
    "CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, time_updated integer NOT NULL)",
  );
  for (const row of rows) {
    exec(
      `INSERT INTO session VALUES ('${row.id}', ${
        row.parent_id ? `'${row.parent_id}'` : "NULL"
      }, '${row.directory ?? ""}', ${row.time_updated})`,
    );
  }
  close?.();
  return true;
}

function opencodeDbPath(base: string = join(home, ".local", "share")): string {
  return join(base, "opencode", "opencode.db");
}

describe("scanAgentSessions", () => {
  it("returns an empty list when no harness dirs exist", () => {
    expect(scan()).toEqual([]);
  });

  it("finds sessions across file-based harnesses, newest first", () => {
    claudeLog("-Users-me-proj", "aaa", T1);
    cursorLog("Users-me-proj", "bbb", T3);
    codexLog("rollout-2026-08-25T04-00-00-ccc", T2);

    const sessions = scan();

    expect(sessions.map((s) => [s.harness, s.id])).toEqual([
      ["cursor", "bbb"],
      ["codex", "rollout-2026-08-25T04-00-00-ccc"],
      ["claude", "aaa"],
    ]);
  });

  it("reports updated from file mtime and carries the log path", () => {
    claudeLog("-Users-me-proj", "aaa", T1);

    const [session] = scan();

    expect(session.updated).toBe(T1.toISOString());
    expect(session.path).toBe(join(home, ".claude", "projects", "-Users-me-proj", "aaa.jsonl"));
    expect(session.project).toBe("-Users-me-proj");
  });

  it("ignores non-jsonl files and stray subdirectories", () => {
    claudeLog("-Users-me-proj", "aaa", T1);
    writeFileSync(join(home, ".claude", "projects", "-Users-me-proj", "notes.txt"), "x");
    // Some Claude project dirs contain plugin subdirectories instead of logs.
    mkdirSync(join(home, ".claude", "projects", "-Users-me-proj", "vercel-plugin"), {
      recursive: true,
    });

    const sessions = scan();

    expect(sessions.map((s) => s.id)).toEqual(["aaa"]);
  });

  it("tolerates a flattened Cursor transcript layout", () => {
    makeLog(join(home, ".cursor", "projects", "proj", "agent-transcripts", "flat.jsonl"), T2);

    const sessions = scan();

    expect(sessions.map((s) => [s.harness, s.id])).toEqual([["cursor", "flat"]]);
  });

  it("honors CODEX_HOME", () => {
    const codexHome = join(home, "custom-codex");
    makeLog(join(codexHome, "sessions", "2026", "08", "25", "rollout-x.jsonl"), T1);

    const sessions = scan({ env: { CODEX_HOME: codexHome } });

    expect(sessions.map((s) => s.id)).toEqual(["rollout-x"]);
  });

  it("applies the limit after sorting", () => {
    claudeLog("-p", "old", T1);
    claudeLog("-p", "mid", T2);
    claudeLog("-p", "new", T3);

    const sessions = scan({ limit: 2 });

    expect(sessions.map((s) => s.id)).toEqual(["new", "mid"]);
  });

  it("drops sessions older than `since` (cutoff itself is kept)", () => {
    claudeLog("-p", "old", T1);
    claudeLog("-p", "mid", T2);
    claudeLog("-p", "new", T3);

    const sessions = scan({ since: T2 });

    expect(sessions.map((s) => s.id)).toEqual(["new", "mid"]);
  });

  describe("opencode", () => {
    it("reads top-level sessions from the sqlite DB", () => {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      const created = makeOpencodeDb(opencodeDbPath(), [
        { id: "ses_top", directory: "/Users/me/proj", time_updated: T2.getTime() },
        { id: "ses_child", parent_id: "ses_top", time_updated: T3.getTime() },
        { id: "ses_no_dir", time_updated: T1.getTime() },
      ]);
      if (!created) return; // runtime has no sqlite builtin — scanner skips too

      const sessions = scan();

      expect(sessions.map((s) => [s.harness, s.id])).toEqual([
        ["opencode", "ses_top"],
        ["opencode", "ses_no_dir"],
      ]);
      expect(sessions[0].updated).toBe(T2.toISOString());
      expect(sessions[0].path).toBe(opencodeDbPath());
      expect(sessions[0].project).toBe("/Users/me/proj");
      expect(sessions[1].project).toBeUndefined();
    });

    it("honors XDG_DATA_HOME", () => {
      const xdg = join(home, "xdg-data");
      mkdirSync(join(xdg, "opencode"), { recursive: true });
      const created = makeOpencodeDb(opencodeDbPath(xdg), [
        { id: "ses_xdg", directory: "/p", time_updated: T1.getTime() },
      ]);
      if (!created) return;

      const sessions = scan({ env: { XDG_DATA_HOME: xdg } });

      expect(sessions.map((s) => s.id)).toEqual(["ses_xdg"]);
    });

    it("silently skips an unreadable or corrupt DB", () => {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      writeFileSync(opencodeDbPath(), "this is not a sqlite database");

      expect(scan()).toEqual([]);
    });
  });
});
