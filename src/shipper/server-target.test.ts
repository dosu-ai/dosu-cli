import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { createShipStep } from "./runner";
import { createServerTarget } from "./target";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type FetchMock = ReturnType<typeof vi.fn>;

function target(fetchImpl: FetchMock) {
  return createServerTarget({
    name: "team",
    url: "https://sessions.example.com/",
    token: "sdb_test",
    fetchImpl: fetchImpl as unknown as (input: string, init?: RequestInit) => Promise<Response>,
  });
}

function stored(status = 201) {
  return new Response(
    JSON.stringify({ status: status === 201 ? "stored" : "duplicate", content_hash: "h1" }),
    {
      status,
    },
  );
}

function refusal(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

/** What the mocked server received: the gzipped JSON body, decoded. */
function sentBody(fetchImpl: FetchMock): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  const bytes = gunzipSync(Buffer.from(init.body as Uint8Array));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

const METADATA = {
  agent: "claude-code",
  session_id: "sess1",
  project: "github.com/acme/app",
  branch: "main",
};

describe("createServerTarget", () => {
  it("posts the raw transcript gzipped with the bearer token and the session's metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(stored());
    const result = await target(fetchImpl).send({
      records: [],
      metadata: { ...METADATA, continuation: { from_record: 3, prefix_sha256: "p" } },
      transcript: () => ({ text: '{"type":"user"}\n', format: "jsonl" }),
    });
    expect(result).toEqual({ status: "shipped", taskId: "stored:h1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sessions.example.com/v1/sessions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sdb_test");
    expect(headers["Content-Encoding"]).toBe("gzip");
    expect(sentBody(fetchImpl)).toEqual({
      agent: "claude-code",
      session_id: "sess1",
      transcript: '{"type":"user"}\n',
      format: "jsonl",
      project: "github.com/acme/app",
      branch: "main",
      continuation: { from_record: 3, prefix_sha256: "p" },
    });
  });

  it("counts a duplicate as shipped", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(stored(200));
    const result = await target(fetchImpl).send({
      records: [],
      metadata: METADATA,
      transcript: () => ({ text: "x", format: "jsonl" }),
    });
    expect(result).toEqual({ status: "shipped", taskId: "duplicate:h1" });
  });

  it("settles the server's refusals as rejected and everything else as a failure", async () => {
    const send = (response: Response) =>
      target(vi.fn().mockResolvedValue(response)).send({
        records: [],
        metadata: METADATA,
        transcript: () => ({ text: "x", format: "jsonl" }),
      });
    expect(await send(refusal(422, "empty", "transcript has no conversation"))).toEqual({
      status: "rejected",
      httpStatus: 422,
      message: "empty: transcript has no conversation",
    });
    expect(await send(refusal(409, "no_storage", "no storage linked"))).toEqual({
      status: "failed",
      message: "server https://sessions.example.com: no_storage: no storage linked",
    });
    expect(await send(new Response("gateway", { status: 502 }))).toEqual({
      status: "failed",
      message: "server https://sessions.example.com: HTTP 502",
    });
    expect(
      await send(refusal(401, "unauthorized", "a valid owner token is required")),
    ).toMatchObject({
      status: "failed",
    });
  });

  it("fails without a readable transcript or a reachable server", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(
      await target(fetchImpl).send({ records: [], metadata: METADATA, transcript: () => null }),
    ).toEqual({ status: "failed", message: "transcript could not be read" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await target(fetchImpl).send({
        records: [],
        metadata: METADATA,
        transcript: () => ({ text: "x", format: "jsonl" }),
      }),
    ).toEqual({ status: "failed", message: "ECONNREFUSED" });
  });
});

describe("ship step with a server target", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the native log off disk and sends it, after the local worthiness checks", async () => {
    dir = mkdtempSync(join(tmpdir(), "dosu-server-target-"));
    const path = join(dir, "sess1.jsonl");
    const text = [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: dir,
        sessionId: "sess1",
        message: { role: "user", content: "how does the sync lock work?" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-09-01T00:00:05.000Z",
        sessionId: "sess1",
        message: {
          role: "assistant",
          model: "claude-x",
          content: [{ type: "text", text: `a pid lock file. ${"Details. ".repeat(250)}` }],
        },
      }),
    ].join("\n");
    writeFileSync(path, text);
    const session: AgentSession = {
      id: "sess1",
      harness: "claude",
      path,
      updated: "2026-09-01T00:00:05.000Z",
    };
    const fetchImpl = vi.fn().mockResolvedValue(stored());
    const step = createShipStep({
      target: target(fetchImpl),
      isIncognito: () => false,
      readUsage: () => null,
      resolveProject: () => ({ project: "github.com/acme/app", rule: "origin" }),
      resolveBranch: () => "main",
    });
    const results = await step([session]);
    expect(results.map((r) => r.outcome)).toEqual(["shipped"]);
    const body = sentBody(fetchImpl);
    expect(body.transcript).toBe(text);
    expect(body.format).toBe("jsonl");
    expect(body.agent).toBe("claude-code");
    expect(body.project).toBe("github.com/acme/app");
  });
});
