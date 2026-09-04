import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { getVersionString } from "../version/version";
import { classifyGatewayError, runMiner, traceAgentMessage } from "./runner";

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

beforeEach(() => {
  queryMock.mockReset();
  conflictsMock.mockReset();
  conflictsMock.mockReturnValue([]);
  resolveExecutableMock.mockReset();
  resolveExecutableMock.mockReturnValue(undefined);
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

describe("runMiner", () => {
  it("fails closed on settings conflicts without spawning", async () => {
    conflictsMock.mockReturnValue([
      { file: "/etc/claude-code/managed-settings.json", keys: ["apiKeyHelper"] },
    ]);

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("settings_conflict");
    expect(result.message).toContain("managed-settings.json");
    expect(result.message).toContain("apiKeyHelper");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("completes on a success result and reports turns", async () => {
    queryReturning(successResult());

    const result = await runMiner(baseOptions);

    expect(result).toMatchObject({ outcome: "completed", turns: 3, notesWritten: 0 });
  });

  it("wires the gateway env, isolation options, and both MCP servers", async () => {
    queryReturning(successResult());

    await runMiner({ ...baseOptions, runID: "run-123" });

    const params = queryMock.mock.calls[0][0];
    expect(params.options.env.ANTHROPIC_BASE_URL).toBe("http://localhost:7001/v1/llm-gateway");
    expect(params.options.env.ANTHROPIC_AUTH_TOKEN).toBe("sk_user_test");
    expect(params.options.env.CLAUDE_CONFIG_DIR).toContain("dosu-miner-");
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
      "X-Dosu-Client": `dosu-cli-miner/${getVersionString()}`,
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
    resolveExecutableMock.mockReturnValue("/home/u/.local/bin/claude");
    queryReturning(successResult());

    await runMiner(baseOptions);

    const params = queryMock.mock.calls[0][0];
    expect(params.options.pathToClaudeCodeExecutable).toBe("/home/u/.local/bin/claude");
  });

  it("canUseTool denies non-allowlisted tools and enforces the note cap", async () => {
    queryReturning(successResult());

    await runMiner({ ...baseOptions, maxNotes: 2 });

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
    // Invoke the gate before the iterator is consumed: runMiner awaits the
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

    const result = await runMiner(baseOptions);

    expect(result.notesWritten).toBe(2);
  });

  it("maps a consent-off gateway refusal from the result text", async () => {
    queryReturning(successResult({ is_error: true, result: "API error: dosu_consent_off: nope" }));

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("consent_off");
    expect(result.message).toContain("org admin");
  });

  it("maps a quota error thrown by the SDK", async () => {
    queryMock.mockImplementation(() => {
      return (async function* () {
        yield await Promise.reject(
          new Error("stream failed: 429 dosu_quota_exceeded try tomorrow"),
        );
      })();
    });

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("quota_exceeded");
    expect(result.message).toContain("resume tomorrow");
  });

  it("returns an error outcome for non-success results", async () => {
    queryReturning(
      successResult({ subtype: "error_during_execution", is_error: true, result: undefined }),
    );

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("error");
  });

  it("returns an error when the stream ends without a result", async () => {
    queryReturning({ type: "assistant" });

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("without a result");
  });

  it("returns an error outcome when the SDK throws a non-gateway error", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    const result = await runMiner(baseOptions);

    expect(result.outcome).toBe("error");
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
});
