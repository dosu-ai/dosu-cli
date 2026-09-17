import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countRediscoveryToolCalls,
  estimateSessionTokens,
  isWorthStudying,
  readSessionTurns,
} from "./read";
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

    it("skips blank and whitespace-only lines", () => {
      const path = writeLog("c.jsonl", [
        "",
        { type: "user", message: { role: "user", content: "first" } },
        "   ",
        "\t",
        { type: "assistant", message: { role: "assistant", content: "second" } },
        "",
      ]);

      expect(readSessionTurns(session("claude", path))).toEqual([
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
      ]);
    });

    it("yields no text for content that is neither a string nor an array", () => {
      const path = writeLog("c.jsonl", [
        { type: "user", message: { role: "user", content: 42 } },
        { type: "user", message: { role: "user", content: { type: "text", text: "nested" } } },
        { type: "user", message: { role: "user" } },
        { type: "assistant", message: { role: "assistant", content: "only me" } },
      ]);

      expect(readSessionTurns(session("claude", path))).toEqual([
        { role: "assistant", text: "only me" },
      ]);
    });

    it("ignores non-object and text-less items inside a content array", () => {
      const path = writeLog("c.jsonl", [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              "a bare string item",
              null,
              7,
              ["nested", "array"],
              { type: "text" },
              { type: "text", text: 99 },
              { text: "no type" },
              { type: "text", text: "kept" },
            ],
          },
        },
      ]);

      expect(readSessionTurns(session("claude", path))).toEqual([
        { role: "assistant", text: "kept" },
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

    it("skips role records whose message is missing or not an object", () => {
      const path = writeLog("c.jsonl", [
        { role: "user" },
        { role: "user", message: "a bare string" },
        { role: "assistant", message: null },
        { role: "assistant", message: [{ type: "text", text: "array, not object" }] },
        { role: "user", message: { content: "kept" } },
      ]);

      expect(readSessionTurns(session("cursor", path))).toEqual([{ role: "user", text: "kept" }]);
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

    it("skips response_items with a missing or non-object payload", () => {
      const path = writeLog("c.jsonl", [
        { type: "response_item" },
        { type: "response_item", payload: "message" },
        { type: "response_item", payload: { type: "message", role: "user", content: "kept" } },
      ]);

      expect(readSessionTurns(session("codex", path))).toEqual([{ role: "user", text: "kept" }]);
    });
  });

  describe("opencode", () => {
    /** Build a fixture DB with the runtime's sqlite builtin, like scan.test.ts. */
    interface DbRow {
      sessionId: string;
      messageId: string;
      role: string;
      part: unknown;
      t: number;
      /** Raw SQL literals overriding the JSON-encoded `data` columns (e.g. `NULL`). */
      messageSql?: string;
      partSql?: string;
    }

    function makeDb(rows: DbRow[]): string | null {
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
        const message = row.messageSql ?? `'${JSON.stringify({ role: row.role })}'`;
        const part = row.partSql ?? `'${JSON.stringify(row.part)}'`;
        exec(
          `INSERT OR IGNORE INTO message VALUES ('${row.messageId}', '${row.sessionId}', ${message})`,
        );
        exec(
          `INSERT INTO part VALUES ('p${i}', '${row.messageId}', '${row.sessionId}', ${row.t}, ${part})`,
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

    it("skips rows with non-string data, unknown roles, and malformed JSON", () => {
      const dbPath = makeDb([
        {
          sessionId: "ses_a",
          messageId: "m_null_part",
          role: "user",
          part: null,
          partSql: "NULL",
          t: 1,
        },
        {
          sessionId: "ses_a",
          messageId: "m_null_msg",
          role: "user",
          part: { type: "text", text: "orphaned part" },
          messageSql: "NULL",
          t: 2,
        },
        {
          sessionId: "ses_a",
          messageId: "m_system",
          role: "system",
          part: { type: "text", text: "system prompt" },
          t: 3,
        },
        {
          sessionId: "ses_a",
          messageId: "m_broken",
          role: "user",
          part: { type: "text", text: "unparseable message" },
          messageSql: "'{not json'",
          t: 4,
        },
        {
          sessionId: "ses_a",
          messageId: "m_ok",
          role: "user",
          part: { type: "text", text: "kept" },
          t: 5,
        },
      ]);
      if (!dbPath) return;

      expect(readSessionTurns(session("opencode", dbPath, "ses_a"))).toEqual([
        { role: "user", text: "kept" },
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

describe("isWorthStudying", () => {
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

    expect(isWorthStudying(session("claude", path))).toBe(true);
  });

  it("rejects a session with too few turns, however long", () => {
    const path = writeLog("short.jsonl", [
      claudeTurn("user", "x".repeat(5000)),
      claudeTurn("assistant", "y".repeat(5000)),
    ]);

    expect(isWorthStudying(session("claude", path))).toBe(false);
  });

  it("rejects a chatty but tiny session", () => {
    const path = writeLog("tiny.jsonl", [
      claudeTurn("user", "hi"),
      claudeTurn("assistant", "hello!"),
      claudeTurn("user", "thanks"),
      claudeTurn("assistant", "any time"),
    ]);

    expect(isWorthStudying(session("claude", path))).toBe(false);
  });

  it("rejects an unreadable session", () => {
    expect(isWorthStudying(session("claude", join(dir, "missing.jsonl")))).toBe(false);
  });
});

describe("countRediscoveryToolCalls", () => {
  it("counts Cursor/Claude tool_use names in REDISCOVERY_TOOLS", () => {
    const path = writeLog("tools.jsonl", [
      { type: "user", message: { role: "user", content: "why?" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Grep", input: {} },
            { type: "tool_use", name: "TodoWrite", input: {} },
          ],
        },
      },
    ]);
    expect(countRediscoveryToolCalls(session("claude", path))).toBe(2);
  });

  it("counts Cursor role/message tool_use the same way", () => {
    const path = writeLog("cursor-tools.jsonl", [
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Grep" },
            { type: "tool_use", name: "TodoWrite" },
          ],
        },
      },
    ]);
    expect(countRediscoveryToolCalls(session("cursor", path))).toBe(2);
  });

  it("counts Codex function_call names", () => {
    const path = writeLog("codex.jsonl", [
      { type: "response_item", payload: { type: "function_call", name: "read_file" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      { type: "response_item", payload: { type: "function_call", name: "unknown_tool" } },
    ]);
    expect(countRediscoveryToolCalls(session("codex", path))).toBe(2);
  });

  it("ignores Codex records that are not named function_calls", () => {
    const path = writeLog("codex-mixed.jsonl", [
      { type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
      { type: "response_item", payload: { type: "function_call" } },
      { type: "response_item", payload: { type: "function_call", name: 42 } },
      { type: "response_item" },
      { type: "event_msg", payload: { type: "token_count" } },
      { type: "response_item", payload: { type: "function_call", name: "web_search_preview" } },
    ]);
    expect(countRediscoveryToolCalls(session("codex", path))).toBe(1);
  });

  it("ignores Claude/Cursor records without an object message or array content", () => {
    const path = writeLog("no-tools.jsonl", [
      { type: "user", message: "bare" },
      { type: "assistant", message: { role: "assistant", content: "text only" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use" }, 3] } },
      { type: "file-history-snapshot" },
    ]);
    expect(countRediscoveryToolCalls(session("claude", path))).toBe(0);
  });

  it("returns 0 for an unreadable session", () => {
    expect(countRediscoveryToolCalls(session("claude", join(dir, "missing.jsonl")))).toBe(0);
  });

  it("returns 0 for opencode sessions", () => {
    expect(countRediscoveryToolCalls(session("opencode", join(dir, "missing.db")))).toBe(0);
  });
});

describe("estimateSessionTokens", () => {
  it("estimates chars ÷ 4 over the conversational turns only", () => {
    const path = writeLog("est.jsonl", [
      { type: "user", message: { role: "user", content: "x".repeat(400) } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "y".repeat(600) },
            // Tool noise must not count toward the learning estimate.
            { type: "tool_use", name: "Read", input: { big: "z".repeat(10_000) } },
          ],
        },
      },
    ]);

    expect(estimateSessionTokens(session("claude", path))).toBe(250);
  });

  it("returns 0 for an unreadable session", () => {
    expect(estimateSessionTokens(session("claude", join(dir, "missing.jsonl")))).toBe(0);
  });
});
