import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { sessionToDigest } from "./digest";
import { buildReportHtml } from "./html";
import { attributeRediscovery } from "./notes";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-digest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, harness: AgentSession["harness"], lines: unknown[]): AgentSession {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  return { id, harness, path, updated: "2026-09-09T00:00:00.000Z" };
}

function claudeSession(id: string, lines: unknown[]): AgentSession {
  return session(id, "claude", lines);
}

describe("sessionToDigest", () => {
  it("keeps Read/Grep tool_use with path and pattern, using file line numbers", () => {
    const session = claudeSession("s1", [
      { type: "file-history-snapshot", messageId: "x" },
      { type: "user", message: { content: "why does auth retry?" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", name: "Read", input: { path: "src/auth.py" } },
            { type: "tool_use", name: "Grep", input: { pattern: "retry after 401" } },
          ],
        },
      },
    ]);
    const turns = sessionToDigest(session).turns;
    expect(turns.map((t) => t.line)).toEqual([2, 3]);
    expect(turns[1].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Read", path: "src/auth.py" }),
        expect.objectContaining({ name: "Grep", pattern: "retry after 401" }),
      ]),
    );
  });

  it("skips tool_result-only user rows so the cycle stays one stretch", () => {
    const session = claudeSession("s1", [
      { type: "user", message: { content: "find the oauth retry" } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "tokens.py" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "retry after 401" }] },
      },
    ]);
    const turns = sessionToDigest(session).turns;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    const [note] = attributeRediscovery(
      [{ title: "OAuth retry", content: "Retry after 401 in tokens.py", transcript_id: "s1" }],
      [session],
    );
    expect(note.investigation_lines).toBe("1-4");
    const html = buildReportHtml({
      inventory: { transcripts: [] },
      candidates: [note],
      digests: { s1: sessionToDigest(session) },
    });
    expect(html).toContain("Work to learn this");
    expect(html).toContain("tokens.py");
    expect(html).toMatch(/Read/);
    expect(html).not.toMatch(/Work to learn this · 1 reasoning ·/);
  });

  it("digests Cursor role/message logs with tool previews, skipping other roles and bad lines", () => {
    const s = session("c1", "cursor", [
      "{not json",
      { role: "system", message: { content: "ignored" } },
      { role: "user", message: { content: "where is retry?" } },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Shell", input: { command: "grep -r retry" } },
            { type: "tool_use", name: "Task", input: { prompt: "find the retry loop" } },
            { type: "tool_use", name: "SemanticSearch", input: { query: "retry backoff" } },
            { type: "tool_use", name: "Glob", input: { description: "list source files" } },
          ],
        },
      },
    ]);
    const turns = sessionToDigest(s).turns;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1].tools).toEqual([
      expect.objectContaining({ name: "Read", file_path: "src/a.ts", path: "src/a.ts" }),
      expect.objectContaining({ name: "Shell", command_preview: "grep -r retry" }),
      expect.objectContaining({ name: "Task", prompt: "find the retry loop" }),
      expect.objectContaining({ name: "SemanticSearch", query: "retry backoff" }),
      expect.objectContaining({ name: "Glob", command_preview: "list source files" }),
    ]);
  });

  it("captures MCP tool metadata: mcp__ input as arguments, CallMcpTool names, GetMcpTools pattern", () => {
    const s = claudeSession("m1", [
      { type: "user", message: { content: "use dosu" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__dosu__read_knowledge", input: { query: "auth" } },
            {
              type: "tool_use",
              name: "CallMcpTool",
              input: { toolName: "write_knowledge", server: "dosu", arguments: { title: "t" } },
            },
            { type: "tool_use", name: "GetMcpTools", input: { pattern: "knowledge" } },
          ],
        },
      },
    ]);
    const tools = sessionToDigest(s).turns[1].tools ?? [];
    expect(tools[0]).toMatchObject({
      name: "mcp__dosu__read_knowledge",
      arguments: { query: "auth" },
    });
    expect(tools[1]).toMatchObject({
      toolName: "write_knowledge",
      server: "dosu",
      arguments: { title: "t" },
    });
    expect(tools[2]).toMatchObject({ name: "GetMcpTools", pattern: "knowledge" });
  });

  it("truncates long assistant text and counts tool_result chars into est_tokens", () => {
    const long = "x".repeat(5000);
    const s = claudeSession("t1", [
      { type: "assistant", message: { content: [{ type: "text", text: long }] } },
      {
        type: "user",
        message: {
          content: [
            { type: "text", text: "next question" },
            { type: "tool_result", content: [{ type: "text", text: "result payload" }] },
          ],
        },
      },
    ]);
    const turns = sessionToDigest(s).turns;
    expect(turns[0].text?.[0]).toContain("…[truncated]");
    expect(turns[0].text?.[0].length).toBeLessThan(4100);
    expect(turns[1].est_tokens).toBeGreaterThan(Math.round("next question".length / 4));
  });

  it("digests Codex event_msg and function_call records, skipping everything else", () => {
    const long = "y".repeat(5000);
    const s = session("x1", "codex", [
      "{not json",
      { type: "turn_context", payload: {} },
      { type: "event_msg", payload: { type: "user_message", message: "why 401s?" } },
      { type: "event_msg", payload: { type: "agent_message", message: long } },
      { type: "event_msg", payload: { type: "agent_message", message: "" } },
      {
        type: "response_item",
        payload: { type: "function_call", name: "read_file", arguments: '{"path":"a.ts"}' },
      },
      { type: "response_item", payload: { type: "function_call", arguments: { path: "b.ts" } } },
    ]);
    const turns = sessionToDigest(s).turns;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(turns[0].text).toEqual(["why 401s?"]);
    expect((turns[1].text as string[])[0]).toContain("…[truncated]");
    expect(turns[2].tools).toEqual([{ name: "read_file", command_preview: '{"path":"a.ts"}' }]);
    expect(turns[3].tools).toEqual([{ name: "function_call", command_preview: '{"path":"b.ts"}' }]);
  });

  it("skips malformed and non-object lines in Claude logs", () => {
    const s = session("bad1", "claude", [
      "{not json",
      "123",
      { type: "user", message: { content: "still works" } },
    ]);
    const turns = sessionToDigest(s).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0].line).toBe(3);
  });

  it("degrades to zero turns for opencode sessions and unreadable files", () => {
    const missing: AgentSession = {
      id: "gone",
      harness: "claude",
      path: join(dir, "missing.jsonl"),
      updated: "2026-09-09T00:00:00.000Z",
    };
    expect(sessionToDigest(missing).turns).toEqual([]);
    const opencode: AgentSession = {
      id: "oc1",
      harness: "opencode",
      path: join(dir, "missing.db"),
      updated: "2026-09-09T00:00:00.000Z",
    };
    expect(sessionToDigest(opencode).turns).toEqual([]);
  });
});
