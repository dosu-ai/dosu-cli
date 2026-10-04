import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_NOTE_PREFACE, type HookDeps, type HookEntry, runMemoryHook } from "./hook";
import { memoryDir, readFullRecallState, readSessionState } from "./state";
import { type PollDeps, pollFullRecall } from "./two-stage";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = "5f0c2a1e-7b3d-4c8e-9a61-2d4f8b0e1c37";
const QUICK = "Playbook: run `make test` before committing; fixtures live in tests/data.";
const FULL = "For this task: the counter is in widgets.py and `python3 widgets.py` checks it.";
const QUICK_PATH = "POST /v1/agent-memory/recall/quick";
const FULL_PATH = "POST /v1/agent-memory/recall/full";
const STATUS_PATH = "GET /v1/agent-memory/recall/full/job-1";
const api = { backendURL: "http://memory.test", apiKey: "test-key" };

const block = (note: string) => `<prior_task_memory>\n${note}\n</prior_task_memory>`;
const fullBlock = `${FULL_NOTE_PREFACE}\n${block(FULL)}`;
const output = (event: string, context: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });

/** Answers in the backend's shapes (phase2-impl.md 12.2). */
const QUICK_ANSWER = {
  note: QUICK,
  episode_ids: [],
  available_episode_ids: [],
  latency_ms: 900,
  cost_usd: null,
  recall_id: "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e",
};
const job = (extra: Record<string, unknown> = {}) => ({
  job_id: "job-1",
  status: "pending",
  mode: "retrieval",
  quick_recall_id: null,
  note: null,
  episode_ids: null,
  available_episode_ids: null,
  latency_ms: null,
  recall_latency_ms: null,
  cost_usd: null,
  error: null,
  recall_id: null,
  ...extra,
});

type Route = () => Promise<Response>;
const json =
  (body: unknown, status = 200): Route =>
  async () =>
    new Response(JSON.stringify(body), { status });
/** Answers in turn; the last one repeats. */
const sequence = (...routes: Route[]): Route => {
  let i = 0;
  return () => routes[Math.min(i++, routes.length - 1)]();
};
const failing =
  (error: () => unknown): Route =>
  async () =>
    Promise.reject(error());
/** fetch's failures as Bun (the code on the error) and Node (on its cause) raise them. */
const refused = () =>
  Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
    code: "ConnectionRefused",
  });
const unresolved = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.dosu.dev"), { code: "ENOTFOUND" }),
  });
const timedOut = () => new DOMException("The operation timed out.", "TimeoutError");
const reset = () =>
  Object.assign(new Error("The socket connection was closed unexpectedly."), {
    code: "ECONNRESET",
  });

let dir: string;
let routes: Record<string, Route>;
let calls: { key: string; body: unknown }[];
let spawned: string[][];
const savedMode = process.env.DOSU_MEMORY_RECALL_MODE;
const savedQuickTimeout = process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS;

const fetchImpl = (async (url: unknown, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
  calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null });
  const route = routes[key];
  if (!route) throw new Error(`unexpected request ${key}`);
  return route();
}) as typeof fetch;

const deps = (): HookDeps => ({
  configDir: dir,
  api,
  fetchImpl,
  repoOf: () => "acme/widgets",
  headOf: () => "abc123",
  spawn: (args) => {
    spawned.push(args);
    return true;
  },
});

const pollDeps = (extra: Partial<PollDeps> = {}): PollDeps => ({
  configDir: dir,
  api,
  fetchImpl,
  sleep: async () => {},
  ...extra,
});

const hook = (event: string, extra: Record<string, unknown> = {}, session = SESSION) =>
  runMemoryHook(
    {
      hook_event_name: event,
      session_id: session,
      transcript_path: "/home/dev/.claude/projects/w/session.jsonl",
      cwd: "/work/widgets",
      ...extra,
    },
    deps(),
  );
const firstPrompt = () => hook("UserPromptSubmit", { prompt: "Fix the counter" });
const laterPrompt = () => hook("UserPromptSubmit", { prompt: "Now update the docs" });
/** A batch of two parallel tool calls, one of them failed. */
const toolBatch = (session = SESSION) =>
  hook(
    "PostToolBatch",
    {
      tool_calls: [
        { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\n" } },
        { tool_name: "Bash", tool_input: { command: "make test" }, tool_response: "Exit code 2" },
      ],
    },
    session,
  );
const compact = () => hook("SessionStart", { source: "compact" });
const poll = (extra: Partial<PollDeps> = {}) => pollFullRecall(SESSION, pollDeps(extra));
/** A clock that moves only while the poller sleeps, so a retry loop ends at its deadline. */
const sleepingClock = (): Partial<PollDeps> => {
  let ms = Date.parse("2026-10-04T12:00:00Z");
  return {
    now: () => new Date(ms),
    sleep: async (interval) => {
      ms += interval;
    },
  };
};
const statusPolls = () => calls.filter((c) => c.key === STATUS_PATH).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-memory-two-stage-"));
  calls = [];
  spawned = [];
  routes = {
    [QUICK_PATH]: json({ ...QUICK_ANSWER, note: `  ${QUICK}\n` }),
    [FULL_PATH]: json(job(), 202),
    [STATUS_PATH]: json(job({ status: "done", note: FULL, latency_ms: 9_500 })),
  };
  delete process.env.DOSU_MEMORY_RECALL_MODE;
  delete process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (savedMode === undefined) delete process.env.DOSU_MEMORY_RECALL_MODE;
  else process.env.DOSU_MEMORY_RECALL_MODE = savedMode;
  if (savedQuickTimeout === undefined) delete process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS;
  else process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS = savedQuickTimeout;
});

describe("two-stage recall", () => {
  const request = { repo: "acme/widgets", session_id: SESSION, prompt: "Fix the counter" };

  it("injects stage one on the first prompt and leaves stage two to a detached poller", async () => {
    // Stage two's start never answers: the first prompt does not wait for it.
    routes[FULL_PATH] = () => new Promise<Response>(() => {});
    const timeouts = vi.spyOn(AbortSignal, "timeout");

    expect(await firstPrompt()).toBe(output("UserPromptSubmit", block(QUICK)));

    expect(calls).toEqual([{ key: QUICK_PATH, body: request }]);
    expect(timeouts.mock.calls).toEqual([[2_500]]);
    expect(spawned).toEqual([["memory", "recall-poll", "--session", SESSION]]);
    expect(readFullRecallState(SESSION, dir)).toBeNull();
    expect(readSessionState(SESSION, dir)).toMatchObject({ recall_mode: "two_stage", note: QUICK });
  });

  it("waits DOSU_MEMORY_QUICK_TIMEOUT_MS for stage one when it is a whole number", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS = "800";
    await firstPrompt();
    process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS = "soon";
    await hook("UserPromptSubmit", { prompt: "Fix the counter" }, "other-session");

    expect(timeouts.mock.calls).toEqual([[800], [2_500]]);
  });

  it("the poller starts stage two with the first prompt's request, then polls it", async () => {
    await firstPrompt();
    const timeouts = vi.spyOn(AbortSignal, "timeout");

    expect(await poll()).toMatchObject({ job_id: "job-1", status: "done", note: FULL });
    expect(calls.slice(1)).toEqual([
      { key: FULL_PATH, body: request },
      { key: STATUS_PATH, body: null },
    ]);
    expect(timeouts.mock.calls).toEqual([[10_000], [10_000]]);
    // The request, prompt included, was deleted on reading: a second run has nothing to start.
    expect(await poll()).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("the poller retries stage two's start while the request cannot leave", async () => {
    routes[FULL_PATH] = sequence(failing(refused), failing(unresolved), json(job(), 202));
    await firstPrompt();
    expect(await poll()).toMatchObject({ job_id: "job-1", status: "done", note: FULL });
    expect(calls.filter((c) => c.key === FULL_PATH)).toHaveLength(3);
  });

  it("stage two ready before the first tool batch: that batch injects it, and only it", async () => {
    await firstPrompt();
    expect(await poll()).toMatchObject({ status: "done", note: FULL });

    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));
    expect(await toolBatch()).toBeNull();
    expect(await laterPrompt()).toBeNull();
  });

  it("stage two ready after some tool batches: the first batch after it injects it", async () => {
    routes[STATUS_PATH] = sequence(
      json(job()),
      json(job()),
      json(job({ status: "done", note: FULL })),
    );
    await firstPrompt();
    expect(await toolBatch()).toBeNull();
    expect(await toolBatch()).toBeNull();

    expect(await poll()).toMatchObject({ status: "done", note: FULL });
    expect(statusPolls()).toBe(3);
    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));
    expect(await toolBatch()).toBeNull();
  });

  it("stage two ready after the last tool batch of the turn: the next prompt injects it", async () => {
    await firstPrompt();
    expect(await toolBatch()).toBeNull();
    await poll();
    const before = calls.length;

    expect(await laterPrompt()).toBe(output("UserPromptSubmit", fullBlock));
    expect(calls).toHaveLength(before);
    expect(await toolBatch()).toBeNull();
    expect(await laterPrompt()).toBeNull();
  });

  it.each<[string, Route, Partial<PollDeps>, string | null]>([
    ["the job fails", json(job({ status: "failed", error: "writer error" })), {}, "writer error"],
    ["the job is unknown", json({ detail: "Job not found" }, 404), {}, "HTTP 404"],
    ["the job outlives the deadline", json(job()), { deadlineMs: 0 }, "timed out"],
    ["the writer had nothing to say", json(job({ status: "done", note: "" })), {}, null],
  ])("injects no stage two when %s", async (_label, route, options, error) => {
    routes[STATUS_PATH] = route;
    await firstPrompt();
    const finished = await poll(options);

    expect(finished).toMatchObject({ note: null, error });
    expect(await toolBatch()).toBeNull();
    expect(await laterPrompt()).toBeNull();
    expect(await compact()).toBe(output("SessionStart", block(QUICK)));
  });

  it("keeps polling through network errors and 5xx until the job is done", async () => {
    routes[STATUS_PATH] = sequence(
      async () => Promise.reject(new Error("ECONNRESET")),
      json({ detail: "busy" }, 503),
      json(job({ status: "done", note: FULL })),
    );
    await firstPrompt();
    expect(await poll()).toMatchObject({ status: "done", note: FULL });
    expect(statusPolls()).toBe(3);
  });

  // Once the request may have arrived, sending it again could start a second job.
  it.each<[string, Route, Partial<PollDeps>]>([
    ["is rejected", json({ detail: "boom" }, 422), {}],
    ["answers 5xx", json({ detail: "boom" }, 503), {}],
    ["times out", failing(timedOut), {}],
    ["loses the connection", failing(reset), {}],
    ["cannot connect by the deadline", failing(refused), { deadlineMs: 0 }],
  ])("still injects stage one when stage two's start %s", async (_label, route, options) => {
    routes[FULL_PATH] = route;
    expect(await firstPrompt()).toBe(output("UserPromptSubmit", block(QUICK)));
    expect(await poll({ ...sleepingClock(), ...options })).toBeNull();
    expect(calls.filter((c) => c.key === FULL_PATH)).toHaveLength(1);
    expect(readFullRecallState(SESSION, dir)).toBeNull();
    expect(await toolBatch()).toBeNull();
    expect(await laterPrompt()).toBeNull();
  });

  it("still delivers stage two when stage one fails", async () => {
    routes[QUICK_PATH] = async () => Promise.reject(new Error("timeout"));
    expect(await firstPrompt()).toBeNull();
    await poll();
    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));
    expect(await compact()).toBe(output("SessionStart", fullBlock));
  });

  it("leaves stage two to the main agent when a subagent's tool batch fires first", async () => {
    await firstPrompt();
    await poll();
    expect(await hook("PostToolBatch", { tool_calls: [], agent_id: "a1" })).toBeNull();
    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));
  });

  it("hands stage two to exactly one of many concurrent hook runs", async () => {
    await firstPrompt();
    await poll();
    const results = await Promise.all(Array.from({ length: 20 }, () => toolBatch()));
    expect(results.filter((r) => r !== null)).toEqual([output("PostToolBatch", fullBlock)]);
    expect(await laterPrompt()).toBeNull();
  });

  it("puts back what was injected after compaction: stage one, then stage two once given", async () => {
    await firstPrompt();
    expect(await compact()).toBe(output("SessionStart", block(QUICK)));
    await poll();
    // Ready but not yet handed over: compaction leaves it for the next batch of tool calls.
    expect(await compact()).toBe(output("SessionStart", block(QUICK)));
    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));

    const both = output("SessionStart", `${block(QUICK)}\n\n${fullBlock}`);
    expect(await compact()).toBe(both);
    expect(await compact()).toBe(both);
    expect(await toolBatch()).toBeNull();
  });

  it("answers PostToolBatch in milliseconds from local files, without the network", async () => {
    const timed = async (session = SESSION) => {
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        await toolBatch(session);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return { median: times[100], p99: times[197] };
    };
    await firstPrompt();
    const requests = calls.length;

    const noRecall = await timed("0a1b2c3d-no-recall-session");
    const pending = await timed();
    await poll();
    const pollRequests = calls.length;
    expect(await toolBatch()).toBe(output("PostToolBatch", fullBlock));
    const injected = await timed();

    expect(calls).toHaveLength(pollRequests);
    expect(pollRequests).toBe(requests + 2);
    for (const { median, p99 } of [noRecall, pending, injected]) {
      expect(median).toBeLessThan(2);
      expect(p99).toBeLessThan(20);
    }
  });

  it("fixes the mode when the session's state is created; single uses phase 1's recall", async () => {
    process.env.DOSU_MEMORY_RECALL_MODE = "single";
    routes["POST /v1/agent-memory/recall"] = json({ note: QUICK, episode_ids: [] });
    await hook("SessionStart", { source: "startup" });
    delete process.env.DOSU_MEMORY_RECALL_MODE;

    expect(await firstPrompt()).toBe(output("UserPromptSubmit", block(QUICK)));
    expect(calls.map((c) => c.key)).toEqual(["POST /v1/agent-memory/recall"]);
    expect(spawned).toEqual([]);

    process.env.DOSU_MEMORY_RECALL_MODE = "three_stage";
    await hook("SessionStart", { source: "startup", session_id: "other-session" });
    expect(readSessionState("other-session", dir)?.recall_mode).toBe("two_stage");
  });

  it.each([
    "SessionStart",
    "SessionEnd",
  ])("%s deletes requests no poller read within 5 minutes", async (event) => {
    const request = (session: string) =>
      join(memoryDir(dir), `${session}.full-recall.request.json`);
    await firstPrompt();
    await hook("UserPromptSubmit", { prompt: "Fix the counter" }, "fresh-session");
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000);
    utimesSync(request(SESSION), sixMinutesAgo, sixMinutesAgo);

    await hook(event, { source: "startup" }, "another-session");

    expect(existsSync(request(SESSION))).toBe(false);
    expect(existsSync(request("fresh-session"))).toBe(true);
  });

  it("starts no stage two without credentials", async () => {
    await firstPrompt();
    expect(await poll({ api: null })).toBeNull();
    expect(calls.map((c) => c.key)).toEqual([QUICK_PATH]);
  });
});

describe("two-stage recall on Codex", () => {
  const request = { repo: "acme/widgets", session_id: SESSION, prompt: "Fix the counter" };
  /** A Codex payload: it adds turn_id and model, and may have no transcript. */
  const codex = (prompt: string, entry: HookEntry) =>
    runMemoryHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: SESSION,
        turn_id: "019a7c1e-turn",
        transcript_path: null,
        cwd: "/work/widgets",
        model: "gpt-6-sol",
        prompt,
      },
      deps(),
      entry,
    );
  const promptHook = (prompt: string) => codex(prompt, { agent: "codex" });
  const backgroundHook = (prompt: string) => codex(prompt, { agent: "codex", stageTwo: true });

  it("the prompt hook injects stage one; the background hook beside it prints stage two, once", async () => {
    const [first, second] = await Promise.all([
      promptHook("Fix the counter"),
      backgroundHook("Fix the counter"),
    ]);

    expect(first).toBe(output("UserPromptSubmit", block(QUICK)));
    expect(second).toBe(output("UserPromptSubmit", fullBlock));
    expect(spawned).toEqual([]);
    expect(calls.map((c) => c.key).sort()).toEqual([STATUS_PATH, FULL_PATH, QUICK_PATH]);
    expect(calls.filter((c) => c.key !== STATUS_PATH).map((c) => c.body)).toEqual([
      request,
      request,
    ]);
    expect(readSessionState(SESSION, dir)).toMatchObject({
      agent: "codex",
      transcript_path: null,
      note: QUICK,
    });

    expect(await promptHook("Now update the docs")).toBeNull();
    expect(await backgroundHook("Now update the docs")).toBeNull();
    expect(calls).toHaveLength(3);
    expect(await compact()).toBe(output("SessionStart", `${block(QUICK)}\n\n${fullBlock}`));
  });
});

describe("two-stage recall on Cursor", () => {
  const cursor = (event: string, extra: Record<string, unknown> = {}) =>
    runMemoryHook(
      {
        hook_event_name: event,
        conversation_id: SESSION,
        cursor_version: "3.22.12",
        workspace_roots: ["/work/widgets"],
        ...extra,
      },
      deps(),
      { agent: "cursor" },
    );
  const toolCall = () =>
    cursor("postToolUse", { tool_name: "Grep", tool_input: { pattern: "x" }, tool_output: "a.py" });
  const failedToolCall = () =>
    cursor("postToolUseFailure", {
      tool_name: "Read",
      tool_input: { file_path: "notes.txt" },
      error_message: "File not found: /work/widgets/notes.txt",
      failure_type: "error",
      is_interrupt: false,
    });
  const withContext = (context: string) => JSON.stringify({ additional_context: context });

  it("hands over stage one with the prompt and stage two after a later tool call", async () => {
    expect(await cursor("beforeSubmitPrompt", { prompt: "Fix the counter" })).toBe(
      withContext(block(QUICK)),
    );
    expect(spawned).toEqual([["memory", "recall-poll", "--session", SESSION]]);
    expect(await toolCall()).toBe("{}");
    await poll();

    expect(await failedToolCall()).toBe(withContext(fullBlock));
    expect(await toolCall()).toBe("{}");
  });

  it("after a compaction, hands both notes over again, one per prompt or tool call", async () => {
    await cursor("beforeSubmitPrompt", { prompt: "Fix the counter" });
    await poll();
    await toolCall();

    expect(await cursor("preCompact", { trigger: "auto" })).toBe("{}");
    expect(await toolCall()).toBe(withContext(block(QUICK)));
    expect(await cursor("beforeSubmitPrompt", { prompt: "Now update the docs" })).toBe(
      withContext(fullBlock),
    );
    expect(await toolCall()).toBe("{}");
  });
});
