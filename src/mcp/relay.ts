/** The HTTP half of `dosu mcp serve`: relays JSON-RPC messages to Dosu's streamable-HTTP MCP
 * endpoint, adding the API key and the session scope the server cannot know by itself (project,
 * branch, client), and hands back every JSON-RPC message the server answers with.
 *
 * Transparent on purpose: it does not interpret methods, so tools, resources, and MCP Apps work
 * exactly as against the server directly. What it owns is the transport -- JSON and SSE replies,
 * `Mcp-Session-Id` and the negotiated protocol version, and turning anything that goes wrong on
 * the wire (HTTP errors, timeouts, an unreachable server) into a JSON-RPC error for the request,
 * so the agent sees a failed call instead of a hung one. `dosu memory` calls tools through the
 * same relay, so both send identical headers. */

/** Implementation-defined JSON-RPC server error, for failures of the transport itself. */
const TRANSPORT_ERROR = -32000;

/** Long enough for a cold memory search; past this the agent is better off with an error. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** How long `close` waits for the server to forget a session. */
const CLOSE_TIMEOUT_MS = 2_000;

/** How much of an error body is quoted back to the agent. */
const ERROR_BODY_CHARS = 300;

export interface McpRelayOptions {
  /** The MCP endpoint URL, deployment included. */
  endpoint: string;
  apiKey: string;
  /** x-dosu-client: the agent the proxy serves (`claude-code`, `codex`, ...). */
  client?: string;
  /** x-dosu-project (and x-dosu-repo, the same value for older servers); null sends neither. */
  project: string | null;
  /** x-dosu-branch, re-read for every request: the agent may switch branches mid-session. */
  branch: () => string | null;
  timeoutMs?: number;
}

export interface McpRelay {
  /** POST one JSON-RPC message (or batch) and pass every message the server sends back to
   * `emit`, ending with exactly one answer per request it carried. Never throws. */
  send(message: unknown, emit: (message: unknown) => void): Promise<void>;
  /** Ends the server-side session, when the server opened one. Never throws. */
  close(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The messages a POST body carries: one, or a batch. */
function messagesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/** Ids of the requests (not notifications or responses) in a message or batch. */
function requestIds(message: unknown): RequestId[] {
  return messagesOf(message).flatMap((m) =>
    isObject(m) &&
    typeof m.method === "string" &&
    (typeof m.id === "string" || typeof m.id === "number")
      ? [m.id]
      : [],
  );
}

/** Ids of the responses in a message or batch the server sent. */
function responseIds(message: unknown): RequestId[] {
  return messagesOf(message).flatMap((m) =>
    isObject(m) &&
    (typeof m.id === "string" || typeof m.id === "number") &&
    ("result" in m || "error" in m)
      ? [m.id]
      : [],
  );
}

function transportError(id: RequestId, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code: TRANSPORT_ERROR, message } };
}

/** What an error body says, in a line: a JSON-RPC error's message, an OAuth or FastAPI error
 * description, or the start of the text. */
function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isObject(parsed)) {
      const { error, error_description, detail } = parsed;
      if (isObject(error) && typeof error.message === "string") return error.message;
      if (typeof error_description === "string") return error_description;
      if (typeof detail === "string") return detail;
      if (typeof error === "string") return error;
    }
  } catch {
    // Not JSON; quote the text.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_CHARS);
}

/** A JSON-RPC error response the server put in an error body, answering one of `ids`. */
function jsonRpcErrorBody(body: string, ids: RequestId[]): JsonObject | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isObject(parsed) && isObject(parsed.error) && ids.includes(parsed.id as RequestId)) {
      return parsed;
    }
  } catch {
    // Not a JSON-RPC body.
  }
  return null;
}

function httpErrorMessage(status: number, body: string): string {
  const detail = errorDetail(body);
  const hint =
    status === 401 || status === 403
      ? " Check the Dosu API key: run 'dosu setup' (or 'dosu login') again."
      : "";
  return `Dosu MCP server returned HTTP ${status}${detail ? `: ${detail}` : ""}.${hint}`;
}

/** Calls `onData` with each SSE event's data, as the stream arrives. Only `message` events (the
 * default type) carry JSON-RPC; comments, ids, and retry hints are skipped. */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  const dispatch = () => {
    if (data.length > 0 && (event === "" || event === "message")) onData(data.join("\n"));
    data = [];
    event = "";
  };
  const consume = (line: string) => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    // A trailing \r may be half of a \r\n split across chunks; keep it until the next one.
    const lines = buffer.split(done ? /\r\n|\n|\r/ : /\r\n|\n|\r(?!$)/);
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) consume(line);
    if (done) break;
  }
  dispatch();
}

/** RFC 8187's charset marker: what follows is percent-encoded UTF-8. */
const UTF8_MARKER = "UTF-8''";

/** A scope value as a header can carry it. Header values are bytes, and fetch refuses (or
 * mangles) anything past ASCII, which a linked project key, a checkout path, or a branch name
 * may hold; those go as an RFC 8187 ext-value the server decodes. Plain ASCII goes as is. */
function scopeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.startsWith(UTF8_MARKER)) return value;
  const encoded = encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${UTF8_MARKER}${encoded}`;
}

function describeFetchError(err: unknown, endpoint: string, timeoutMs: number): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `Dosu MCP request timed out after ${Math.round(timeoutMs / 1000)}s.`;
  }
  const reason = err instanceof Error ? err.message : String(err);
  return `Could not reach the Dosu MCP server at ${new URL(endpoint).origin} (${reason}).`;
}

export function createMcpRelay(options: McpRelayOptions): McpRelay {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;

  function headers(): Record<string, string> {
    const out: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Dosu-API-Key": options.apiKey,
    };
    if (options.project) {
      out["x-dosu-project"] = scopeHeader(options.project);
      out["x-dosu-repo"] = out["x-dosu-project"];
    }
    const branch = options.branch();
    if (branch) out["x-dosu-branch"] = scopeHeader(branch);
    if (options.client) out["x-dosu-client"] = scopeHeader(options.client);
    if (sessionId) out["Mcp-Session-Id"] = sessionId;
    if (protocolVersion) out["MCP-Protocol-Version"] = protocolVersion;
    return out;
  }

  /** Remembers what the initialize reply negotiated, for the requests after it. */
  function noteInitialized(sent: unknown, reply: unknown): void {
    const initializeIds = messagesOf(sent).flatMap((m) =>
      isObject(m) && m.method === "initialize" ? [m.id] : [],
    );
    for (const m of messagesOf(reply)) {
      if (!isObject(m) || !initializeIds.includes(m.id) || !isObject(m.result)) continue;
      if (typeof m.result.protocolVersion === "string") protocolVersion = m.result.protocolVersion;
    }
  }

  async function send(message: unknown, emit: (message: unknown) => void): Promise<void> {
    const pending = new Set(requestIds(message));
    const deliver = (reply: unknown) => {
      for (const id of responseIds(reply)) pending.delete(id);
      noteInitialized(message, reply);
      emit(reply);
    };
    const failPending = (reason: string) => {
      for (const id of pending) emit(transportError(id, reason));
      pending.clear();
    };

    const sentWithSession = sessionId !== null;
    let response: Response;
    try {
      response = await fetch(options.endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return failPending(describeFetchError(err, options.endpoint, timeoutMs));
    }

    const session = response.headers.get("mcp-session-id");
    if (session) sessionId = session;

    try {
      if (!response.ok) {
        // A stateful server that restarted forgets its sessions; the next request starts over.
        if (response.status === 404 && sentWithSession) sessionId = null;
        const body = await response.text();
        const jsonRpcError = jsonRpcErrorBody(body, [...pending]);
        if (jsonRpcError) deliver(jsonRpcError);
        return failPending(httpErrorMessage(response.status, body));
      }
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && response.body) {
        await readEventStream(response.body, (data) => {
          try {
            deliver(JSON.parse(data));
          } catch {
            // An event that is not JSON-RPC is not ours to forward.
          }
        });
      } else {
        const text = await response.text();
        if (text.trim()) deliver(JSON.parse(text));
      }
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        return failPending(describeFetchError(err, options.endpoint, timeoutMs));
      }
      // Unparseable body: falls through to the answer below.
    }
    failPending("The Dosu MCP server ended the exchange without a response.");
  }

  async function close(): Promise<void> {
    if (!sessionId) return;
    try {
      const response = await fetch(options.endpoint, {
        method: "DELETE",
        headers: headers(),
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      // The server forgets idle sessions on its own.
    }
    sessionId = null;
  }

  return { send, close };
}
