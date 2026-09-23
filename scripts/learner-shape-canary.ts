/**
 * Learner request-shape canary: runs a pinned learner-style study against a REAL Claude Code
 * binary and a local Anthropic-shaped stub, then checks every `/v1/messages` request against
 * what the gateway's served model (Haiku 4.5) accepts. Claude Code auto-updates on users'
 * machines, so a new request shape must be caught here before it reaches them.
 *
 *   bun run canary:learner-shape                    # exit 0 when every request is accepted
 *   CANARY_UNPINNED=1 bun run canary:learner-shape  # drops the pin; must exit 1
 *   CLAUDE_BIN=/path/to/claude ...                  # default: `claude` on PATH, ~/.local/bin
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { buildLearnerEnv } from "../src/learner/env";

export const PINNED_MODEL = "claude-haiku-4-5";

/** Haiku 4.5's output ceiling. */
const MAX_OUTPUT_TOKENS = 64_000;
const MIN_THINKING_BUDGET = 1024;
const RUN_TIMEOUT_MS = 180_000;
const TOOL_NAME = "mcp__canary__echo";

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
    const blocks = contentBlocks(message);
    let pastToolResults = false;
    for (const block of blocks) {
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

/** Violations that would make the served model reject (or that are new and unvetted) in one
 * `/v1/messages` request body. Messages only name locations and keys, never prompt text. */
export function checkLearnerRequest(body: unknown, model: string = PINNED_MODEL): string[] {
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

interface CapturedRequest {
  path: string;
  beta: string;
  userAgent: string;
  body: unknown;
}

function hasToolResult(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.messages)) return false;
  return body.messages.some(
    (m) => isObject(m) && contentBlocks(m).some((b) => b.type === "tool_result"),
  );
}

function writeSSE(res: ServerResponse, events: [string, JSONObject][]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  res.end();
}

/** Stream a canary tool call on the first turn, then end the turn once a tool_result is back. */
function answerMessages(res: ServerResponse, body: unknown, n: number): void {
  const model = isObject(body) ? body.model : undefined;
  const usage = { input_tokens: 10, output_tokens: 5 };
  const start: [string, JSONObject] = [
    "message_start",
    {
      message: {
        id: `msg_${n}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        usage,
      },
    },
  ];
  const [block, delta, stopReason] = hasToolResult(body)
    ? [{ type: "text", text: "" }, { type: "text_delta", text: "done" }, "end_turn"]
    : [
        { type: "tool_use", id: `toolu_${n}`, name: TOOL_NAME, input: {} },
        { type: "input_json_delta", partial_json: '{"text":"ping"}' },
        "tool_use",
      ];
  writeSSE(res, [
    start,
    ["content_block_start", { index: 0, content_block: block }],
    ["content_block_delta", { index: 0, delta }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } }],
    ["message_stop", {}],
  ]);
}

async function startStub() {
  const requests: CapturedRequest[] = [];
  const unexpectedPaths: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const path = req.url ?? "";
      const route = path.split("?")[0];
      if (route === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"input_tokens":10}');
        return;
      }
      if (route !== "/v1/messages") {
        unexpectedPaths.push(`${req.method} ${route}`);
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
      requests.push({
        path,
        beta: String(req.headers["anthropic-beta"] ?? ""),
        userAgent: String(req.headers["user-agent"] ?? ""),
        body,
      });
      answerMessages(res, body, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unexpectedPaths,
    close: () => server.close(),
  };
}

function resolveClaudeBin(): string | undefined {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "claude"));
  candidates.push(join(homedir(), ".local", "bin", "claude"));
  return candidates.find((candidate) => existsSync(candidate));
}

async function runStudy(env: NodeJS.ProcessEnv, claudeBin: string, pinned: boolean) {
  const canary = createSdkMcpServer({
    name: "canary",
    version: "1.0.0",
    tools: [
      tool("echo", "Echo text back", { text: z.string() }, async (args) => ({
        content: [{ type: "text", text: args.text }],
      })),
    ],
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RUN_TIMEOUT_MS);
  let result: { subtype: string; isError: boolean } | undefined;
  try {
    const run = query({
      prompt: "Call the echo tool once, then say done.",
      options: {
        systemPrompt: "You are a canary study agent.",
        env: env as Record<string, string>,
        abortController: abort,
        maxTurns: 4,
        ...(pinned ? { model: PINNED_MODEL } : {}),
        settingSources: [],
        persistSession: false,
        pathToClaudeCodeExecutable: claudeBin,
        mcpServers: { canary },
        canUseTool: async (toolName, input) =>
          toolName === TOOL_NAME
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: `Tool ${toolName} is not permitted.` },
      },
    });
    for await (const message of run) {
      if (message.type === "result") {
        result = { subtype: message.subtype, isError: message.is_error };
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return result;
}

async function main(): Promise<number> {
  const claudeBin = resolveClaudeBin();
  if (!claudeBin) {
    console.error("No Claude Code binary found (set CLAUDE_BIN or put `claude` on PATH).");
    return 1;
  }
  const version = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  console.log(`claude: ${claudeBin}`);
  console.log(`claude --version: ${version.stdout.trim() || "(unknown)"}`);

  const pinned = process.env.CANARY_UNPINNED !== "1";
  console.log(`mode: ${pinned ? `pinned (${PINNED_MODEL})` : "UNPINNED (expected to fail)"}`);

  const stub = await startStub();
  const configDir = mkdtempSync(join(tmpdir(), "dosu-learner-canary-"));
  const failures: string[] = [];
  try {
    const env = buildLearnerEnv({
      apiKey: "sk_user_canary",
      gatewayURL: stub.url,
      configDir,
      runID: "learner-shape-canary",
      trigger: "manual",
      cliVersion: "canary",
      model: PINNED_MODEL,
    });
    if (pinned && env.ANTHROPIC_MODEL !== PINNED_MODEL) {
      failures.push(`buildLearnerEnv did not pin ANTHROPIC_MODEL to ${PINNED_MODEL}`);
    }
    if (!pinned) delete env.ANTHROPIC_MODEL;

    let result: Awaited<ReturnType<typeof runStudy>>;
    try {
      result = await runStudy(env, claudeBin, pinned);
    } catch (error) {
      failures.push(`SDK run threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(
      `SDK result: ${result ? `${result.subtype}${result.isError ? " (error)" : ""}` : "none"}`,
    );
    if (result?.subtype !== "success" || result.isError) {
      failures.push("SDK run did not finish with a successful result");
    }
  } finally {
    stub.close();
    rmSync(configDir, { recursive: true, force: true });
  }

  for (const path of stub.unexpectedPaths) console.log(`unhandled request (404): ${path}`);
  if (stub.requests.length < 2) {
    failures.push(
      `expected >= 2 /v1/messages requests (tool round-trip), saw ${stub.requests.length}`,
    );
  }

  let violating = 0;
  stub.requests.forEach((request, i) => {
    const violations = checkLearnerRequest(request.body);
    const model = isObject(request.body) ? request.body.model : undefined;
    console.log(`\n#${i + 1} POST ${request.path} model=${JSON.stringify(model)}`);
    console.log(`   anthropic-beta: ${request.beta || "(none)"}`);
    console.log(`   user-agent: ${request.userAgent || "(none)"}`);
    if (violations.length) violating += 1;
    for (const violation of violations) console.log(`   VIOLATION: ${violation}`);
    if (!violations.length) console.log("   ok");
  });
  if (violating) failures.push(`${violating} of ${stub.requests.length} requests have violations`);

  if (failures.length) {
    console.log("\nFAIL");
    for (const failure of failures) console.log(`  - ${failure}`);
    return 1;
  }
  console.log(`\nPASS: ${stub.requests.length} requests, all accepted by ${PINNED_MODEL}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
