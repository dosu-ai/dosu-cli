/** `dosu mcp serve`: the local stdio MCP server every agent's Dosu entry runs. It relays the
 * agent's JSON-RPC to Dosu's MCP endpoint (relay.ts) and adds what only the local side knows:
 * the API key, and the scope of the session -- the project key of the directory the agent started
 * it in (resolved once, by the same rules transcripts ship under; or, when that directory has no
 * project of its own, of the workspace root the agent names), the branch checked out right now,
 * and which agent it is. `dosu memory search|evidence` call the memory tools through the
 * same relay, so a person or a Pi extension gets exactly what the agent would.
 *
 * stdout carries the protocol and nothing else: one JSON-RPC message per line. Diagnostics go to
 * stderr and the debug log. */

import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { loadConfig, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import { logger } from "../debug/logger";
import { type GitBudget, resolveProjectOfDir } from "../sessions/project";
import { currentBranchOfDir } from "../sessions/repo";
import { VERSION } from "../version/version";
import { callSessionIsIncognito, OFF_THE_RECORD_MESSAGE, takeCallSession } from "./call-session";
import { mcpEndpoint } from "./config-helpers";
import { createMcpRelay, type McpRelay } from "./relay";

/** The agent waits for the server to start (Codex gives up after 10s by default), so the project
 * lookup gets less time than a background sync; a repository too slow for it sends no project. */
const STARTUP_GIT_BUDGET: GitBudget = { lookup: 1_000, history: 5_000 };

/** How long a session started outside any project waits for the agent to name its workspace
 * roots before it goes on scoped by the directory it was started in. */
const ROOTS_TIMEOUT_MS = 2_000;

/** The id of the proxy's own roots/list request to the agent, whose answer it keeps. */
const ROOTS_REQUEST_ID = "dosu-proxy-roots";

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

/** A relay with the session scope it sends. */
interface ProxySession {
  relay: McpRelay;
  /** x-dosu-client: the agent being served. */
  client?: string;
  /** The directory it started in has no project of its own (no link, DOSU_PROJECT, or
   * checkout), as when a GUI host starts a global server in / or the home directory. */
  unscoped: boolean;
  /** Scopes later requests by `dir`, a workspace root the agent named. */
  rescope(dir: string): void;
}

/** A session with the configured Dosu MCP endpoint, scoped to `cwd`. Throws McpSetupError when
 * there is no API key or deployment to reach it with. */
function openSession(options: ProxyOptions): ProxySession {
  const cfg = loadConfig();
  const apiKey = cfg.active_account?.target?.api_key;
  if (!apiKey) throw new McpSetupError("Dosu is not set up: run 'dosu setup' first.");
  if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id) {
    throw new McpSetupError("No Dosu deployment selected: run 'dosu setup' first.");
  }
  if (!isAbsoluteHttpUrl(getBackendURL())) {
    throw new McpSetupError("No Dosu backend URL is configured for this build.");
  }
  const client = options.client ?? "-";
  let dir = options.cwd ?? process.cwd();
  const started = resolveProjectOfDir(dir, { budget: STARTUP_GIT_BUDGET });
  let project = started?.project ?? null;
  logger.info(
    "mcp-proxy",
    `client=${client} project=${project ?? "-"} (${started?.rule ?? "git timed out"})`,
  );
  const relay = createMcpRelay({
    endpoint: mcpEndpoint(cfg),
    apiKey,
    client: options.client,
    project: () => project,
    branch: () => currentBranchOfDir(dir),
    timeoutMs: options.timeoutMs,
  });
  return {
    relay,
    client: options.client,
    unscoped: started?.rule === "path",
    rescope(root: string) {
      const named = resolveProjectOfDir(root, { budget: STARTUP_GIT_BUDGET });
      if (!named) return;
      dir = root;
      project = named.project;
      logger.info("mcp-proxy", `client=${client} root=${root} project=${project} (${named.rule})`);
    },
  };
}

/** A relay to the configured Dosu MCP endpoint, scoped to `cwd`. Throws McpSetupError when
 * there is no API key or deployment to reach it with. */
export function proxyRelay(options: ProxyOptions = {}): McpRelay {
  return openSession(options).relay;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The local directory of the first `file:` root in a roots/list answer, if any. */
function firstRootDir(answer: Record<string, unknown>): string | null {
  const roots = isObject(answer.result) ? answer.result.roots : undefined;
  for (const root of Array.isArray(roots) ? roots : []) {
    if (!isObject(root) || typeof root.uri !== "string" || !root.uri.startsWith("file:")) continue;
    try {
      return fileURLToPath(root.uri);
    } catch {
      // Not a local path; try the next one.
    }
  }
  return null;
}

/** Relays newline-delimited JSON-RPC from `input` until it ends, writing each reply line with
 * `write`. Requests run concurrently, as MCP allows; on end it waits for the ones in flight, then
 * ends the session.
 *
 * A session started outside any project asks an agent that offers roots for them once it is
 * initialized, and holds what the agent sends next until the answer (or ROOTS_TIMEOUT_MS), so
 * its first tool call already carries the workspace's project. */
async function serveStdio(
  session: ProxySession,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const { relay } = session;
  const emit = (message: unknown) => write(`${JSON.stringify(message)}\n`);
  const inflight = new Set<Promise<void>>();
  let agentOffersRoots = false;
  let scoped: Promise<void> = Promise.resolve();
  let takeRoots: ((answer: Record<string, unknown>) => void) | null = null;

  const askForRoots = () => {
    scoped = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        takeRoots = null;
        resolve();
      }, ROOTS_TIMEOUT_MS);
      takeRoots = (answer) => {
        clearTimeout(timer);
        takeRoots = null;
        const dir = firstRootDir(answer);
        if (dir) session.rescope(dir);
        resolve();
      };
    });
    emit({ jsonrpc: "2.0", id: ROOTS_REQUEST_ID, method: "roots/list" });
  };

  const handle = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      emit(PARSE_ERROR);
      return;
    }
    const method = isObject(message) ? message.method : undefined;
    if (takeRoots && isObject(message) && message.id === ROOTS_REQUEST_ID && !method) {
      takeRoots(message);
      return;
    }
    if (method === "initialize" && isObject(message)) {
      const params = isObject(message.params) ? message.params : {};
      agentOffersRoots = isObject(params.capabilities) && isObject(params.capabilities.roots);
    }
    // A tool call names the agent session it belongs to; one from a session the user took off
    // the record is answered here and never reaches Dosu, so not even its query is logged.
    const callSession =
      method === "tools/call" && isObject(message) && isObject(message.params)
        ? takeCallSession(message.params, session.client)
        : null;
    if (callSession && callSessionIsIncognito(callSession) && isObject(message)) {
      logger.info(
        "mcp-proxy",
        `${callSession.harness}/${callSession.id} is incognito: call not sent`,
      );
      emit({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: OFF_THE_RECORD_MESSAGE }], isError: true },
      });
      return;
    }
    const exchange: Promise<void> = scoped
      .then(() => relay.send(message, emit, callSession?.id))
      .finally(() => {
        inflight.delete(exchange);
      });
    inflight.add(exchange);
    if (method === "notifications/initialized" && session.unscoped && agentOffersRoots) {
      askForRoots();
    }
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
    let session: ProxySession;
    try {
      session = openSession(options);
    } catch (err) {
      process.stderr.write(`dosu mcp serve: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const stdout = process.stdout;
    // The agent closing its end mid-reply is a normal way for the session to stop.
    stdout.on("error", () => process.exit(0));
    await serveStdio(session, process.stdin, (line) => {
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
  session: string | null = null,
): Promise<unknown> {
  let reply: { error?: { message?: unknown }; result?: unknown } | undefined;
  const message = { jsonrpc: "2.0", id, method, params };
  await relay.send(
    message,
    (answer) => {
      if ((answer as { id?: unknown } | null)?.id === id) reply = answer as typeof reply;
    },
    session,
  );
  if (reply?.error) {
    const text = reply.error.message;
    throw new Error(typeof text === "string" ? text : "Dosu MCP request failed.");
  }
  return reply?.result;
}

/** Calls one tool as an MCP client would: initialize, initialized, tools/call, the call under
 * the agent session `session` when given. */
export async function callMcpTool(
  relay: McpRelay,
  name: string,
  args: Record<string, unknown>,
  session: string | null = null,
): Promise<ToolResult> {
  try {
    await request(relay, 1, "initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "dosu-cli", version: VERSION },
    });
    await relay.send({ jsonrpc: "2.0", method: "notifications/initialized" }, () => {});
    const result = await request(relay, 2, "tools/call", { name, arguments: args }, session);
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
