import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HookDeps, parseHookArgs, repoOfDir, runMemoryHook } from "./hook";
import { eventLogPath, readSessionState } from "./state";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "5f0c2a1e-7b3d-4c8e-9a61-2d4f8b0e1c37";
const NOTE = "Earlier sessions ran `make test` before committing; fixtures live in tests/data.";

let dir: string;
let recallBodies: unknown[];
let recallUrls: string[];
let respond: () => Promise<Response>;
let spawned: string[][];

const payload = (event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event,
  session_id: SESSION,
  transcript_path: "/home/dev/.claude/projects/w/session.jsonl",
  cwd: "/work/widgets",
  ...extra,
});

function deps(extra: Partial<HookDeps> = {}): HookDeps {
  return {
    configDir: dir,
    api: { backendURL: "http://memory.test", apiKey: "test-key" },
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      recallUrls.push(String(url));
      recallBodies.push(JSON.parse(String(init?.body)));
      return respond();
    }) as typeof fetch,
    repoOf: () => "acme/widgets",
    headOf: () => "abc123",
    spawn: (args) => {
      spawned.push(args);
      return true;
    },
    ...extra,
  };
}

const json =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

const savedMode = process.env.DOSU_MEMORY_RECALL_MODE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-memory-hook-"));
  recallBodies = [];
  recallUrls = [];
  spawned = [];
  respond = json({ note: `  ${NOTE}\n`, episode_ids: ["e1"], latency_ms: 12 });
  // Phase 1's single recall; two-stage recall is covered in two-stage.test.ts.
  process.env.DOSU_MEMORY_RECALL_MODE = "single";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedMode === undefined) delete process.env.DOSU_MEMORY_RECALL_MODE;
  else process.env.DOSU_MEMORY_RECALL_MODE = savedMode;
});

describe("runMemoryHook with DOSU_MEMORY_RECALL_MODE=single", () => {
  it("injects the note as additionalContext on the first prompt only", async () => {
    const first = await runMemoryHook(
      payload("UserPromptSubmit", { prompt: "Fix the counter" }),
      deps(),
    );

    expect(first).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<prior_task_memory>\n${NOTE}\n</prior_task_memory>`,
        },
      }),
    );
    expect(recallBodies).toEqual([
      { repo: "acme/widgets", session_id: SESSION, prompt: "Fix the counter" },
    ]);
    expect(recallUrls).toEqual(["http://memory.test/v1/agent-memory/recall"]);
    expect(readSessionState(SESSION, dir)?.recall_mode).toBe("single");
    expect(await runMemoryHook(payload("PostToolBatch", { tool_calls: [] }), deps())).toBeNull();
    expect(
      await runMemoryHook(payload("UserPromptSubmit", { prompt: "And docs" }), deps()),
    ).toBeNull();
    expect(recallBodies).toHaveLength(1);
    expect(spawned).toEqual([]);
  });

  it.each([
    ["an empty note", json({ note: "", episode_ids: [], latency_ms: 3 })],
    ["the writer's NONE", json({ note: "NONE", episode_ids: ["e1"], latency_ms: 3 })],
    ["a server error", json({ detail: "boom" }, 500)],
    ["a response without a note", json({ episode_ids: [] })],
    ["a network failure", async () => Promise.reject(new Error("ECONNREFUSED"))],
  ])("prints nothing on %s", async (_label, response) => {
    respond = response;
    expect(
      await runMemoryHook(payload("UserPromptSubmit", { prompt: "Fix it" }), deps()),
    ).toBeNull();
    expect(readSessionState(SESSION, dir)).toMatchObject({ recall_attempted: true, note: null });
  });

  it("skips recall without a repository or credentials", async () => {
    expect(
      await runMemoryHook(
        payload("UserPromptSubmit", { prompt: "x" }),
        deps({ repoOf: () => null }),
      ),
    ).toBeNull();
    expect(
      await runMemoryHook(
        payload("UserPromptSubmit", { prompt: "x", session_id: "other" }),
        deps({ api: null }),
      ),
    ).toBeNull();
    expect(recallBodies).toEqual([]);
  });

  it("records the session at start and re-injects the same note after compaction", async () => {
    expect(await runMemoryHook(payload("SessionStart", { source: "startup" }), deps())).toBeNull();
    expect(readSessionState(SESSION, dir)).toMatchObject({
      transcript_path: "/home/dev/.claude/projects/w/session.jsonl",
      cwd: "/work/widgets",
      repo: "acme/widgets",
      start_head: "abc123",
      byte_offset: 0,
    });

    await runMemoryHook(payload("UserPromptSubmit", { prompt: "Fix it" }), deps());
    const resumed = await runMemoryHook(
      payload("SessionStart", { source: "resume" }),
      deps({ headOf: () => "def456" }),
    );
    const compacted = await runMemoryHook(payload("SessionStart", { source: "compact" }), deps());

    expect(resumed).toBeNull();
    expect(readSessionState(SESSION, dir)?.start_head).toBe("abc123");
    expect(JSON.parse(compacted ?? "{}")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `<prior_task_memory>\n${NOTE}\n</prior_task_memory>`,
      },
    });
    expect(recallBodies).toHaveLength(1);
  });

  it("hands Stop and SessionEnd to a detached sync and returns at once", async () => {
    expect(await runMemoryHook(payload("Stop"), deps())).toBeNull();
    expect(await runMemoryHook(payload("SessionEnd", { reason: "other" }), deps())).toBeNull();
    expect(spawned).toEqual([
      ["memory", "sync", "--session", SESSION],
      ["memory", "sync", "--session", SESSION, "--flush"],
    ]);
  });

  it("on Codex, waits for the one note at the prompt and leaves the background hook idle", async () => {
    const codex = (stageTwo: boolean) =>
      runMemoryHook(
        payload("UserPromptSubmit", {
          prompt: "Fix the counter",
          turn_id: "t1",
          transcript_path: null,
        }),
        deps(),
        { agent: "codex", stageTwo },
      );
    const [prompt, background] = await Promise.all([codex(false), codex(true)]);

    expect(prompt).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<prior_task_memory>\n${NOTE}\n</prior_task_memory>`,
        },
      }),
    );
    expect(background).toBeNull();
    expect(recallUrls).toEqual(["http://memory.test/v1/agent-memory/recall"]);
    expect(spawned).toEqual([]);
    expect(readSessionState(SESSION, dir)).toMatchObject({ agent: "codex", recall_mode: "single" });
  });

  it("ignores a missing or malformed payload", async () => {
    expect(await runMemoryHook(null, deps())).toBeNull();
    expect(await runMemoryHook(payload("Stop", { session_id: "../escape" }), deps())).toBeNull();
    expect(spawned).toEqual([]);
  });
});

describe("runMemoryHook on Cursor", () => {
  const BLOCK = `<prior_task_memory>\n${NOTE}\n</prior_task_memory>`;
  const NOW = new Date("2026-10-04T12:00:00.000Z");

  /** Cursor's common fields; its transcript is not read. */
  const cursorPayload = (event: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: event,
    conversation_id: SESSION,
    generation_id: "gen-1",
    cursor_version: "3.22.12",
    workspace_roots: ["/work/widgets"],
    transcript_path: "/home/dev/.cursor/projects/w/agent-transcripts/t.jsonl",
    ...extra,
  });
  const cursor = async (event: string, extra: Record<string, unknown> = {}, d = deps()) =>
    JSON.parse(
      (await runMemoryHook(cursorPayload(event, extra), { ...d, now: NOW }, { agent: "cursor" })) ??
        "null",
    );
  const toolCall = () =>
    cursor("postToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "a.py" },
      tool_output: '{"file_path":"a.py","content_length":8}',
    });
  const prompt = (text = "Fix the counter") => cursor("beforeSubmitPrompt", { prompt: text });

  it("prints one JSON object, whatever goes wrong", async () => {
    expect(await cursor("postToolUse", { conversation_id: "../escape" })).toEqual({});
    const broken = deps({
      repoOf: () => {
        throw new Error("git crashed");
      },
    });
    expect(await cursor("beforeSubmitPrompt", { prompt: "Fix it" }, broken)).toEqual({});
    expect(await runMemoryHook(null, deps(), { agent: "cursor" })).toBe("{}");
  });

  it("recalls on the first prompt and hands the note over with it", async () => {
    expect(await prompt()).toEqual({ additional_context: BLOCK });
    expect(recallBodies).toEqual([
      { repo: "acme/widgets", session_id: SESSION, prompt: "Fix the counter" },
    ]);

    expect(await toolCall()).toEqual({});
    expect(await prompt("And docs")).toEqual({});
    expect(recallBodies).toHaveLength(1);
    expect(readSessionState(SESSION, dir)).toMatchObject({
      agent: "cursor",
      cwd: "/work/widgets",
      transcript_path: eventLogPath(SESSION, dir),
    });
  });

  it("keeps a note under Cursor's context limit", async () => {
    respond = json({ note: "x".repeat(20_000), episode_ids: ["e1"], latency_ms: 12 });
    const { additional_context: context } = await prompt();
    expect(context.length).toBeLessThan(10_000);
    expect(context).toContain("characters cut");
  });

  it("puts the note back after the first tool call that follows a compaction", async () => {
    await prompt();
    expect(await cursor("preCompact", { trigger: "auto" })).toEqual({});
    expect(await toolCall()).toEqual({ additional_context: BLOCK });
    expect(await toolCall()).toEqual({});
  });

  it("replays a real session: records it, and hands the note to the main agent only", async () => {
    // Hook payloads Cursor's local runtime 2026.10.01 sent in one interactive session to the
    // events `hooks enable` installs: a read, a command that exits 0, one that exits 1, a read
    // that fails, a write, a subagent's read. Paths shortened.
    const payloads = readFileSync(
      join(__dirname, "testdata", "cursor-local-2026.10.01-session.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const handedOver: Array<{ event: string; conversation: string; output: string | null }> = [];
    for (const payload of payloads) {
      const output = await runMemoryHook(payload, { ...deps(), now: NOW }, { agent: "cursor" });
      if (output !== "{}") {
        handedOver.push({
          event: payload.hook_event_name,
          conversation: payload.conversation_id,
          output,
        });
      }
    }

    const main = "78ea4db5-9c55-4792-ac7d-9afd2ce92ae5";
    const ts = NOW.toISOString();
    const logged = readFileSync(eventLogPath(main, dir), "utf-8").trim().split("\n");
    expect(logged.map((line) => JSON.parse(line))).toEqual([
      { type: "user_prompt", ts, text: "Fix the off-by-one in the widget counter." },
      { type: "command", ts, command: "echo ok-from-shell", rc: 0, error_line: null },
      {
        type: "command",
        ts,
        command: "ls /definitely-missing-dir-xyz",
        rc: null,
        error_line: "ls: /definitely-missing-dir-xyz: No such file or directory",
      },
      { type: "file_edit", ts, tool: "Write", path: "notes.txt" },
      { type: "assistant_text", ts, text: "Done." },
    ]);
    expect(handedOver).toEqual([
      {
        event: "beforeSubmitPrompt",
        conversation: main,
        output: JSON.stringify({ additional_context: BLOCK }),
      },
    ]);
    // The subagent's read: a conversation of its own that never started, so no state.
    const sub = payloads.find(({ conversation_id }) => conversation_id !== main);
    expect(sub.hook_event_name).toBe("postToolUse");
    expect(readSessionState(sub.conversation_id, dir)).toBeNull();
    expect(spawned).toEqual([
      ["memory", "sync", "--session", main],
      ["memory", "sync", "--session", main, "--flush"],
    ]);
  });

  it("hands stop and sessionEnd to a detached sync", async () => {
    await cursor("sessionStart", { session_id: SESSION, composer_mode: "agent" });
    await cursor("stop", { status: "completed", loop_count: 0 });
    await cursor("sessionEnd", { session_id: SESSION, reason: "completed" });
    expect(spawned).toEqual([
      ["memory", "sync", "--session", SESSION],
      ["memory", "sync", "--session", SESSION, "--flush"],
    ]);
  });
});

describe("runMemoryHook for Claude Code, run by Cursor", () => {
  const savedVersion = process.env.CURSOR_VERSION;
  afterEach(() => {
    if (savedVersion === undefined) delete process.env.CURSOR_VERSION;
    else process.env.CURSOR_VERSION = savedVersion;
  });

  it("leaves a Cursor payload to the Cursor entry", async () => {
    const prompt = payload("UserPromptSubmit", { prompt: "Fix it", cursor_version: "3.22.12" });
    expect(await runMemoryHook(prompt, deps())).toBeNull();
    expect(recallBodies).toEqual([]);
    expect(readSessionState(SESSION, dir)).toBeNull();
  });

  it("still serves Claude Code started from Cursor's terminal", async () => {
    process.env.CURSOR_VERSION = "3.22.12";
    expect(await runMemoryHook(payload("UserPromptSubmit", { prompt: "Fix it" }), deps())).toBe(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `<prior_task_memory>\n${NOTE}\n</prior_task_memory>`,
        },
      }),
    );
  });
});

describe("repoOfDir", () => {
  const saved = process.env.DOSU_MEMORY_REPO;
  afterEach(() => {
    if (saved === undefined) delete process.env.DOSU_MEMORY_REPO;
    else process.env.DOSU_MEMORY_REPO = saved;
  });

  it("takes DOSU_MEMORY_REPO over the origin remote, and only in owner/name form", () => {
    const noRemote = mkdtempSync(join(tmpdir(), "dosu-memory-norepo-"));
    try {
      delete process.env.DOSU_MEMORY_REPO;
      expect(repoOfDir(noRemote)).toBeNull();
      process.env.DOSU_MEMORY_REPO = " Acme/Widgets ";
      expect(repoOfDir(noRemote)).toBe("Acme/Widgets");
      process.env.DOSU_MEMORY_REPO = "github.com/acme/widgets";
      expect(repoOfDir(noRemote)).toBeNull();
    } finally {
      rmSync(noRemote, { recursive: true, force: true });
    }
  });
});

describe("parseHookArgs", () => {
  it("takes the flags `hooks enable` writes and nothing else", () => {
    expect(parseHookArgs([])).toEqual({ agent: "claude-code" });
    expect(parseHookArgs(["--agent", "codex"])).toEqual({ agent: "codex" });
    expect(parseHookArgs(["--agent", "codex", "--stage-two"])).toEqual({
      agent: "codex",
      stageTwo: true,
    });
    expect(parseHookArgs(["--agent", "cursor"])).toEqual({ agent: "cursor" });
    expect(parseHookArgs(["--agent", "windsurf"])).toBeNull();
    expect(parseHookArgs(["--agent"])).toBeNull();
    expect(parseHookArgs(["--verbose"])).toBeNull();
  });
});
