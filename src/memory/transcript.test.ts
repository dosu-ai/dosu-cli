import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertTranscriptLines } from "./transcript";

/** A real Claude Code 2.1 session (headless, haiku) in a toy repo; paths rewritten to /work, only
 * user/assistant lines and the memory hook's attachment kept. */
const SESSION = readFileSync(join(__dirname, "testdata", "claude-code-session.jsonl"), "utf-8")
  .split("\n")
  .filter((line) => line !== "");

const TS = "2026-10-01T10:00:00.000Z";
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", timestamp: TS, message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: TS,
    message: { role: "assistant", content },
    ...extra,
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  assistant([{ type: "tool_use", id, name, input }]);
const toolResult = (id: string, content: unknown, isError = false) =>
  user([{ type: "tool_result", tool_use_id: id, content, is_error: isError }]);

describe("convertTranscriptLines", () => {
  it("turns a real session into prompt, replies, commands, and edits", () => {
    const { events, pending } = convertTranscriptLines(SESSION, {}, "/work/demo-widgets");
    expect(pending).toEqual({});
    expect(events.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { type: "user_prompt", text: expect.stringMatching(/^Please do these steps in order/) },
      { type: "assistant_text", text: "I'll work through these steps in order." },
      { type: "command", command: "ls", rc: 0, error_line: null },
      {
        type: "command",
        command: expect.stringMatching(/^python3 -c /),
        rc: 3,
        error_line: "ERROR: widget count mismatch (expected 3, got 2)",
      },
      { type: "file_edit", tool: "Write", path: "notes.txt" },
      { type: "file_edit", tool: "Edit", path: "README.md" },
      // Heredoc body dropped, as `_prepare_recorded_command` does.
      { type: "command", command: "cat > check.sh <<'EOF'\nsh check.sh", rc: 0, error_line: null },
      { type: "assistant_text", text: expect.stringMatching(/^All five steps completed/) },
    ]);
    expect(events[0].ts).toBe("2026-10-01T19:34:45.974Z");
    expect(events[2].ts).toBe("2026-10-01T19:34:49.312Z");
  });

  it("keeps only what a person typed as user_prompt", () => {
    const lines = [
      user("<system-reminder>injected context</system-reminder>\nFix the flaky test", {
        origin: { kind: "human" },
      }),
      user("Legacy prompt without an origin tag"),
      user("Expanded skill body", { isMeta: true }),
      user("<task-notification>done</task-notification>", {
        origin: { kind: "task-notification" },
      }),
      user("<command-name>/clear</command-name>"),
      user("<local-command-stdout>ok</local-command-stdout>"),
      user([{ type: "text", text: "[Request interrupted by user]" }]),
      user("Summary of the earlier conversation", { isCompactSummary: true }),
      user("Subagent prompt", { isSidechain: true }),
      JSON.stringify({
        type: "attachment",
        timestamp: TS,
        attachment: { type: "hook_additional_context" },
      }),
      "{not json",
    ];
    const { events } = convertTranscriptLines(lines, {}, "/w");
    expect(events).toEqual([
      { type: "user_prompt", ts: TS, text: "Fix the flaky test" },
      { type: "user_prompt", ts: TS, text: "Legacy prompt without an origin tag" },
    ]);
  });

  it("clips prompts at 32000 and replies at 2000 characters, keeping both ends", () => {
    const prompt = `${"p".repeat(20_000)}${"q".repeat(20_000)}`;
    const { events } = convertTranscriptLines(
      [user(prompt), assistant([{ type: "text", text: "a".repeat(3_000) }])],
      {},
      "/w",
    );
    expect(events[0]).toMatchObject({
      text: `${"p".repeat(16_000)}\n[... 8000 characters cut ...]\n${"q".repeat(16_000)}`,
    });
    expect(events[1]).toMatchObject({
      text: `${"a".repeat(1_000)}\n[... 1000 characters cut ...]\n${"a".repeat(1_000)}`,
    });
  });

  it("matches a result to a call from an earlier chunk", () => {
    const first = convertTranscriptLines(
      [toolUse("t1", "Bash", { command: "cd /w && make test" })],
      {},
      "/w",
    );
    expect(first.events).toEqual([]);
    expect(first.pending).toEqual({ t1: { name: "Bash", command: "make test" } });

    const second = convertTranscriptLines(
      [
        toolResult(
          "t1",
          "Exit code 2\ncompiling\nmake: *** [test] Error 2\nerror: 1 test failed",
          true,
        ),
      ],
      first.pending,
      "/w",
    );
    expect(second.events).toEqual([
      { type: "command", ts: TS, command: "make test", rc: 2, error_line: "error: 1 test failed" },
    ]);
    expect(second.pending).toEqual({});
  });

  it("skips interrupted or denied commands, failed edits, and synthetic replies", () => {
    const lines = [
      toolUse("b1", "Bash", { command: "sleep 100" }),
      toolResult("b1", "[Request interrupted by user for tool use]", true),
      toolUse("e1", "Edit", { file_path: "/w/src/a.ts" }),
      toolResult(
        "e1",
        [{ type: "text", text: "<tool_use_error>String not found</tool_use_error>" }],
        true,
      ),
      assistant([{ type: "text", text: "No response requested." }], {}),
      JSON.stringify({
        type: "assistant",
        timestamp: TS,
        message: { model: "<synthetic>", content: [{ type: "text", text: "synthetic" }] },
      }),
      assistant([{ type: "text", text: "API Error: 500" }], { isApiErrorMessage: true }),
    ];
    const { events, pending } = convertTranscriptLines(lines, {}, "/w");
    expect(events).toEqual([{ type: "assistant_text", ts: TS, text: "No response requested." }]);
    expect(pending).toEqual({});
  });
});
