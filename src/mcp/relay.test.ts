/** The HTTP half of the local MCP proxy, against a real local streamable-HTTP server. */

import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeMcpServer, startFakeMcpServer } from "./mcp-server.test-utils";
import { createMcpRelay, type McpRelayOptions } from "./relay";

let server: FakeMcpServer;

afterEach(async () => {
  await server?.close();
});

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};
const SEARCH = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "search_memory", arguments: { query: "deploy" } },
};

function relayTo(srv: FakeMcpServer, options: Partial<McpRelayOptions> = {}) {
  return createMcpRelay({
    endpoint: `${srv.baseUrl}/v2/mcp/deployments/dep1`,
    apiKey: "sk_test",
    client: "claude-code",
    project: "git:abc",
    branch: () => "main",
    ...options,
  });
}

async function exchange(relay: ReturnType<typeof createMcpRelay>, message: unknown) {
  const out: unknown[] = [];
  await relay.send(message, (m) => out.push(m));
  return out;
}

describe("createMcpRelay", () => {
  it("posts each message with the Dosu headers and relays the SSE reply", async () => {
    server = await startFakeMcpServer();
    const out = await exchange(relayTo(server), SEARCH);

    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: 'memories for "deploy" (project=git:abc repo=git:abc branch=main client=claude-code)',
            },
          ],
        },
      },
    ]);
    const [request] = server.requests;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v2/mcp/deployments/dep1");
    expect(request.body).toEqual(SEARCH);
    expect(request.headers["x-dosu-api-key"]).toBe("sk_test");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.accept).toContain("application/json");
    expect(request.headers.accept).toContain("text/event-stream");
  });

  it("re-reads the branch for every request", async () => {
    server = await startFakeMcpServer();
    const branches = ["main", "feature/x"];
    const relay = relayTo(server, { branch: () => branches.shift() ?? null });

    await exchange(relay, SEARCH);
    await exchange(relay, SEARCH);
    await exchange(relay, SEARCH);

    expect(server.requests.map((r) => r.headers["x-dosu-branch"])).toEqual([
      "main",
      "feature/x",
      undefined,
    ]);
  });

  it("sends no project, branch, or client header it has no value for", async () => {
    server = await startFakeMcpServer();
    await exchange(
      relayTo(server, { project: null, branch: () => null, client: undefined }),
      SEARCH,
    );

    const headers = server.requests[0].headers;
    expect(headers["x-dosu-project"]).toBeUndefined();
    expect(headers["x-dosu-repo"]).toBeUndefined();
    expect(headers["x-dosu-branch"]).toBeUndefined();
    expect(headers["x-dosu-client"]).toBeUndefined();
    expect(headers["x-dosu-api-key"]).toBe("sk_test");
  });

  it("relays a plain JSON reply", async () => {
    server = await startFakeMcpServer({ mode: "json" });
    const out = await exchange(relayTo(server), INITIALIZE);

    expect(out).toEqual([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ protocolVersion: "2025-06-18" }),
      }),
    ]);
  });

  it("relays every event of a stream that arrives in pieces, in order", async () => {
    server = await startFakeMcpServer({
      intercept: (body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        const progress = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: 7, progress: 1 },
        });
        const reply = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: "a\nb" } });
        const pieces = [
          ": keep-alive comment\r\n\r\n",
          `event: message\r\nid: 1\r\ndata: ${progress.slice(0, 20)}`,
          `${progress.slice(20)}\r\n\r\nevent: message\ndata: `,
          `${reply}\n`,
          "\n",
        ];
        let i = 0;
        const next = () => {
          if (i < pieces.length) {
            res.write(pieces[i++]);
            setTimeout(next, 5);
          } else {
            res.end();
          }
        };
        next();
        return true;
      },
    });
    const out = await exchange(relayTo(server), SEARCH);

    expect(out).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 7, progress: 1 },
      },
      { jsonrpc: "2.0", id: 2, result: { ok: "a\nb" } },
    ]);
  });

  it("joins an event's data lines", async () => {
    server = await startFakeMcpServer({
      intercept: (body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: {"jsonrpc":"2.0",\ndata: "id":${body.id},"result":{}}\n\n`);
        return true;
      },
    });
    expect(await exchange(relayTo(server), SEARCH)).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("relays nothing for a notification the server accepts", async () => {
    server = await startFakeMcpServer();
    const out = await exchange(relayTo(server), {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(out).toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("relays a batch and its batched reply", async () => {
    server = await startFakeMcpServer({ mode: "json" });
    const out = await exchange(relayTo(server), [SEARCH, { ...SEARCH, id: 3 }]);

    expect(out).toEqual([[expect.objectContaining({ id: 2 }), expect.objectContaining({ id: 3 })]]);
  });

  it("answers the request with a JSON-RPC error when the server rejects the API key", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token", error_description: "API key revoked" }));
        return true;
      },
    });
    const [reply] = (await exchange(relayTo(server), SEARCH)) as Array<{
      id: number;
      error: { code: number; message: string };
    }>;

    expect(reply.id).toBe(2);
    expect(reply.error.code).toBe(-32000);
    expect(reply.error.message).toContain("HTTP 401");
    expect(reply.error.message).toContain("API key revoked");
    expect(reply.error.message).toContain("dosu setup");
  });

  it("passes a JSON-RPC error body through with its own code", async () => {
    server = await startFakeMcpServer({
      intercept: (body, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad" } }),
        );
        return true;
      },
    });
    expect(await exchange(relayTo(server), SEARCH)).toEqual([
      { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } },
    ]);
  });

  it("answers with an error naming the status for a server failure with a plain body", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html>Bad Gateway</html>");
        return true;
      },
    });
    const [reply] = (await exchange(relayTo(server), SEARCH)) as Array<{
      error: { message: string };
    }>;
    expect(reply.error.message).toContain("HTTP 502");
    expect(reply.error.message).toContain("Bad Gateway");
  });

  it("says nothing on stdout for a failed notification", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(500).end("boom");
        return true;
      },
    });
    const out = await exchange(relayTo(server), { jsonrpc: "2.0", method: "notifications/x" });
    expect(out).toEqual([]);
  });

  it("answers a request the stream never answered", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n');
        return true;
      },
    });
    const out = (await exchange(relayTo(server), SEARCH)) as Array<{
      id?: number;
      error?: { message: string };
    }>;

    expect(out).toHaveLength(2);
    expect(out[1].id).toBe(2);
    expect(out[1].error?.message).toMatch(/without (a )?response/);
  });

  it("answers a request the server accepted without replying", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(202).end();
        return true;
      },
    });
    const [reply] = (await exchange(relayTo(server), SEARCH)) as Array<{
      id: number;
      error: { message: string };
    }>;
    expect(reply.id).toBe(2);
    expect(reply.error.message).toMatch(/without (a )?response/);
  });

  it("times out a request the server never answers", async () => {
    server = await startFakeMcpServer({ intercept: () => true });
    const [reply] = (await exchange(relayTo(server, { timeoutMs: 100 }), SEARCH)) as Array<{
      id: number;
      error: { message: string };
    }>;

    expect(reply.id).toBe(2);
    expect(reply.error.message).toMatch(/timed out/);
  });

  it("times out a stream that stalls after its first event", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
        return true;
      },
    });
    const out = (await exchange(relayTo(server, { timeoutMs: 150 }), SEARCH)) as Array<{
      id?: number;
      error?: { message: string };
    }>;

    expect(out.at(-1)?.id).toBe(2);
    expect(out.at(-1)?.error?.message).toMatch(/timed out/);
  });

  it("answers with an error when the server cannot be reached", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const relay = createMcpRelay({
      endpoint: `http://127.0.0.1:${port}/v2/mcp`,
      apiKey: "k",
      project: null,
      branch: () => null,
    });
    const [reply] = (await exchange(relay, SEARCH)) as Array<{ error: { message: string } }>;
    expect(reply.error.message).toMatch(/could not reach/i);
  });

  it("answers unparseable reply bodies with an error", async () => {
    server = await startFakeMcpServer({
      intercept: (_body, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json");
        return true;
      },
    });
    const [reply] = (await exchange(relayTo(server), SEARCH)) as Array<{
      id: number;
      error: { message: string };
    }>;
    expect(reply.id).toBe(2);
    expect(reply.error.message).toMatch(/without (a )?response/);
  });

  it("carries the server's session id and protocol version, and ends the session on close", async () => {
    server = await startFakeMcpServer({ sessionId: "sess-1" });
    const relay = relayTo(server);

    await exchange(relay, INITIALIZE);
    await exchange(relay, SEARCH);
    await relay.close();

    const [init, call, end] = server.requests;
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(init.headers["mcp-protocol-version"]).toBeUndefined();
    expect(call.headers["mcp-session-id"]).toBe("sess-1");
    expect(call.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(end.method).toBe("DELETE");
    expect(end.headers["mcp-session-id"]).toBe("sess-1");
    expect(end.headers["x-dosu-api-key"]).toBe("sk_test");
  });

  it("does not end a session the server never opened", async () => {
    server = await startFakeMcpServer();
    const relay = relayTo(server);
    await exchange(relay, INITIALIZE);
    await relay.close();

    expect(server.requests.map((r) => r.method)).toEqual(["POST"]);
  });

  it("forgets a session the server no longer knows", async () => {
    let calls = 0;
    server = await startFakeMcpServer({
      sessionId: "sess-1",
      intercept: (_body, res) => {
        calls += 1;
        if (calls !== 2) return false;
        res.writeHead(404).end("unknown session");
        return true;
      },
    });
    const relay = relayTo(server);
    await exchange(relay, INITIALIZE);
    await exchange(relay, SEARCH);
    await exchange(relay, SEARCH);

    expect(server.requests[1].headers["mcp-session-id"]).toBe("sess-1");
    expect(server.requests[2].headers["mcp-session-id"]).toBeUndefined();
  });
});
