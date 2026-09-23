/**
 * Request-shape guard for study runs: a pinned learner run against a REAL Claude Code and a local
 * Anthropic-shaped stub must only send requests the gateway's served model (Haiku 4.5) accepts.
 * Users' Claude Code auto-updates, so a new request shape must fail here before it reaches them.
 * Skipped when no Claude Code resolves; `DOSU_TEST_CLAUDE_BIN` forces a specific system binary.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildLearnerEnv } from "./env";
import { type ClaudeExecutable, resolveClaudeExecutable } from "./executable";
import { DEFAULT_LEARNER_MODEL } from "./model";

/** Haiku 4.5's output ceiling. */
const MAX_OUTPUT_TOKENS = 64_000;
const MIN_THINKING_BUDGET = 1024;
const TOOL_NAME = "mcp__shape__echo";

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "context_management",
  "output_config",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
]);
const ALLOWED_ROLES = new Set(["user", "assistant"]);
const ALLOWED_MESSAGE_KEYS = new Set(["role", "content"]);

type JSONObject = Record<string, unknown>;

function isObject(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlocks(message: JSONObject): JSONObject[] {
  return Array.isArray(message.content) ? message.content.filter(isObject) : [];
}

function checkThinking(thinking: unknown, maxTokens: unknown): string[] {
  if (!isObject(thinking)) return ["thinking is not an object"];
  if (thinking.type === "disabled") return [];
  if (thinking.type !== "enabled") return [`thinking.type is ${JSON.stringify(thinking.type)}`];
  const budget = thinking.budget_tokens;
  if (typeof budget !== "number" || !Number.isInteger(budget)) {
    return ["thinking.budget_tokens is not an integer"];
  }
  if (budget < MIN_THINKING_BUDGET) {
    return [`thinking.budget_tokens ${budget} is below ${MIN_THINKING_BUDGET}`];
  }
  if (typeof maxTokens === "number" && budget >= maxTokens) {
    return [`thinking.budget_tokens ${budget} is not below max_tokens ${maxTokens}`];
  }
  return [];
}

function checkMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return ["messages is not an array"];
  const violations: string[] = [];
  const toolUseIDs = new Set<string>();
  messages.forEach((message, i) => {
    const at = `messages[${i}]`;
    if (!isObject(message)) {
      violations.push(`${at} is not an object`);
      return;
    }
    if (!ALLOWED_ROLES.has(message.role as string)) {
      violations.push(`${at}.role is ${JSON.stringify(message.role)}`);
    }
    for (const key of Object.keys(message)) {
      if (!ALLOWED_MESSAGE_KEYS.has(key)) violations.push(`${at} has unexpected key "${key}"`);
    }
    let pastToolResults = false;
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use" && typeof block.id === "string") toolUseIDs.add(block.id);
      if (block.type !== "tool_result") {
        pastToolResults = true;
        continue;
      }
      if (pastToolResults) violations.push(`${at} has a tool_result after non-tool_result content`);
      if (!toolUseIDs.has(block.tool_use_id as string)) {
        violations.push(`${at} has a tool_result with no earlier tool_use`);
      }
    }
  });
  return violations;
}

/** Why the served model would reject one `/v1/messages` body, or which fields are new and
 * unvetted. Violations name locations and keys only, never prompt text. */
function checkLearnerRequest(body: unknown, model: string = DEFAULT_LEARNER_MODEL): string[] {
  if (!isObject(body)) return ["body is not a JSON object"];
  const violations: string[] = [];
  if (body.model !== model) {
    violations.push(`model is ${JSON.stringify(body.model)}, expected "${model}"`);
  }
  for (const key of Object.keys(body)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) violations.push(`unexpected top-level key "${key}"`);
  }
  if (typeof body.max_tokens !== "number") {
    violations.push("max_tokens is missing");
  } else if (body.max_tokens > MAX_OUTPUT_TOKENS) {
    violations.push(`max_tokens ${body.max_tokens} exceeds ${MAX_OUTPUT_TOKENS}`);
  }
  if (body.thinking !== undefined) {
    violations.push(...checkThinking(body.thinking, body.max_tokens));
  }
  if (isObject(body.output_config) && "effort" in body.output_config) {
    violations.push("output_config.effort is set");
  }
  violations.push(...checkMessages(body.messages));
  return violations;
}

/** A second-turn request in the shape Claude Code sends when pinned to Haiku 4.5. */
function haikuRequest(): JSONObject {
  return {
    model: DEFAULT_LEARNER_MODEL,
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "placeholder system" }],
    tools: [{ name: TOOL_NAME, description: "placeholder", input_schema: {} }],
    metadata: { user_id: "placeholder" },
    thinking: { type: "enabled", budget_tokens: 31999 },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    messages: [
      { role: "user", content: [{ type: "text", text: "placeholder prompt" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: TOOL_NAME, input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "placeholder" },
          { type: "text", text: "placeholder follow-up" },
        ],
      },
    ],
  };
}

function messagesOf(body: JSONObject): JSONObject[] {
  return body.messages as JSONObject[];
}

describe("checkLearnerRequest", () => {
  it("encodes the rules of the model the learner defaults to", () => {
    // The checks are Haiku 4.5's acceptance rules; a new default model needs new rules.
    expect(DEFAULT_LEARNER_MODEL).toBe("claude-haiku-4-5");
  });

  it("accepts the Haiku-shaped request", () => {
    expect(checkLearnerRequest(haikuRequest())).toEqual([]);
  });

  it("accepts string content, disabled thinking, and no thinking", () => {
    const body = haikuRequest();
    messagesOf(body)[0].content = "placeholder prompt";
    body.thinking = { type: "disabled" };
    expect(checkLearnerRequest(body)).toEqual([]);
    delete body.thinking;
    expect(checkLearnerRequest(body)).toEqual([]);
  });

  it("accepts a non-effort output_config", () => {
    const body = { ...haikuRequest(), output_config: { format: { type: "json_schema" } } };
    expect(checkLearnerRequest(body)).toEqual([]);
  });

  it("rejects a non-object body", () => {
    expect(checkLearnerRequest(undefined)).toEqual(["body is not a JSON object"]);
    expect(checkLearnerRequest([])).toEqual(["body is not a JSON object"]);
  });

  it("flags a model other than the pinned one", () => {
    const body = { ...haikuRequest(), model: "claude-opus-5-5" };
    expect(checkLearnerRequest(body)).toEqual([
      `model is "claude-opus-5-5", expected "${DEFAULT_LEARNER_MODEL}"`,
    ]);
    expect(checkLearnerRequest(body, "claude-opus-5-5")).toEqual([]);
  });

  it("flags unknown top-level keys", () => {
    const body = { ...haikuRequest(), speed: "fast" };
    expect(checkLearnerRequest(body)).toEqual(['unexpected top-level key "speed"']);
  });

  it("flags system-role messages and extra message keys", () => {
    const body = haikuRequest();
    messagesOf(body).splice(1, 0, {
      role: "system",
      content: "placeholder",
      output_config: { effort: "medium" },
    });
    expect(checkLearnerRequest(body)).toEqual([
      'messages[1].role is "system"',
      'messages[1] has unexpected key "output_config"',
    ]);
  });

  it("flags non-object messages and a non-array messages field", () => {
    const body = haikuRequest();
    messagesOf(body).push("placeholder" as unknown as JSONObject);
    expect(checkLearnerRequest(body)).toEqual(["messages[3] is not an object"]);
    expect(checkLearnerRequest({ ...haikuRequest(), messages: {} })).toEqual([
      "messages is not an array",
    ]);
  });

  it("flags adaptive thinking", () => {
    const body = { ...haikuRequest(), thinking: { type: "adaptive" } };
    expect(checkLearnerRequest(body)).toEqual(['thinking.type is "adaptive"']);
  });

  it("flags malformed thinking", () => {
    expect(checkLearnerRequest({ ...haikuRequest(), thinking: "enabled" })).toEqual([
      "thinking is not an object",
    ]);
    expect(checkLearnerRequest({ ...haikuRequest(), thinking: { type: "enabled" } })).toEqual([
      "thinking.budget_tokens is not an integer",
    ]);
  });

  it("flags thinking budgets outside [1024, max_tokens)", () => {
    const low = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 1023 } };
    expect(checkLearnerRequest(low)).toEqual(["thinking.budget_tokens 1023 is below 1024"]);
    const high = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 32000 } };
    expect(checkLearnerRequest(high)).toEqual([
      "thinking.budget_tokens 32000 is not below max_tokens 32000",
    ]);
    const floor = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 1024 } };
    expect(checkLearnerRequest(floor)).toEqual([]);
  });

  it("flags output_config.effort", () => {
    const body = { ...haikuRequest(), output_config: { effort: "medium" } };
    expect(checkLearnerRequest(body)).toEqual(["output_config.effort is set"]);
  });

  it("flags missing or oversized max_tokens", () => {
    const body = haikuRequest();
    delete body.max_tokens;
    expect(checkLearnerRequest(body)).toEqual(["max_tokens is missing"]);
    const big = { ...haikuRequest(), max_tokens: 64001 };
    expect(checkLearnerRequest(big)).toEqual(["max_tokens 64001 exceeds 64000"]);
  });

  it("flags tool_result blocks that are not leading", () => {
    const body = haikuRequest();
    const last = messagesOf(body)[2];
    last.content = [...(last.content as unknown[])].reverse();
    expect(checkLearnerRequest(body)).toEqual([
      "messages[2] has a tool_result after non-tool_result content",
    ]);
  });

  it("flags a tool_result with no earlier tool_use", () => {
    const body = haikuRequest();
    const last = messagesOf(body)[2];
    (last.content as JSONObject[])[0].tool_use_id = "toolu_missing";
    expect(checkLearnerRequest(body)).toEqual([
      "messages[2] has a tool_result with no earlier tool_use",
    ]);
  });

  it("reports every violation of the unpinned Opus shape", () => {
    const body = {
      ...haikuRequest(),
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    };
    messagesOf(body).push({ role: "system", content: "placeholder" });
    expect(checkLearnerRequest(body)).toHaveLength(4);
  });
});

function hasToolResult(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.messages)) return false;
  return body.messages.some(
    (m) => isObject(m) && contentBlocks(m).some((b) => b.type === "tool_result"),
  );
}

/** Stream a tool call on the first turn, then end the turn once a tool_result is back. */
function streamReply(res: ServerResponse, body: unknown, n: number): void {
  const [block, delta, stopReason] = hasToolResult(body)
    ? [{ type: "text", text: "" }, { type: "text_delta", text: "done" }, "end_turn"]
    : [
        { type: "tool_use", id: `toolu_${n}`, name: TOOL_NAME, input: {} },
        { type: "input_json_delta", partial_json: '{"text":"ping"}' },
        "tool_use",
      ];
  const message = {
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    model: isObject(body) ? body.model : undefined,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const events: [string, JSONObject][] = [
    ["message_start", { message }],
    ["content_block_start", { index: 0, content_block: block }],
    ["content_block_delta", { index: 0, delta }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }],
    ["message_stop", {}],
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  res.end();
}

/** An Anthropic-shaped gateway stub that records every `/v1/messages` body. */
async function startGatewayStub() {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0];
      if (route === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":10}');
        return;
      }
      if (route !== "/v1/messages") {
        res.writeHead(404);
        res.end();
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      bodies.push(body);
      streamReply(res, body, bodies.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testExecutable(): ClaudeExecutable {
  const override = process.env.DOSU_TEST_CLAUDE_BIN;
  return override ? { kind: "system", path: override } : resolveClaudeExecutable();
}

const executable = testExecutable();

describe("study run request shape against real Claude Code", () => {
  it.skipIf(executable.kind === "missing")(
    "only sends requests the served model accepts",
    async () => {
      const stub = await startGatewayStub();
      const configDir = mkdtempSync(join(tmpdir(), "dosu-learner-shape-"));
      const abort = new AbortController();
      try {
        const env = buildLearnerEnv({
          apiKey: "sk_user_shape_test",
          gatewayURL: stub.url,
          configDir,
          runID: "request-shape-test",
          trigger: "manual",
          cliVersion: "test",
          model: DEFAULT_LEARNER_MODEL,
        });
        const shape = createSdkMcpServer({
          name: "shape",
          version: "1.0.0",
          tools: [
            tool("echo", "Echo text back", { text: z.string() }, async (args) => ({
              content: [{ type: "text", text: args.text }],
            })),
          ],
        });
        const run = query({
          prompt: "Call the echo tool once, then say done.",
          options: {
            systemPrompt: "You are a request-shape test agent.",
            env: env as Record<string, string>,
            abortController: abort,
            model: DEFAULT_LEARNER_MODEL,
            maxTurns: 4,
            settingSources: [],
            persistSession: false,
            ...(executable.kind === "system"
              ? { pathToClaudeCodeExecutable: executable.path }
              : {}),
            mcpServers: { shape },
            canUseTool: async (toolName, input) =>
              toolName === TOOL_NAME
                ? { behavior: "allow", updatedInput: input }
                : { behavior: "deny", message: `Tool ${toolName} is not permitted.` },
          },
        });
        let result: { subtype: string; isError: boolean } | undefined;
        for await (const message of run) {
          if (message.type === "result") {
            result = { subtype: message.subtype, isError: message.is_error };
          }
        }

        expect(result).toEqual({ subtype: "success", isError: false });
        // Two requests at least: the tool call and the turn after its result.
        expect(stub.bodies.length).toBeGreaterThanOrEqual(2);
        const violations = stub.bodies.map((body) => checkLearnerRequest(body));
        expect(violations).toEqual(stub.bodies.map(() => []));
      } finally {
        abort.abort();
        await stub.close();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
