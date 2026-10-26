import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { claudeUsage, codexUsage, readSessionUsage } from "./usage";

const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n");

function assistant(
  uuid: string,
  timestamp: string,
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { type: "assistant", uuid, timestamp, sessionId: "s1", ...extra, message };
}

/** One API request written as two journal lines (thinking, then a tool call), each repeating
 * the message's usage with a growing output count; then a second request on another model. */
const CLAUDE = jsonl([
  { type: "user", uuid: "u1", timestamp: "2026-10-01T00:00:00Z", message: { content: "hi" } },
  assistant(
    "a1",
    "2026-10-01T00:00:01Z",
    {
      id: "msg_1",
      model: "claude-sonnet-4-5",
      content: [{ type: "thinking", thinking: "hm" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
      },
    },
    { requestId: "req_1" },
  ),
  assistant(
    "a2",
    "2026-10-01T00:00:02Z",
    {
      id: "msg_1",
      model: "claude-sonnet-4-5",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
      },
    },
    { requestId: "req_1" },
  ),
  {
    type: "user",
    uuid: "u2",
    timestamp: "2026-10-01T00:00:03Z",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a" }] },
  },
  // An older log: no requestId, so the API message id names the request.
  assistant("a3", "2026-10-01T00:00:04Z", {
    id: "msg_2",
    model: "claude-opus-4-1",
    content: [{ type: "text", text: "done" }],
    usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 200, speed: "fast" },
  }),
]);

describe("claudeUsage", () => {
  it("counts each API request once across its content-block lines", () => {
    expect(claudeUsage(CLAUDE)).toEqual([
      {
        id: "req_1",
        model: "claude-sonnet-4-5",
        timestamp: "2026-10-01T00:00:02Z",
        input: 10,
        output: 50,
        cache_read: 100,
        cache_write: 20,
        cache_write_1h: 5,
        speed: null,
        tool_call_ids: ["toolu_1"],
      },
      {
        id: "msg_2",
        model: "claude-opus-4-1",
        timestamp: "2026-10-01T00:00:04Z",
        input: 3,
        output: 7,
        cache_read: 200,
        cache_write: 0,
        cache_write_1h: 0,
        speed: "fast",
        tool_call_ids: [],
      },
    ]);
  });

  it("keeps the highest output whatever order the lines arrive in", () => {
    const lines = CLAUDE.split("\n");
    const swapped = [lines[0], lines[2], lines[1]].join("\n");
    const [request] = claudeUsage(swapped);
    expect(request.output).toBe(50);
    expect(request.tool_call_ids).toEqual(["toolu_1"]);
    expect(request.timestamp).toBe("2026-10-01T00:00:01Z");
  });

  it("skips synthetic zero-usage messages, usage-less lines, and torn lines", () => {
    const transcript = [
      jsonl([
        assistant("a1", "2026-10-01T00:00:01Z", {
          id: "msg_s",
          model: "<synthetic>",
          content: [{ type: "text", text: "API error" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        assistant("a2", "2026-10-01T00:00:02Z", { id: "msg_x", content: "no usage" }),
        { type: "assistant", uuid: "a3", message: "not an object" },
        assistant("a4", "2026-10-01T00:00:03Z", {
          content: "string content",
          usage: { input_tokens: 4, output_tokens: -2 },
        }),
        ["not", "an", "object"],
      ]),
      '{"type":"assistant","message":{"id":"msg_torn"',
    ].join("\n");
    // a4 has no request or message id; its line uuid stands in.
    expect(claudeUsage(transcript)).toEqual([
      {
        id: "a4",
        model: null,
        timestamp: "2026-10-01T00:00:03Z",
        input: 4,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cache_write_1h: 0,
        speed: null,
        tool_call_ids: [],
      },
    ]);
  });
});

const tokenCount = (
  timestamp: string,
  last: Record<string, number> | null,
  totalTokens: number,
) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: last
      ? { last_token_usage: last, total_token_usage: { total_tokens: totalTokens } }
      : null,
  },
});

const CODEX = jsonl([
  { timestamp: "2026-10-01T00:00:00Z", type: "session_meta", payload: { id: "codex-s1" } },
  { timestamp: "2026-10-01T00:00:00Z", type: "turn_context", payload: { model: "gpt-5-codex" } },
  tokenCount("2026-10-01T00:00:00Z", null, 0), // the session's opening reading carries no info
  {
    timestamp: "2026-10-01T00:00:01Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", call_id: "call_1", arguments: "{}" },
  },
  {
    timestamp: "2026-10-01T00:00:01Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_1", output: "ok" },
  },
  tokenCount(
    "2026-10-01T00:00:02Z",
    { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 40 },
    1040,
  ),
  // Codex repeats the reading (e.g. on a rate-limit update): same running total, same request.
  tokenCount(
    "2026-10-01T00:00:02Z",
    { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 40 },
    1040,
  ),
  { timestamp: "2026-10-01T00:00:03Z", type: "turn_context", payload: { model: "gpt-5" } },
  tokenCount(
    "2026-10-01T00:00:04Z",
    {
      input_tokens: 1200,
      cached_input_tokens: 1000,
      cache_write_input_tokens: 100,
      output_tokens: 60,
    },
    2300,
  ),
  // A breakdown that does not fit inside input_tokens keeps the inclusive total.
  tokenCount(
    "2026-10-01T00:00:05Z",
    { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 50, output_tokens: 1 },
    2401,
  ),
]);

describe("codexUsage", () => {
  it("records one entry per request, deduping repeated readings", () => {
    expect(codexUsage(CODEX)).toEqual([
      {
        id: "codex:1040",
        model: "gpt-5-codex",
        timestamp: "2026-10-01T00:00:02Z",
        input: 200,
        output: 40,
        cache_read: 800,
        cache_write: 0,
        cache_write_1h: 0,
        speed: null,
        tool_call_ids: ["call_1"],
      },
      {
        id: "codex:2300",
        model: "gpt-5",
        timestamp: "2026-10-01T00:00:04Z",
        input: 100,
        output: 60,
        cache_read: 1000,
        cache_write: 100,
        cache_write_1h: 0,
        speed: null,
        tool_call_ids: [],
      },
      {
        id: "codex:2401",
        model: "gpt-5",
        timestamp: "2026-10-01T00:00:05Z",
        input: 10,
        output: 1,
        cache_read: 90,
        cache_write: 0,
        cache_write_1h: 0,
        speed: null,
        tool_call_ids: [],
      },
    ]);
  });

  it("leaves a forked subagent's replayed parent history to the parent", () => {
    const transcript = jsonl([
      {
        type: "session_meta",
        ordinal: 0,
        payload: { id: "child", forked_from_id: "parent", subagent_history_start_ordinal: 3 },
      },
      // Replayed parent history: its session_meta, then the parent's own request.
      { type: "session_meta", ordinal: 1, payload: { id: "parent" } },
      {
        ...tokenCount("2026-10-01T00:00:01Z", { input_tokens: 500, output_tokens: 5 }, 505),
        ordinal: 2,
      },
      { type: "turn_context", ordinal: 3, payload: { model: "gpt-5" } },
      {
        ...tokenCount("2026-10-01T00:00:02Z", { input_tokens: 600, output_tokens: 6 }, 1111),
        ordinal: 4,
      },
    ]);
    expect(codexUsage(transcript).map((request) => request.id)).toEqual(["codex:1111"]);
  });
});

describe("readSessionUsage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dosu-ship-usage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function session(harness: AgentSession["harness"], content: string | null): AgentSession {
    const path = join(dir, `${harness}.jsonl`);
    if (content !== null) writeFileSync(path, content);
    return { id: "s1", harness, path, updated: "2026-10-01T00:00:00Z" };
  }

  it("reads Claude Code and Codex journals", () => {
    expect(readSessionUsage(session("claude", CLAUDE))?.requests).toHaveLength(2);
    expect(readSessionUsage(session("codex", CODEX))?.requests).toHaveLength(3);
  });

  it("is null for harnesses without usage, empty usage, and unreadable logs", () => {
    expect(readSessionUsage(session("cursor", CLAUDE))).toBeNull();
    expect(readSessionUsage(session("claude", ""))).toBeNull();
    expect(readSessionUsage(session("codex", null))).toBeNull();
  });
});
