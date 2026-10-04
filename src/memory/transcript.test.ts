import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertCodexTranscriptLines, convertTranscriptLines } from "./transcript";

/** Real Claude Code 2.1 sessions (headless, haiku) in a toy repo with the memory hooks on;
 * paths rewritten to /work, only user/assistant/system lines and the hooks' attachments kept. */
const fixture = (name: string) =>
  readFileSync(join(__dirname, "testdata", name), "utf-8")
    .split("\n")
    .filter((line) => line !== "");
const SESSION = fixture("claude-code-session.jsonl");
/** Note injected on the first prompt, `/compact`, the note re-injected by SessionStart, then a
 * second prompt. The injected note carries the marker MEMO-MARKER-7731. */
const COMPACTED = fixture("claude-code-compacted-session.jsonl");
/** Two-stage recall against a fake backend. Stage one carries STAGE1-MARKER-4410; stage two
 * carries STAGE2-MARKER-8823 plus an `ERROR:` line and an `Exit code 9` line, bait for the
 * command parser had it landed inside a tool result. TOOL: two parallel Bash calls, one failing,
 * then stage two on that batch's PostToolBatch, `/compact` puts both stages back, a second prompt
 * edits README.md. PROMPT: no tool call in the first turn, so stage two comes with the second
 * prompt. */
const TWO_STAGE_TOOL = fixture("claude-code-two-stage-tool-session.jsonl");
const TWO_STAGE_PROMPT = fixture("claude-code-two-stage-prompt-session.jsonl");
/** Real `codex exec` sessions (gpt-6-sol) in a toy repo with the memory hooks on and a fake
 * backend; paths rewritten to /work/widgets, reasoning, token counts and the built-in context
 * dropped. Three commands (the second fails), then a fix through apply_patch. 0.153 calls tools
 * directly; 0.160 calls them from JavaScript in code mode. Both carry the hooks' two notes as
 * developer messages. */
const CODEX_153 = fixture("codex-0.153-session.jsonl");
const CODEX_160 = fixture("codex-0.160-session.jsonl");

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

  it("never feeds an injected note back into the record", () => {
    expect(COMPACTED.filter((line) => line.includes("<prior_task_memory>"))).toHaveLength(2);
    const { events } = convertTranscriptLines(COMPACTED, {}, "/work/demo-widgets");

    expect(events.filter((e) => e.type === "user_prompt").map((e) => e.text)).toEqual([
      "Use the Bash tool to run: python3 widgets.py ; then reply in one short sentence.",
      expect.stringMatching(/^Now use the Edit tool to change "A tiny widget counter\."/),
    ]);
    const uploaded = JSON.stringify(events);
    expect(uploaded).not.toContain("prior_task_memory");
    expect(uploaded).not.toContain("MEMO-MARKER");
    expect(uploaded).not.toContain("being continued from a previous conversation");
  });

  it("never feeds either stage of a two-stage recall back into the record", () => {
    const injectedBy = (lines: string[]) =>
      lines
        .filter((line) => line.includes("MARKER-"))
        .map((line) => JSON.parse(line).attachment?.hookEvent ?? "not a hook attachment");
    expect(injectedBy(TWO_STAGE_TOOL)).toEqual([
      "UserPromptSubmit",
      "PostToolBatch",
      "SessionStart",
    ]);
    expect(injectedBy(TWO_STAGE_PROMPT)).toEqual(["UserPromptSubmit", "UserPromptSubmit"]);

    const tool = convertTranscriptLines(TWO_STAGE_TOOL, {}, "/work/demo-widgets").events;
    expect(tool.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      {
        type: "user_prompt",
        text: expect.stringMatching(/^In ONE assistant message, call the Bash/),
      },
      {
        type: "command",
        command: "sleep 3; python3 widgets.py --strict",
        rc: 3,
        error_line: "ERROR: widget count mismatch (expected 3, got 2)",
      },
      { type: "command", command: "sleep 3; python3 widgets.py", rc: 0, error_line: null },
      { type: "assistant_text", text: expect.any(String) },
      { type: "user_prompt", text: expect.stringMatching(/^Now use the Edit tool to change/) },
      { type: "file_edit", tool: "Edit", path: "README.md" },
      { type: "assistant_text", text: expect.any(String) },
    ]);
    const prompt = convertTranscriptLines(TWO_STAGE_PROMPT, {}, "/work/demo-widgets").events;
    expect(prompt.filter((e) => e.type === "user_prompt").map((e) => e.text)).toEqual([
      "Reply with one short sentence saying hello. Do not use any tools.",
      "Use the Bash tool to run: python3 widgets.py ; then reply in one short sentence.",
    ]);
    for (const events of [tool, prompt]) {
      expect(JSON.stringify(events)).not.toMatch(/MARKER|prior_task_memory|Addendum/);
    }
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

describe("convertCodexTranscriptLines", () => {
  it("turns a real Codex 0.153 session into prompt, replies, commands, and edits", () => {
    const events = convertCodexTranscriptLines(CODEX_153, "/work/widgets");
    expect(events.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { type: "user_prompt", text: expect.stringMatching(/^Run these shell commands one at a/) },
      { type: "assistant_text", text: expect.stringMatching(/^I’ll run the three commands/) },
      { type: "command", command: "sleep 4 && echo one", rc: 0, error_line: null },
      {
        type: "command",
        command: 'python3 -c "raise SystemExit(\\"ERROR: widget count mismatch\\")"',
        rc: 1,
        error_line: "ERROR: widget count mismatch",
      },
      { type: "command", command: "sleep 4 && echo three", rc: 0, error_line: null },
      { type: "assistant_text", text: expect.stringMatching(/^The commands finished/) },
      {
        type: "command",
        command: expect.stringMatching(/^pwd; rg --files/),
        rc: 1,
        error_line: null,
      },
      {
        type: "command",
        command: "cat calc.py; ls -la; git status --short",
        rc: 0,
        error_line: null,
      },
      { type: "assistant_text", text: expect.stringMatching(/^`add` subtracts/) },
      { type: "file_edit", tool: "apply_patch", path: "calc.py" },
      {
        type: "command",
        command: expect.stringMatching(/^python3 -c 'import calc;/),
        rc: 0,
        error_line: null,
      },
      { type: "assistant_text", text: expect.stringMatching(/^Fixed `calc.add`/) },
    ]);
    expect(events[0].ts).toBe("2026-10-04T18:52:26.901Z");
  });

  it("reads the same items from a 0.160 session, whose commands run in code mode", () => {
    const events = convertCodexTranscriptLines(CODEX_160, "/work/widgets");
    expect(events.map((event) => event.type)).toEqual([
      "user_prompt",
      "assistant_text",
      "command",
      "command",
      "command",
      "assistant_text",
      "command",
      "command",
      "file_edit",
      "command",
      "assistant_text",
    ]);
    expect(events[3]).toMatchObject({ command: "ls /nonexistent-dir", rc: 1 });
  });
});
