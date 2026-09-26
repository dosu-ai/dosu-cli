import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { getVersionString } from "../version/version";
import {
  classifyGatewayError,
  classifyGatewayRejection,
  classifyRejectionReason,
  runLearner,
  traceAgentMessage,
} from "./runner";

const debugMock = vi.hoisted(() => vi.fn());
vi.mock("../debug/logger", () => ({
  logger: { debug: debugMock, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const queryMock = vi.fn();
const conflictsMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => queryMock(params),
  createSdkMcpServer: (options: { name: string }) => ({
    type: "sdk",
    name: options.name,
    instance: {},
  }),
  tool: (name: string) => ({ name }),
}));

vi.mock("./conflicts", () => ({
  detectSettingsConflicts: () => conflictsMock(),
}));

const resolveExecutableMock = vi.hoisted(() => vi.fn());
vi.mock("./executable", () => ({
  resolveClaudeExecutable: () => resolveExecutableMock(),
}));

const sessions: AgentSession[] = [
  { id: "s1", harness: "claude", path: "/x/a.jsonl", updated: "2026-08-27T00:00:00.000Z" },
];

const baseOptions = {
  sessions,
  apiKey: "sk_user_test",
  deploymentID: "dep-1",
  trigger: "manual" as const,
  gatewayURL: "http://localhost:7001/v1/llm-gateway",
};

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "Read 1 session, wrote 1 note.",
    ...overrides,
  };
}

function queryReturning(...messages: unknown[]) {
  queryMock.mockReturnValue(
    (async function* () {
      yield* messages;
    })(),
  );
}

/** The gateway's capabilities endpoint, as the runner's model resolution sees it. */
const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  queryMock.mockReset();
  conflictsMock.mockReset();
  conflictsMock.mockReturnValue([]);
  resolveExecutableMock.mockReset();
  resolveExecutableMock.mockReturnValue({ kind: "sdk" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyGatewayError", () => {
  it("maps the three machine-readable gateway tokens", () => {
    expect(classifyGatewayError("403 dosu_consent_off: not enabled")?.outcome).toBe("consent_off");
    expect(classifyGatewayError("dosu_credit_limit_reached")?.outcome).toBe("credit_limit");
    expect(classifyGatewayError("429 dosu_quota_exceeded, retry later")?.outcome).toBe(
      "quota_exceeded",
    );
    expect(classifyGatewayError("some other failure")).toBeNull();
  });
});

describe("classifyGatewayRejection", () => {
  it("quotes the upstream text of a 400 the way Claude Code renders it", () => {
    expect(
      classifyGatewayRejection(
        "API Error: 400 max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001",
      ),
    ).toEqual({
      outcome: "gateway_rejected",
      message:
        "LLM gateway rejected the study run: max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001",
      reason: "max_tokens",
    });
  });

  it("unwraps the raw JSON error body older Claude Code builds print", () => {
    const result = classifyGatewayRejection(
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001"}}',
    );

    expect(result?.message).toBe(
      "LLM gateway rejected the study run: max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001",
    );
  });

  it("bounds the quoted text to one line", () => {
    const result = classifyGatewayRejection(`API Error: 400 bad\n${"x".repeat(1000)}`);

    expect(result?.message).not.toContain("\n");
    expect(result?.message.length).toBeLessThan(500);
    expect(result?.message).toContain("…");
  });

  it("ignores other statuses and non-API text", () => {
    expect(classifyGatewayRejection("API Error: 500 upstream exploded")).toBeNull();
    expect(classifyGatewayRejection("spawn ENOENT")).toBeNull();
  });
});

describe("classifyRejectionReason", () => {
  it.each([
    ["dosu_unsupported_request: system-role messages need claude-opus-5-5", "unsupported_request"],
    ["messages.0.role: Input should be 'user' or 'assistant'", "system_role_unsupported"],
    [
      'Unexpected role "system". The Messages API accepts a top-level `system` parameter',
      "system_role_unsupported",
    ],
    [
      "thinking.type: Input tag 'adaptive' found using 'type' does not match",
      "adaptive_thinking_unsupported",
    ],
    ["adaptive thinking is not supported on this model", "adaptive_thinking_unsupported"],
    ["output_config.effort: Extra inputs are not permitted", "effort_unsupported"],
    [
      "messages.1.output_config: output_config is only permitted on role 'system' messages",
      "effort_unsupported",
    ],
    ["`max_tokens` must be greater than `thinking.budget_tokens`", "max_tokens"],
    ["thinking.budget_tokens: Input should be greater than or equal to 1024", "other"],
    ["max_tokens: 128000 > 64000, which is the maximum allowed", "max_tokens"],
    ["prompt is too long: 250000 tokens > 200000 maximum", "context_length"],
    [
      "input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000",
      "context_length",
    ],
    ["something nobody anticipated", "other"],
  ])("maps %j to %s", (text, reason) => {
    expect(classifyRejectionReason(text)).toBe(reason);
  });
});

describe("runLearner", () => {
  it("fails closed when the gateway URL is not absolute", async () => {
    const result = await runLearner({ ...baseOptions, gatewayURL: "/v1/llm-gateway" });

    expect(result.outcome).toBe("error");
    expect(result.message).toMatch(/gateway URL/i);
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on settings conflicts without spawning", async () => {
    conflictsMock.mockReturnValue([
      { file: "/etc/claude-code/managed-settings.json", keys: ["apiKeyHelper"] },
    ]);

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("settings_conflict");
    expect(result.message).toContain("managed-settings.json");
    expect(result.message).toContain("apiKeyHelper");
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses cleanly, before spawning anything, when no Claude Code is installed", async () => {
    resolveExecutableMock.mockReturnValue({ kind: "missing" });

    const result = await runLearner(baseOptions);

    expect(result).toMatchObject({ outcome: "claude_code_missing", notesWritten: 0, turns: 0 });
    expect(result.message).toMatch(/Claude Code/);
    expect(result.message).toContain("dosu knowledge sync");
    expect(result.message).not.toContain("\n");
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the model the gateway serves in both the env and the SDK options", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: "claude-sonnet-5", max_output_tokens: 64000 }), {
        status: 200,
      }),
    );
    queryReturning(successResult());

    await runLearner(baseOptions);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:7001/v1/llm-gateway/capabilities",
      expect.objectContaining({ headers: { Authorization: "Bearer sk_user_test" } }),
    );
    const params = queryMock.mock.calls[0][0];
    expect(params.options.model).toBe("claude-sonnet-5");
    expect(params.options.env.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(params.options.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "x-dosu-expected-model: claude-sonnet-5",
    );
    expect(debugMock).toHaveBeenCalledWith("learner", "study run model: claude-sonnet-5");
  });

  it("reports coarse diagnostics: executable source, init version, and pinned model", async () => {
    resolveExecutableMock.mockReturnValue({ kind: "system", path: "/home/u/.local/bin/claude" });
    queryReturning(
      { type: "system", subtype: "init", claude_code_version: "2.1.280" },
      successResult(),
    );

    const result = await runLearner(baseOptions);

    expect(result).toMatchObject({
      outcome: "completed",
      claudeCodeSource: "system",
      claudeCodeVersion: "2.1.280",
      model: "claude-haiku-4-5",
    });
    expect(result.gatewayReason).toBeUndefined();
  });

  it("reports a missing Claude Code as the executable source", async () => {
    resolveExecutableMock.mockReturnValue({ kind: "missing" });

    const result = await runLearner(baseOptions);

    expect(result.claudeCodeSource).toBe("missing");
    expect(result.model).toBeUndefined();
  });

  it("ignores a non-string Claude Code version on the init message", async () => {
    queryReturning({ type: "system", subtype: "init", claude_code_version: 7 }, successResult());

    const result = await runLearner(baseOptions);

    expect(result.claudeCodeSource).toBe("sdk");
    expect(result.claudeCodeVersion).toBeUndefined();
  });

  it("pins the default model when the gateway can't report one", async () => {
    queryReturning(successResult());

    await runLearner(baseOptions);

    const params = queryMock.mock.calls[0][0];
    expect(params.options.model).toBe("claude-haiku-4-5");
    expect(params.options.env.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
  });

  it("completes on a success result and reports turns", async () => {
    queryReturning(successResult());

    const result = await runLearner(baseOptions);

    expect(result).toMatchObject({ outcome: "completed", turns: 3, notesWritten: 0 });
  });

  it("wires the gateway env, isolation options, and both MCP servers", async () => {
    queryReturning(successResult());

    await runLearner({ ...baseOptions, runID: "run-123" });

    const params = queryMock.mock.calls[0][0];
    expect(params.options.env.ANTHROPIC_BASE_URL).toBe("http://localhost:7001/v1/llm-gateway");
    expect(params.options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk_user_test");
    expect(params.options.env.CLAUDE_CONFIG_DIR).toContain("dosu-learner-");
    expect(params.options.settingSources).toEqual([]);
    expect(params.options.persistSession).toBe(false);
    expect(params.options.sandbox).toEqual({ enabled: true, failIfUnavailable: false });
    expect(Object.keys(params.options.mcpServers)).toEqual(["sessions", "dosu"]);
    expect(params.options.mcpServers.dosu.type).toBe("http");
    // Session-context headers ride on every knowledge MCP request; no repo/branch/commit
    // headers because a run spans many repos.
    expect(params.options.mcpServers.dosu.headers).toMatchObject({
      "X-Dosu-API-Key": "sk_user_test",
      "X-Dosu-Session-Id": "run-123",
      "X-Dosu-Client": `dosu-cli-learner/${getVersionString()}`,
      "X-Dosu-Session-Started-At": "2026-08-27T00:00:00.000Z",
    });
    expect(params.options.mcpServers.dosu.headers).not.toHaveProperty("X-Dosu-Repo");
    expect(params.options.mcpServers.dosu.headers).not.toHaveProperty("X-Dosu-Branch");
    expect(params.options.mcpServers.dosu.headers).not.toHaveProperty("X-Dosu-Commit");
    // No allowedTools: bare entries would auto-approve ahead of canUseTool
    // and bypass the note cap. The callback is the only gate.
    expect(params.options.allowedTools).toBeUndefined();
    // SDK resolves its own binary when available; no override passed.
    expect(params.options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("passes a fallback Claude executable when the SDK binary is unavailable", async () => {
    resolveExecutableMock.mockReturnValue({ kind: "system", path: "/home/u/.local/bin/claude" });
    queryReturning(successResult());

    await runLearner(baseOptions);

    const params = queryMock.mock.calls[0][0];
    expect(params.options.pathToClaudeCodeExecutable).toBe("/home/u/.local/bin/claude");
  });

  it("routes SDK stderr into the debug log", async () => {
    queryReturning(successResult());

    await runLearner(baseOptions);

    queryMock.mock.calls[0][0].options.stderr("boom on the sdk");
    expect(debugMock).toHaveBeenCalledWith("learner", "[sdk] boom on the sdk");
  });

  it("canUseTool denies non-allowlisted tools and enforces the note cap", async () => {
    queryReturning(successResult());

    await runLearner({ ...baseOptions, maxNotes: 2 });

    const { canUseTool } = queryMock.mock.calls[0][0].options;
    const signal = { signal: new AbortController().signal, suggestions: [] };

    expect((await canUseTool("Bash", {}, signal)).behavior).toBe("deny");
    expect((await canUseTool("Read", {}, signal)).behavior).toBe("deny");
    expect((await canUseTool("mcp__sessions__read_session", { id: "s1" }, signal)).behavior).toBe(
      "allow",
    );
    expect((await canUseTool("mcp__dosu__write_knowledge", {}, signal)).behavior).toBe("allow");
    expect((await canUseTool("mcp__dosu__write_knowledge", {}, signal)).behavior).toBe("allow");
    const third = await canUseTool("mcp__dosu__write_knowledge", {}, signal);
    expect(third.behavior).toBe("deny");
    expect(third.message).toContain("Note cap reached");
  });

  it("counts allowed write_knowledge calls in the result", async () => {
    queryReturning(successResult());
    // Invoke the gate before the iterator is consumed: runLearner awaits the
    // full stream, so trigger writes from inside a queued microtask.
    type GateParams = {
      options: { canUseTool: (name: string, input: object, extra: object) => Promise<unknown> };
    };
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        await params.options.canUseTool("mcp__dosu__write_knowledge", {}, {});
        await params.options.canUseTool("mcp__dosu__write_knowledge", {}, {});
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.notesWritten).toBe(2);
  });

  type GateResult = { behavior: string; updatedInput?: Record<string, unknown>; message?: string };
  type GateParams = {
    options: { canUseTool: (name: string, input: object, extra: object) => Promise<GateResult> };
  };
  const read = (id: string) => ["mcp__sessions__read_session", { id }, {}] as const;
  const write = (title: string) =>
    [
      "mcp__dosu__write_knowledge",
      { title, content: "c", transcript_id: "model-junk" },
      {},
    ] as const;

  it("attributes each note to the session currently being studied", async () => {
    const g: GateResult[] = [];
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        // Interleaved read→write→read→write: each note gets its own session.
        await params.options.canUseTool(...read("s1"));
        g.push(await params.options.canUseTool(...write("note-a")));
        await params.options.canUseTool(...read("s2"));
        g.push(await params.options.canUseTool(...write("note-b")));
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.notesWritten).toBe(2);
    expect(g[0].updatedInput).toEqual({ title: "note-a", content: "c", transcript_id: "s1" });
    expect(g[1].updatedInput).toEqual({ title: "note-b", content: "c", transcript_id: "s2" });
  });

  it("attributes EVERY note of a session read once and studied for several notes", async () => {
    const g: GateResult[] = [];
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        // One read, three writes (the common shape); then the next session.
        await params.options.canUseTool(...read("s1"));
        g.push(await params.options.canUseTool(...write("s1-a")));
        g.push(await params.options.canUseTool(...write("s1-b")));
        g.push(await params.options.canUseTool(...write("s1-c")));
        await params.options.canUseTool(...read("s2"));
        g.push(await params.options.canUseTool(...write("s2-a")));
        g.push(await params.options.canUseTool(...write("s2-b")));
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.notesWritten).toBe(5);
    // All three s1 notes → s1; both s2 notes → s2. No note goes null just for
    // being the 2nd+ from its session (the bug real studying surfaced).
    expect(g.map((r) => r.updatedInput?.transcript_id)).toEqual(["s1", "s1", "s1", "s2", "s2"]);
  });

  it("denies a write after reading several sessions, then attributes the re-read one", async () => {
    const g: GateResult[] = [];
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        // Read-all-then-write: the source is ambiguous, so the write is denied.
        await params.options.canUseTool(...read("s1"));
        await params.options.canUseTool(...read("s2"));
        g.push(await params.options.canUseTool(...write("ambiguous")));
        // Model complies: re-reads only the right session, then writes.
        await params.options.canUseTool(...read("s2"));
        g.push(await params.options.canUseTool(...write("resolved")));
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(g[0].behavior).toBe("deny");
    expect(g[0].message).toMatch(/one session|before reading the next/i);
    expect(g[1].updatedInput).toEqual({ title: "resolved", content: "c", transcript_id: "s2" });
    // The denied write is not counted; only the resolved one is.
    expect(result.notesWritten).toBe(1);
  });

  it("leaves a note unattributed when no session was read before it", async () => {
    const g: GateResult[] = [];
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        g.push(await params.options.canUseTool(...write("orphan")));
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.notesWritten).toBe(1);
    // No session to attribute → genuinely unattributed. Any transcript_id the
    // model supplied is stripped so the attested backend stores null.
    expect(g[0].updatedInput).toEqual({ title: "orphan", content: "c" });
    expect(g[0].updatedInput).not.toHaveProperty("transcript_id");
  });

  it("ignores an id-less read (a paging call) so it doesn't count as a session", async () => {
    const g: GateResult[] = [];
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        // A read with no id (offset-only paging) adds nothing, so the following
        // write has no session to attribute to.
        await params.options.canUseTool("mcp__sessions__read_session", { offset: 2 }, {});
        g.push(await params.options.canUseTool(...write("no-real-read")));
        yield successResult();
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.notesWritten).toBe(1);
    // Stripped: an id-less read is no session, so the model's value must not survive.
    expect(g[0].updatedInput).toEqual({ title: "no-real-read", content: "c" });
  });

  const threeSessions: AgentSession[] = ["s1", "s2", "s3"].map((id) => ({
    id,
    harness: id === "s2" ? "cursor" : "claude",
    path: `/x/${id}.jsonl`,
    updated: "2026-08-27T00:00:00.000Z",
  }));

  /** A write_knowledge call the gate sees under `toolUseID`, as the SDK passes it. */
  const noteCall = (title: string, toolUseID: string) =>
    [
      "mcp__dosu__write_knowledge",
      { title, content: "c" },
      { signal: new AbortController().signal, toolUseID },
    ] as const;
  /** The tool_result the stream carries back for a call. */
  const toolResult = (toolUseID: string, isError?: boolean) => ({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseID,
          content: isError ? "write failed" : "saved",
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  });

  it("reports which sessions got notes when a later turn fails", async () => {
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        await params.options.canUseTool(...read("s1"));
        await params.options.canUseTool(...noteCall("s1-a", "tu-1"));
        await params.options.canUseTool(...noteCall("s1-b", "tu-2"));
        yield toolResult("tu-1");
        yield toolResult("tu-2", false);
        await params.options.canUseTool(...read("s2"));
        await params.options.canUseTool(...noteCall("s2-a", "tu-3"));
        yield toolResult("tu-3");
        // Read but never noted: not reported, so a retry studies it.
        await params.options.canUseTool(...read("s3"));
        yield successResult({ is_error: true, result: "API Error: 400 bad request" });
      })();
    });

    const result = await runLearner({ ...baseOptions, sessions: threeSessions });

    expect(result.outcome).toBe("gateway_rejected");
    expect(result.notesWritten).toBe(3);
    // Keyed `harness/id`, the shape sync's studied-session history uses.
    expect(result.notedSessions).toEqual(["claude/s1", "cursor/s2"]);
  });

  it("counts a session as noted only once its write succeeds", async () => {
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        await params.options.canUseTool(...read("s1"));
        await params.options.canUseTool(...noteCall("s1-a", "tu-1"));
        yield toolResult("tu-1", true);
        await params.options.canUseTool(...read("s2"));
        // Allowed, but the run died before the write's result came back.
        await params.options.canUseTool(...noteCall("s2-a", "tu-2"));
        await params.options.canUseTool(...read("s3"));
        await params.options.canUseTool(...noteCall("s3-a", "tu-3"));
        // A result for some other tool call never counts.
        yield toolResult("tu-unrelated");
        yield toolResult("tu-3");
        yield await Promise.reject(new Error("socket hang up"));
      })();
    });

    const result = await runLearner({ ...baseOptions, sessions: threeSessions });

    expect(result.outcome).toBe("sdk_error");
    expect(result.notedSessions).toEqual(["claude/s3"]);
  });

  it("leaves denied, unattributed, and out-of-scope notes out of the noted sessions", async () => {
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        // Unattributed: no session read yet.
        await params.options.canUseTool(...noteCall("orphan", "tu-1"));
        // Denied: ambiguous after two different reads.
        await params.options.canUseTool(...read("s1"));
        await params.options.canUseTool(...read("s2"));
        await params.options.canUseTool(...noteCall("ambiguous", "tu-2"));
        // Out of scope: the read_session tool itself rejects unknown ids.
        await params.options.canUseTool(...read("not-in-run"));
        await params.options.canUseTool(...noteCall("stray", "tu-3"));
        yield toolResult("tu-1");
        yield toolResult("tu-2");
        yield toolResult("tu-3");
        yield successResult();
      })();
    });

    const result = await runLearner({ ...baseOptions, sessions: threeSessions });

    expect(result.notesWritten).toBe(2);
    expect(result.notedSessions).toEqual([]);
  });

  it("reports noted sessions on completed and result-less runs too", async () => {
    queryMock.mockImplementation((params: GateParams) => {
      return (async function* () {
        await params.options.canUseTool(...read("s3"));
        await params.options.canUseTool(...noteCall("s3-a", "tu-1"));
        yield toolResult("tu-1");
        yield { type: "assistant" };
      })();
    });

    const endedEarly = await runLearner({ ...baseOptions, sessions: threeSessions });
    expect(endedEarly.outcome).toBe("no_result");
    expect(endedEarly.notedSessions).toEqual(["claude/s3"]);

    queryReturning(successResult());
    const completed = await runLearner({ ...baseOptions, sessions: threeSessions });
    expect(completed.outcome).toBe("completed");
    expect(completed.notedSessions).toEqual([]);
  });

  it("maps a consent-off gateway refusal from the result text", async () => {
    queryReturning(successResult({ is_error: true, result: "API error: dosu_consent_off: nope" }));

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("consent_off");
    expect(result.message).toContain("org admin");
  });

  it("maps an upstream 400 error result to gateway_rejected with the quoted text", async () => {
    queryReturning(
      successResult({
        is_error: true,
        api_error_status: 400,
        result:
          "API Error: 400 max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001",
      }),
    );

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("gateway_rejected");
    expect(result.message).toBe(
      "LLM gateway rejected the study run: max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5-20251001",
    );
    expect(result.gatewayReason).toBe("max_tokens");
  });

  it("lets a dosu_* refusal token win over a 400", async () => {
    queryReturning(
      successResult({ is_error: true, result: "API Error: 400 dosu_credit_limit_reached" }),
    );

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("credit_limit");
  });

  it("keeps a completed run whose summary mentions a 400 completed", async () => {
    queryReturning(successResult({ result: "API Error: 400 was the bug this session fixed." }));

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("completed");
  });

  it("maps a 400 thrown by the SDK", async () => {
    queryMock.mockImplementation(() => {
      return (async function* () {
        yield await Promise.reject(
          new Error("Claude Code returned an error result: API Error: 400 max_tokens too large"),
        );
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("gateway_rejected");
    expect(result.message).toBe("LLM gateway rejected the study run: max_tokens too large");
    expect(result.gatewayReason).toBe("max_tokens");
  });

  it("maps a quota error thrown by the SDK", async () => {
    queryMock.mockImplementation(() => {
      return (async function* () {
        yield await Promise.reject(
          new Error("stream failed: 429 dosu_quota_exceeded try tomorrow"),
        );
      })();
    });

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("quota_exceeded");
    expect(result.message).toContain("resume tomorrow");
  });

  it("reports run_failed for non-success results", async () => {
    queryReturning(
      successResult({ subtype: "error_during_execution", is_error: true, result: undefined }),
    );

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("run_failed");
  });

  it("reports max_turns when the run hits its turn limit", async () => {
    queryReturning(
      successResult({ subtype: "error_max_turns", is_error: true, result: undefined }),
    );

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("max_turns");
    expect(result.message).toMatch(/turn limit/);
  });

  it("returns an error when the stream ends without a result", async () => {
    queryReturning({ type: "assistant" });

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("no_result");
    expect(result.message).toContain("without a result");
  });

  it("returns an error outcome when the SDK throws a non-gateway error", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("sdk_error");
    expect(result.message).toBe("Study run failed; see debug log for details.");
    expect(debugMock).toHaveBeenCalledWith("learner", expect.stringContaining("spawn ENOENT"));
  });

  it("stringifies a non-Error throw from the SDK", async () => {
    queryMock.mockImplementation(() => {
      throw "socket hang up";
    });

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("sdk_error");
    expect(debugMock).toHaveBeenCalledWith("learner", expect.stringContaining("socket hang up"));
  });

  it("treats a success result with no result text as completed with no message", async () => {
    queryReturning(successResult({ result: undefined }));

    const result = await runLearner(baseOptions);

    expect(result).toMatchObject({ outcome: "completed", turns: 3 });
    expect(result.message).toBeUndefined();
  });

  it("treats an error result with no result text as a generic failure", async () => {
    queryReturning(successResult({ is_error: true, result: undefined }));

    const result = await runLearner(baseOptions);

    expect(result.outcome).toBe("run_failed");
    expect(result.message).toBe("Study run failed; see debug log for details.");
  });

  it("falls back to the configured LLM gateway URL when none is passed", async () => {
    const previous = process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE;
    process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE = "https://gateway.example.test/v1/llm-gateway";
    try {
      queryReturning(successResult());

      const { gatewayURL: _omitted, ...withoutGateway } = baseOptions;
      const result = await runLearner(withoutGateway);

      expect(result.outcome).toBe("completed");
      const params = queryMock.mock.calls[0][0];
      expect(params.options.env.ANTHROPIC_BASE_URL).toBe(
        "https://gateway.example.test/v1/llm-gateway",
      );
    } finally {
      if (previous === undefined) delete process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE;
      else process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE = previous;
    }
  });

  it("omits the session-started header when the run has no sessions", async () => {
    queryReturning(successResult());

    await runLearner({ ...baseOptions, sessions: [] });

    const headers = queryMock.mock.calls[0][0].options.mcpServers.dosu.headers;
    expect(headers).not.toHaveProperty("X-Dosu-Session-Started-At");
    expect(headers).toHaveProperty("X-Dosu-Session-Id");
  });

  it("aborts the run on the wall-clock timeout and reports it as timed out", async () => {
    type AbortParams = { options: { abortController: AbortController } };
    queryMock.mockImplementation((params: AbortParams) => {
      const { signal } = params.options.abortController;
      return (async function* () {
        // Hang until the runner's timer fires, then fail the way the SDK would.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("Request was aborted.");
      })();
    });

    const result = await runLearner({ ...baseOptions, timeoutMs: 5 });

    expect(result.outcome).toBe("timed_out");
    expect(result.message).toBe("Study run timed out and was aborted.");
  });
});

describe("traceAgentMessage", () => {
  beforeEach(() => debugMock.mockClear());

  function traced(): string {
    return debugMock.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("logs assistant text and tool calls with their arguments", () => {
    traceAgentMessage({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the first session\nnow." },
          { type: "tool_use", name: "mcp__sessions__read_session", input: { id: "s1" } },
        ],
      },
    });

    const logged = traced();
    expect(logged).toContain("[agent] Reading the first session now.");
    expect(logged).toContain('[agent] → mcp__sessions__read_session {"id":"s1"}');
  });

  it("logs tool results with size and error flag", () => {
    traceAgentMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: "session transcript here" },
          { type: "tool_result", content: "denied", is_error: true },
        ],
      },
    });

    const logged = traced();
    expect(logged).toMatch(/\[agent\] ← result \d+ chars: session transcript here/);
    expect(logged).toContain("(error): denied");
  });

  it("truncates oversized snippets", () => {
    traceAgentMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(1000) }] },
    });

    const line = debugMock.mock.calls[0].join(" ");
    expect(line.length).toBeLessThan(500);
    expect(line).toContain("…");
  });

  it("ignores messages without array content", () => {
    traceAgentMessage({ type: "result", subtype: "success" });
    traceAgentMessage({ type: "assistant", message: { content: "plain string" } });

    expect(debugMock).not.toHaveBeenCalled();
  });

  it("logs a tool call with no arguments and a result with no content", () => {
    traceAgentMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__sessions__list_sessions" }] },
    });
    traceAgentMessage({
      type: "user",
      message: { content: [{ type: "tool_result" }] },
    });

    const lines = debugMock.mock.calls.map((c) => c.join(" "));
    expect(lines[0]).toBe("learner [agent] → mcp__sessions__list_sessions ");
    // Missing content is treated as an empty string: 2 chars once JSON-quoted.
    expect(lines[1]).toBe("learner [agent] ← result 2 chars: ");
  });

  it("skips blocks whose type does not match the message role", () => {
    traceAgentMessage({
      type: "user",
      message: { content: [{ type: "text", text: "a user typed this" }] },
    });
    traceAgentMessage({
      type: "assistant",
      message: { content: [{ type: "tool_result", content: "misplaced" }] },
    });

    expect(debugMock).not.toHaveBeenCalled();
  });
});
