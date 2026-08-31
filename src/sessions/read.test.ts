import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorthMining, readSessionTurns } from "./read";
import type { AgentSession } from "./scan";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-read-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return path;
}

function session(harness: AgentSession["harness"], path: string, id = "s1"): AgentSession {
  return { id, harness, path, updated: "2026-08-27T00:00:00.000Z" };
}

describe("readSessionTurns", () => {
  it("returns [] for an unreadable file", () => {
    expect(readSessionTurns(session("claude", join(dir, "missing.jsonl")))).toEqual([]);
  });

  describe("claude", () => {
    it("extracts user and assistant text in order", () => {
      const path = writeLog("c.jsonl", [
        { type: "user", message: { role: "user", content: "fix the bug" } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "On it." },
              { type: "tool_use", name: "Read", input: {} },
            ],
          },
        },
        {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
        },
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
        },
      ]);

      expect(readSessionTurns(session("claude", path))).toEqual([
        { role: "user", text: "fix the bug" },
        { role: "assistant", text: "On it." },
        { role: "assistant", text: "Fixed." },
      ]);
    });

    it("skips sidechain (subagent) lines, metadata lines, and malformed lines", () => {
      const path = writeLog("c.jsonl", [
        { type: "file-history-snapshot", messageId: "x" },
        "not json {",
        { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
        { type: "user", message: { role: "user", content: "real prompt" } },
        { type: "user" },
      ]);

      expect(readSessionTurns(session("claude", path))).toEqual([
        { role: "user", text: "real prompt" },
      ]);
    });
  });

  describe("cursor", () => {
    it("extracts text turns and ignores marker lines and tool_use items", () => {
      const path = writeLog("c.jsonl", [
        {
          role: "user",
          message: { content: [{ type: "text", text: "<user_query>hello</user_query>" }] },
        },
        {
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "hi" },
              { type: "tool_use", name: "Read" },
            ],
          },
        },
        { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell" }] } },
        { type: "turn_ended" },
      ]);

      expect(readSessionTurns(session("cursor", path))).toEqual([
        { role: "user", text: "<user_query>hello</user_query>" },
        { role: "assistant", text: "hi" },
      ]);
    });
  });

  describe("codex", () => {
    it("extracts message payloads and skips developer role and injected blocks", () => {
      const path = writeLog("c.jsonl", [
        { type: "session_meta", payload: { id: "x" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "base instructions" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<ENVIRONMENT_CONTEXT>\ncwd=/x\n</ENVIRONMENT_CONTEXT>" },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "what does this do" }],
          },
        },
        { type: "response_item", payload: { type: "function_call", name: "shell" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "It parses the config." }],
          },
        },
        { type: "event_msg", payload: { type: "token_count" } },
      ]);

      expect(readSessionTurns(session("codex", path))).toEqual([
        { role: "user", text: "what does this do" },
        { role: "assistant", text: "It parses the config." },
      ]);
    });
  });

  describe("opencode", () => {
    /** Build a fixture DB with the runtime's sqlite builtin, like scan.test.ts. */
    function makeDb(
      rows: { sessionId: string; messageId: string; role: string; part: unknown; t: number }[],
    ): string | null {
      const dbPath = join(dir, "opencode.db");
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
        return null;
      }
      exec("CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)");
      exec(
        "CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, data text)",
      );
      rows.forEach((row, i) => {
        exec(
          `INSERT OR IGNORE INTO message VALUES ('${row.messageId}', '${row.sessionId}', '${JSON.stringify({ role: row.role })}')`,
        );
        exec(
          `INSERT INTO part VALUES ('p${i}', '${row.messageId}', '${row.sessionId}', ${row.t}, '${JSON.stringify(row.part)}')`,
        );
      });
      close?.();
      return dbPath;
    }

    it("reads text parts for the session in time order, skipping non-text parts", () => {
      const dbPath = makeDb([
        {
          sessionId: "ses_a",
          messageId: "m2",
          role: "assistant",
          part: { type: "text", text: "done" },
          t: 3,
        },
        {
          sessionId: "ses_a",
          messageId: "m1",
          role: "user",
          part: { type: "text", text: "do it" },
          t: 1,
        },
        {
          sessionId: "ses_a",
          messageId: "m2",
          role: "assistant",
          part: { type: "reasoning", text: "hmm" },
          t: 2,
        },
        {
          sessionId: "ses_other",
          messageId: "m9",
          role: "user",
          part: { type: "text", text: "other session" },
          t: 1,
        },
      ]);
      if (!dbPath) return; // runtime has no sqlite builtin — reader degrades too

      expect(readSessionTurns(session("opencode", dbPath, "ses_a"))).toEqual([
        { role: "user", text: "do it" },
        { role: "assistant", text: "done" },
      ]);
    });

    it("rejects a session id that is not an opaque token", () => {
      const dbPath = makeDb([]);
      if (!dbPath) return;

      expect(readSessionTurns(session("opencode", dbPath, "x'; DROP TABLE part;--"))).toEqual([]);
    });

    it("returns [] for a corrupt database", () => {
      const dbPath = join(dir, "opencode.db");
      writeFileSync(dbPath, "not a database");

      expect(readSessionTurns(session("opencode", dbPath, "ses_a"))).toEqual([]);
    });
  });
});

describe("isWorthMining", () => {
  function claudeTurn(role: "user" | "assistant", text: string) {
    return { type: role, message: { role, content: text } };
  }

  it("accepts a session with enough turns and enough text", () => {
    const text = "a substantial paragraph of investigation detail ".repeat(20); // ~960 chars
    const path = writeLog("worthy.jsonl", [
      claudeTurn("user", text),
      claudeTurn("assistant", text),
      claudeTurn("user", text),
      claudeTurn("assistant", text),
    ]);

    expect(isWorthMining(session("claude", path))).toBe(true);
  });

  it("rejects a session with too few turns, however long", () => {
    const path = writeLog("short.jsonl", [
      claudeTurn("user", "x".repeat(5000)),
      claudeTurn("assistant", "y".repeat(5000)),
    ]);

    expect(isWorthMining(session("claude", path))).toBe(false);
  });

  it("rejects a chatty but tiny session", () => {
    const path = writeLog("tiny.jsonl", [
      claudeTurn("user", "hi"),
      claudeTurn("assistant", "hello!"),
      claudeTurn("user", "thanks"),
      claudeTurn("assistant", "any time"),
    ]);

    expect(isWorthMining(session("claude", path))).toBe(false);
  });

  it("rejects an unreadable session", () => {
    expect(isWorthMining(session("claude", join(dir, "missing.jsonl")))).toBe(false);
  });
});
