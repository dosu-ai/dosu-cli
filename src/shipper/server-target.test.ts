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

const WHOLE = { records_total: 9, prefix_sha256: "f".repeat(64) };

function answer(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify({ ...WHOLE, ...body }), { status });
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

const UPLOAD = {
  agent: "claude-code",
  session_id: "sess1",
  transcript: '{"type":"user"}\n',
  format: "jsonl" as const,
  project: "github.com/acme/app",
  branch: "main",
  shipped: { records: 4, prefix_sha256: "c".repeat(64) },
};

describe("createServerTarget", () => {
  it("posts the upload gzipped with the bearer token, and hands back the server's prefix", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(answer(201, { status: "stored", content_hash: "h1" }));

    const result = await target(fetchImpl).send(UPLOAD);

    expect(result).toEqual({
      status: "shipped",
      taskId: "stored:h1",
      shipped: { records: 9, prefix_sha256: "f".repeat(64) },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sessions.example.com/v1/sessions");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sdb_test");
    expect(headers.get("content-encoding")).toBe("gzip");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^dosu-cli\//);
    expect(sentBody(fetchImpl)).toEqual(UPLOAD);
  });

  it("counts a duplicate as shipped, and a trivial answer as trivial", async () => {
    const dup = vi.fn().mockResolvedValue(answer(200, { status: "duplicate", content_hash: "h1" }));
    expect(await target(dup).send(UPLOAD)).toMatchObject({
      status: "shipped",
      taskId: "duplicate:h1",
    });

    const trivial = vi.fn().mockResolvedValue(answer(200, { status: "trivial" }));
    expect(await target(trivial).send(UPLOAD)).toEqual({
      status: "trivial",
      shipped: { records: 9, prefix_sha256: "f".repeat(64) },
    });
  });

  it("settles the server's refusals as rejected and everything else as a failure", async () => {
    const rejected = vi.fn().mockResolvedValue(refusal(422, "invalid", "bad role"));
    expect(await target(rejected).send(UPLOAD)).toEqual({
      status: "rejected",
      httpStatus: 422,
      message: "invalid: bad role",
    });

    const tooLarge = vi.fn().mockResolvedValue(refusal(413, "too_large", "over 64 MiB"));
    expect(await target(tooLarge).send(UPLOAD)).toEqual({
      status: "rejected",
      httpStatus: 413,
      message: "too_large: over 64 MiB",
    });

    const noStorage = vi.fn().mockResolvedValue(refusal(409, "no_storage", "link a bucket"));
    expect(await target(noStorage).send(UPLOAD)).toEqual({
      status: "failed",
      message: "server https://sessions.example.com: no_storage: link a bucket",
    });

    const down = vi.fn().mockResolvedValue(new Response("gateway", { status: 502 }));
    expect(await target(down).send(UPLOAD)).toEqual({
      status: "failed",
      message: "server https://sessions.example.com: HTTP 502",
    });

    const unauthorized = vi.fn().mockResolvedValue(refusal(401, "unauthorized", "bad token"));
    expect((await target(unauthorized).send(UPLOAD)).status).toBe("failed");

    // The server's own bucket being down is a failure that names the server; so is a chunk
    // the server cannot place (the shipper never sends offsets, so only a server bug gets here).
    const bucketDown = vi.fn().mockResolvedValue(refusal(502, "storage", "bucket unavailable"));
    expect(await target(bucketDown).send(UPLOAD)).toEqual({
      status: "failed",
      message: "server https://sessions.example.com: bucket unavailable",
    });
    const misplaced = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "offset_mismatch", expected: 10 } }), {
        status: 409,
      }),
    );
    expect(await target(misplaced).send(UPLOAD)).toEqual({
      status: "failed",
      message:
        "server https://sessions.example.com: offset_mismatch: chunk starts at byte 0; the session's log ends at 10",
    });
  });

  it("fails on anything else thrown, as it says", async () => {
    const odd = vi.fn().mockImplementation(() => {
      throw "the network stack is on fire";
    });
    expect(await target(odd).send(UPLOAD)).toEqual({
      status: "failed",
      message: "cannot reach https://sessions.example.com: the network stack is on fire",
    });
  });

  it("settles an agent without an adapter as rejected without a request", async () => {
    const fetchImpl = vi.fn();
    expect(await target(fetchImpl).send({ ...UPLOAD, agent: "emacs" })).toEqual({
      status: "rejected",
      message: "unsupported_source: emacs",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails without a reachable server", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await target(fetchImpl).send(UPLOAD)).toEqual({
      status: "failed",
      message: "cannot reach https://sessions.example.com: ECONNREFUSED",
    });
  });
});

describe("ship step with a server target", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the native log off disk and sends it verbatim with the recorded branch", async () => {
    dir = mkdtempSync(join(tmpdir(), "dosu-server-target-"));
    const path = join(dir, "sess1.jsonl");
    const text = `${[
      JSON.stringify({
        type: "user",
        uuid: "u1",
        timestamp: "2026-09-01T00:00:00.000Z",
        cwd: dir,
        gitBranch: "feat/lock",
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
          content: [{ type: "text", text: "a pid lock file." }],
        },
      }),
    ].join("\n")}\n`;
    writeFileSync(path, text);
    const session: AgentSession = {
      id: "sess1",
      harness: "claude",
      path,
      updated: "2026-09-01T00:00:05.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(answer(201, { status: "stored", content_hash: "h1" }));
    const step = createShipStep({
      target: target(fetchImpl),
      isIncognito: () => false,
      resolveProject: () => ({ project: "github.com/acme/app", rule: "origin" }),
      resolveBranch: () => "main",
    });

    const [result] = await step([session]);

    expect(result).toMatchObject({ outcome: "shipped", records: 9 });
    expect(sentBody(fetchImpl)).toEqual({
      agent: "claude-code",
      session_id: "sess1",
      transcript: text,
      format: "jsonl",
      project: "github.com/acme/app",
      branch: "feat/lock",
    });
  });
});
