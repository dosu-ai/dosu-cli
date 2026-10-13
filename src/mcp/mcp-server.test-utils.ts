/** A local streamable-HTTP MCP server standing in for Dosu's /v2/mcp in tests: the far side of a
 * process boundary, so the proxy and memory commands run their real HTTP code against it. It
 * answers the way FastMCP's stateless server does (SSE by default, 202 for notifications) and
 * echoes the x-dosu-* headers in its tool results. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are arbitrary JSON
  body: any;
}

export interface FakeMcpServerOptions {
  /** How request responses are framed: SSE (FastMCP's default) or one JSON body. */
  mode?: "sse" | "json";
  /** Set on the initialize response, as a stateful server does. */
  sessionId?: string;
  /** Takes over a request before the default handling; return true when it answered. */
  // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are arbitrary JSON
  intercept?: (body: any, res: ServerResponse, req: IncomingMessage) => boolean;
}

export interface FakeMcpServer {
  /** The backend base URL (what DOSU_BACKEND_URL_OVERRIDE points at). */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : (value ?? "-");
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are arbitrary JSON
function answer(message: any, req: IncomingMessage): unknown {
  const { id, method, params } = message;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-dosu", version: "1" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "search_memory", inputSchema: { type: "object" } },
          { name: "get_memory_evidence", inputSchema: { type: "object" } },
        ],
      },
    };
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const scope =
      `project=${header(req, "x-dosu-project")} repo=${header(req, "x-dosu-repo")} ` +
      `branch=${header(req, "x-dosu-branch")} client=${header(req, "x-dosu-client")}`;
    if (name === "search_memory") {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `memories for "${args.query}" (${scope})` }] },
      };
    }
    if (name === "get_memory_evidence") {
      const missing = args.memory_id === "missing";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: missing ? "no such memory" : `evidence ${args.memory_id}` },
          ],
          ...(missing ? { isError: true } : {}),
        },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export async function startFakeMcpServer(
  options: FakeMcpServerOptions = {},
): Promise<FakeMcpServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (options.intercept?.(body, res, req)) return;
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      const messages = Array.isArray(body) ? body : [body];
      // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are arbitrary JSON
      const requestsIn = messages.filter((m: any) => m?.method && m.id !== undefined);
      if (requestsIn.length === 0) {
        res.writeHead(202).end();
        return;
      }
      const replies = requestsIn.map((m) => answer(m, req));
      const headers: Record<string, string> = {};
      // biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are arbitrary JSON
      if (options.sessionId && requestsIn.some((m: any) => m.method === "initialize")) {
        headers["mcp-session-id"] = options.sessionId;
      }
      if ((options.mode ?? "sse") === "json") {
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
      for (const reply of replies) res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
