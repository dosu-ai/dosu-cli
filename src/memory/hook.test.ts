import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HookDeps, runMemoryHook } from "./hook";
import { readSessionState } from "./state";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "5f0c2a1e-7b3d-4c8e-9a61-2d4f8b0e1c37";
const NOTE = "Earlier sessions ran `make test` before committing; fixtures live in tests/data.";

let dir: string;
let recallBodies: unknown[];
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
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-memory-hook-"));
  recallBodies = [];
  spawned = [];
  respond = json({ note: `  ${NOTE}\n`, episode_ids: ["e1"], latency_ms: 12 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runMemoryHook", () => {
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
    expect(
      await runMemoryHook(payload("UserPromptSubmit", { prompt: "And docs" }), deps()),
    ).toBeNull();
    expect(recallBodies).toHaveLength(1);
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

  it("ignores a missing or malformed payload", async () => {
    expect(await runMemoryHook(null, deps())).toBeNull();
    expect(await runMemoryHook(payload("Stop", { session_id: "../escape" }), deps())).toBeNull();
    expect(spawned).toEqual([]);
  });
});
