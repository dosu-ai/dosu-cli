/** `dosu mcp serve`: the local stdio MCP server every agent's Dosu entry runs. It relays the
 * agent's JSON-RPC to Dosu's MCP endpoint (relay.ts) and adds what only the local side knows:
 * the API key, and the scope of the session -- the project key of the directory the agent started
 * it in (resolved once, by the same rules transcripts ship under), the branch checked out right
 * now, and which agent it is. `dosu memory search|evidence` call the memory tools through the
 * same relay, so a person or a Pi extension gets exactly what the agent would.
 *
 * stdout carries the protocol and nothing else: one JSON-RPC message per line. Diagnostics go to
 * stderr and the debug log. */

import { StringDecoder } from "node:string_decoder";
import { loadConfig, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import { logger } from "../debug/logger";
import { type GitBudget, resolveProjectOfDir } from "../sessions/project";
import { currentBranchOfDir } from "../sessions/repo";
import { VERSION } from "../version/version";
import { mcpEndpoint } from "./config-helpers";
import { createMcpRelay, type McpRelay } from "./relay";

/** The agent waits for the server to start (Codex gives up after 10s by default), so the project
 * lookup gets less time than a background sync; a repository too slow for it sends no project. */
const STARTUP_GIT_BUDGET: GitBudget = { lookup: 1_000, history: 5_000 };

/** What `dosu memory` asks for; the server answers with the version it speaks. */
const CLIENT_PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

/** Dosu is not set up enough to reach its MCP endpoint; the message says what to run. */
class McpSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSetupError";
  }
}

export interface ProxyOptions {
  /** x-dosu-client: the agent being served. */
  client?: string;
  /** The directory whose project and branch scope the session; defaults to the cwd. */
  cwd?: string;
  timeoutMs?: number;
}

/** A relay to the configured Dosu MCP endpoint, scoped to `cwd`. Throws McpSetupError when
 * there is no API key or deployment to reach it with. */
export function proxyRelay(options: ProxyOptions = {}): McpRelay {
  const cfg = loadConfig();
  const apiKey = cfg.active_account?.target?.api_key;
  if (!apiKey) throw new McpSetupError("Dosu is not set up: run 'dosu setup' first.");
  if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id) {
    throw new McpSetupError("No Dosu deployment selected: run 'dosu setup' first.");
  }
  if (!isAbsoluteHttpUrl(getBackendURL())) {
    throw new McpSetupError("No Dosu backend URL is configured for this build.");
  }
  const cwd = options.cwd ?? process.cwd();
  const project = resolveProjectOfDir(cwd, { budget: STARTUP_GIT_BUDGET });
  logger.info(
    "mcp-proxy",
    `client=${options.client ?? "-"} project=${project?.project ?? "-"} (${project?.rule ?? "git timed out"})`,
  );
  return createMcpRelay({
    endpoint: mcpEndpoint(cfg),
    apiKey,
    client: options.client,
    project: project?.project ?? null,
    branch: () => currentBranchOfDir(cwd),
    timeoutMs: options.timeoutMs,
  });
}

/** Relays newline-delimited JSON-RPC from `input` until it ends, writing each reply line with
 * `write`. Requests run concurrently, as MCP allows; on end it waits for the ones in flight, then
 * ends the session. */
async function serveStdio(
  relay: McpRelay,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const emit = (message: unknown) => write(`${JSON.stringify(message)}\n`);
  const inflight = new Set<Promise<void>>();
  const handle = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      emit(PARSE_ERROR);
      return;
    }
    const exchange: Promise<void> = relay.send(message, emit).finally(() => {
      inflight.delete(exchange);
    });
    inflight.add(exchange);
  };

  await new Promise<void>((resolve) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    input.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
        handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    const finish = () => {
      handle(buffer + decoder.end());
      buffer = "";
      resolve();
    };
    input.on("end", finish);
    input.on("error", finish);
  });
  await Promise.allSettled([...inflight]);
  await relay.close();
}

/** `dosu mcp serve`: the exit code. */
export async function runMcpServe(options: ProxyOptions): Promise<number> {
  // Nothing but protocol may reach stdout; anything else that logs goes to stderr.
  const { log, info, debug } = console;
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  try {
    let relay: McpRelay;
    try {
      relay = proxyRelay(options);
    } catch (err) {
      process.stderr.write(`dosu mcp serve: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const stdout = process.stdout;
    // The agent closing its end mid-reply is a normal way for the session to stop.
    stdout.on("error", () => process.exit(0));
    await serveStdio(relay, process.stdin, (line) => {
      stdout.write(line);
    });
    return 0;
  } finally {
    Object.assign(console, { log, info, debug });
  }
}

export interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** One request over the relay; its result, or the JSON-RPC error as an Error. */
async function request(
  relay: McpRelay,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  let reply: { error?: { message?: unknown }; result?: unknown } | undefined;
  await relay.send({ jsonrpc: "2.0", id, method, params }, (message) => {
    if ((message as { id?: unknown } | null)?.id === id) reply = message as typeof reply;
  });
  if (reply?.error) {
    const text = reply.error.message;
    throw new Error(typeof text === "string" ? text : "Dosu MCP request failed.");
  }
  return reply?.result;
}

/** Calls one tool as an MCP client would: initialize, initialized, tools/call. */
export async function callMcpTool(
  relay: McpRelay,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await request(relay, 1, "initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dosu-cli", version: VERSION },
    });
    await relay.send({ jsonrpc: "2.0", method: "notifications/initialized" }, () => {});
    const result = await request(relay, 2, "tools/call", { name, arguments: args });
    return (result ?? {}) as ToolResult;
  } finally {
    await relay.close();
  }
}

/** The text a tool result carries, its text blocks joined. */
export function toolText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}
