import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanAgentSessions } from "./scan";

/** `homedir()` target for the default-home test; every other test passes `homeDir` explicitly. */
const mockedOs = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedOs.home };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-scan-test-"));
  mockedOs.home = home;
});

afterEach(() => {
  vi.unstubAllEnvs();
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

interface OpencodeRow {
  id: string;
  parent_id?: string;
  directory?: string;
  /** A string is stored as TEXT — sqlite's integer affinity keeps non-numeric text as-is. */
  time_updated: number | string;
  /** Raw SQL literal for the id column (e.g. a BLOB), overriding `id`. */
  idSql?: string;
}

/** Builds an opencode fixture DB with the runtime's sqlite builtin; returns false when the
 * runtime has none, so DB-backed tests skip instead of failing. */
function makeOpencodeDb(dbPath: string, rows: OpencodeRow[]): boolean {
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
    const id = row.idSql ?? `'${row.id}'`;
    const time =
      typeof row.time_updated === "number" ? String(row.time_updated) : `'${row.time_updated}'`;
    exec(
      `INSERT INTO session VALUES (${id}, ${
        row.parent_id ? `'${row.parent_id}'` : "NULL"
      }, '${row.directory ?? ""}', ${time})`,
    );
  }
  close?.();
  return true;
}

function opencodeDbPath(base: string = join(home, ".local", "share")): string {
  return join(base, "opencode", "opencode.db");
}

/** A pi transcript: `<dir>/<timestamp>_<id>.jsonl`, opening with the session header pi writes. */
function piLog(dir: string, id: string, mtime: Date, header: Record<string, unknown> = {}): string {
  const path = join(dir, `2026-08-25T10-00-00-000Z_${id}.jsonl`);
  mkdirSync(dir, { recursive: true });
  const first = { type: "session", version: 3, id, timestamp: "2026-08-25T10:00:00.000Z" };
  writeFileSync(path, `${JSON.stringify({ ...first, cwd: "/Users/me/proj", ...header })}\n`);
  utimesSync(path, mtime, mtime);
  return path;
}

/** pi's default per-directory session folder under an agent directory. */
function piProjectDir(agentDir: string = join(home, ".pi", "agent")): string {
  return join(agentDir, "sessions", "--Users-me-proj--");
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

  it("skips stray files at the project level and non-jsonl files inside transcript dirs", () => {
    claudeLog("-Users-me-proj", "aaa", T1);
    cursorLog("Users-me-proj", "bbb", T2);
    // Files where only project directories are expected.
    writeFileSync(join(home, ".claude", "projects", "README.md"), "x");
    writeFileSync(join(home, ".cursor", "projects", ".DS_Store"), "x");
    // A sidecar file inside a Cursor transcript directory.
    writeFileSync(
      join(home, ".cursor", "projects", "Users-me-proj", "agent-transcripts", "bbb", "meta.json"),
      "{}",
    );

    const sessions = scan();

    expect(sessions.map((s) => [s.harness, s.id])).toEqual([
      ["cursor", "bbb"],
      ["claude", "aaa"],
    ]);
  });

  it("drops a .jsonl entry whose stat fails (dangling symlink)", () => {
    claudeLog("-p", "real", T1);
    symlinkSync(join(home, "nowhere.jsonl"), join(home, ".claude", "projects", "-p", "gone.jsonl"));

    const sessions = scan();

    expect(sessions.map((s) => s.id)).toEqual(["real"]);
  });

  it("keeps sessions with identical mtimes without reordering failures", () => {
    claudeLog("-p", "one", T1);
    claudeLog("-p", "two", T1);

    const sessions = scan();

    expect(sessions.map((s) => s.id).sort()).toEqual(["one", "two"]);
    expect(sessions.every((s) => s.updated === T1.toISOString())).toBe(true);
  });

  it("ignores files and extra directories at each Codex date level", () => {
    codexLog("rollout-ok", T1);
    const sessionsDir = join(home, ".codex", "sessions");
    writeFileSync(join(sessionsDir, "index.json"), "{}");
    writeFileSync(join(sessionsDir, "2026", "notes.txt"), "x");
    writeFileSync(join(sessionsDir, "2026", "08", "notes.txt"), "x");
    mkdirSync(join(sessionsDir, "2026", "08", "25", "attachments"), { recursive: true });
    writeFileSync(join(sessionsDir, "2026", "08", "25", "rollout-ok.meta"), "x");

    const sessions = scan();

    expect(sessions.map((s) => [s.harness, s.id])).toEqual([["codex", "rollout-ok"]]);
  });

  it("defaults to the real home directory and process env", () => {
    claudeLog("-p", "from-home", T1);
    const codexHome = join(home, "codex-from-env");
    makeLog(join(codexHome, "sessions", "2026", "08", "25", "rollout-env.jsonl"), T2);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("XDG_DATA_HOME", join(home, "xdg-from-env"));

    const sessions = scanAgentSessions();

    expect(sessions.map((s) => [s.harness, s.id])).toEqual([
      ["codex", "rollout-env"],
      ["claude", "from-home"],
    ]);
  });

  it("honors CODEX_HOME", () => {
    const codexHome = join(home, "custom-codex");
    makeLog(join(codexHome, "sessions", "2026", "08", "25", "rollout-x.jsonl"), T1);

    const sessions = scan({ env: { CODEX_HOME: codexHome } });

    expect(sessions.map((s) => s.id)).toEqual(["rollout-x"]);
  });

  it("honors CLAUDE_CONFIG_DIR, alongside the default directory", () => {
    const claudeHome = join(home, "relocated-claude");
    makeLog(join(claudeHome, "projects", "-p", "relocated.jsonl"), T1);
    claudeLog("-p", "default", T2);

    const sessions = scan({ env: { CLAUDE_CONFIG_DIR: claudeHome } });

    expect(sessions.map((s) => [s.id, s.project])).toEqual([
      ["default", "-p"],
      ["relocated", "-p"],
    ]);
    // Set to the default directory itself, nothing is listed twice.
    expect(scan({ env: { CLAUDE_CONFIG_DIR: `${join(home, ".claude")}/` } })).toHaveLength(1);
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

    it("skips rows whose id or time_updated has an unexpected type", () => {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      const created = makeOpencodeDb(opencodeDbPath(), [
        { id: "ses_ok", directory: "/p", time_updated: T1.getTime() },
        { id: "ses_bad_time", directory: "/p", time_updated: "yesterday" },
        { id: "ignored", idSql: "X'DEADBEEF'", directory: "/p", time_updated: T2.getTime() },
      ]);
      if (!created) return;

      const sessions = scan();

      expect(sessions.map((s) => s.id)).toEqual(["ses_ok"]);
    });

    it("silently skips an unreadable or corrupt DB", () => {
      mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
      writeFileSync(opencodeDbPath(), "this is not a sqlite database");

      expect(scan()).toEqual([]);
    });
  });

  describe("pi", () => {
    it("lists sessions by the id in their file name, with pi's per-directory folder", () => {
      const path = piLog(piProjectDir(), "01a0fdc5-a112-704c", T2);
      piLog(piProjectDir(), "01a0fdc6-3a60-72c3", T1);
      writeFileSync(join(piProjectDir(), "notes.txt"), "x");

      const sessions = scan();

      expect(sessions.map((s) => [s.harness, s.id])).toEqual([
        ["pi", "01a0fdc5-a112-704c"],
        ["pi", "01a0fdc6-3a60-72c3"],
      ]);
      expect(sessions[0]).toMatchObject({
        path,
        project: "--Users-me-proj--",
        updated: T2.toISOString(),
      });
      expect(sessions[0].parentId).toBeUndefined();
    });

    it("names a forked or cloned session's parent from its header", () => {
      const parent = piLog(piProjectDir(), "parent-1", T1);
      piLog(piProjectDir(), "child-2", T2, { parentSession: parent });

      const child = scan().find((s) => s.id === "child-2");

      expect(child?.parentId).toBe("parent-1");
    });

    it("honors PI_CODING_AGENT_DIR, alongside the default directory", () => {
      const agentDir = join(home, "relocated-pi");
      piLog(piProjectDir(agentDir), "relocated", T1);
      piLog(piProjectDir(), "default", T2);

      const sessions = scan({ env: { PI_CODING_AGENT_DIR: agentDir } });

      expect(sessions.map((s) => s.id)).toEqual(["default", "relocated"]);
      // Set to the default directory itself, nothing is listed twice.
      expect(scan({ env: { PI_CODING_AGENT_DIR: "~/.pi/agent" } })).toHaveLength(1);
    });

    it("reads the flat folders a session-dir override writes into", () => {
      piLog(join(home, "env-sessions"), "from-env", T1);
      piLog(join(home, "setting-sessions"), "from-setting", T2);
      piLog(join(home, "relative-sessions"), "from-relative", T3);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ sessionDir: "~/setting-sessions" }),
      );

      const sessions = scan({ env: { PI_CODING_AGENT_SESSION_DIR: join(home, "env-sessions") } });

      expect(sessions.map((s) => [s.id, s.project])).toEqual([
        ["from-setting", undefined],
        ["from-env", undefined],
      ]);
    });

    it("ignores a sessionDir setting it cannot resolve without pi's working directory", () => {
      piLog(join(home, "relative-sessions"), "relative", T1);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      const settings = join(home, ".pi", "agent", "settings.json");
      writeFileSync(settings, JSON.stringify({ sessionDir: "relative-sessions" }));
      expect(scan()).toEqual([]);

      writeFileSync(settings, "{not json");
      expect(scan()).toEqual([]);
    });
  });
});
