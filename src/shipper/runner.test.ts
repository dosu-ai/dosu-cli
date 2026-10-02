import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectKey } from "../sessions/project";
import type { AgentSession } from "../sessions/scan";
import { prefixSha256 } from "./continuation";
import { createShipStep } from "./runner";
import { MIN_SESSION_CHARS } from "./worthiness";

const mockLoggerDebug = vi.hoisted(() => vi.fn());
vi.mock("../debug/logger", () => ({
  logger: { debug: mockLoggerDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    harness: "claude",
    path: `/tmp/${id}.jsonl`,
    updated: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A conversation big enough to be worth learning from. */
const RECORDS = [
  { role: "meta", source: "claude-code" },
  { role: "user", content: "why does the sync lock leak?", timestamp: "2026-09-01T00:00:00.000Z" },
  { role: "assistant", content: "x".repeat(2000), timestamp: "2026-09-01T00:00:05.000Z" },
];

function accepted(body: unknown = { task_id: "task-1", session_url: "https://app/m/s1" }) {
  return new Response(JSON.stringify(body), { status: 202 });
}

interface StepOverrides {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  isIncognito?: (s: AgentSession) => boolean;
  normalize?: (s: AgentSession) => Promise<unknown[] | null>;
  resolveProject?: (s: AgentSession) => ProjectKey | null;
}

function makeStep(overrides: StepOverrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? vi.fn().mockResolvedValue(accepted());
  const step = createShipStep({
    apiKey: "sk_user_test",
    deploymentId: "dep1",
    backendUrl: "https://api.dosu.test/",
    fetchImpl,
    isIncognito: overrides.isIncognito ?? (() => false),
    // biome-ignore lint/suspicious/noExplicitAny: test records stand in for the package's type
    normalize: (overrides.normalize ?? (async () => RECORDS)) as any,
    resolveProject:
      overrides.resolveProject ?? (() => ({ project: "github.com/acme/app", rule: "origin" })),
  });
  return { step, fetchImpl: fetchImpl as ReturnType<typeof vi.fn> };
}

describe("createShipStep", () => {
  beforeEach(() => {
    mockLoggerDebug.mockClear();
  });

  it("defaults its boundaries: real incognito check, normalizer, and project resolver", async () => {
    // A real (tiny) Claude transcript on disk, so the default normalize and
    // resolver paths run end to end; only HTTP is mocked, and the backend URL
    // comes from the runtime override like a repointed install.
    const dir = mkdtempSync(join(tmpdir(), "dosu-ship-runner-"));
    const path = join(dir, "sess1.jsonl");
    writeFileSync(
      path,
      [
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
            content: [
              {
                type: "text",
                text: `single-flight via a pid lock file. ${"Details. ".repeat(250)}`,
              },
            ],
          },
        }),
      ].join("\n"),
    );
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.dosu.test";
    try {
      const step = createShipStep({
        apiKey: "sk_user_test",
        deploymentId: "dep1",
        fetchImpl,
      });
      const results = await step([session("sess1", { path })]);

      expect(results[0].outcome).toBe("shipped");
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe("https://api.dosu.test/v1/memory/ingest/async");
      const body = JSON.parse(init.body);
      expect(body.records[0]).toMatchObject({ role: "meta", source: "claude-code" });
      // The project comes from the transcript's own cwd: not a checkout, so its path.
      expect(body.metadata.project).toBe(`path:${realpathSync(dir)}`);
      expect(body.metadata.repo).toBe(body.metadata.project);
    } finally {
      delete process.env.DOSU_BACKEND_URL_OVERRIDE;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POSTs redacted records with metadata and records the accepted task", async () => {
    const { step, fetchImpl } = makeStep();

    const results = await step([session("s1")]);

    expect(results).toEqual([
      {
        session: session("s1"),
        outcome: "shipped",
        taskId: "task-1",
        sessionUrl: "https://app/m/s1",
        project: "github.com/acme/app",
        records: 3,
        prefixSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.dosu.test/v1/memory/ingest/async");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Dosu-API-Key": "sk_user_test",
    });
    expect(JSON.parse(init.body)).toEqual({
      records: RECORDS,
      metadata: {
        deployment_id: "dep1",
        project: "github.com/acme/app",
        // Older servers require `repo`; it carries the same key.
        repo: "github.com/acme/app",
        // The trajectory source, not the CLI's harness id.
        agent: "claude-code",
        session_id: "s1",
      },
    });
  });

  it("omits session_url when the backend returns none", async () => {
    const { step } = makeStep({
      fetchImpl: vi.fn().mockResolvedValue(accepted({ task_id: "task-2", session_url: null })),
    });

    const [result] = await step([session("s1")]);

    expect(result).toEqual({
      session: session("s1"),
      outcome: "shipped",
      taskId: "task-2",
      project: "github.com/acme/app",
      records: 3,
      prefixSha256: expect.any(String),
    });
  });

  it("tolerates a 202 with an unparseable body", async () => {
    const { step } = makeStep({
      fetchImpl: vi.fn().mockResolvedValue(new Response("not json", { status: 202 })),
    });

    const [result] = await step([session("s1")]);

    expect(result.outcome).toBe("shipped");
    expect(result.taskId).toBe("unknown");
  });

  it("sends 'unknown' when neither the working directory nor DOSU_PROJECT is known", async () => {
    const { step, fetchImpl } = makeStep({ resolveProject: () => null });

    await step([session("s1")]);

    const { metadata } = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(metadata).toMatchObject({ project: "unknown", repo: "unknown" });
  });

  it("never ships an incognito session", async () => {
    const { step, fetchImpl } = makeStep({ isIncognito: (s) => s.id === "s1" });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["incognito", "shipped"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).metadata.session_id).toBe("s2");
  });

  it("a transcript the normalizer cannot read is unsupported, not a failure", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => null });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["unsupported", "unsupported"]);
    expect(results[0].message).toBe("transcript could not be normalized");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a transcript with no conversation in it is trivial and never uploaded", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => [] });

    const [result] = await step([session("s1")]);

    expect(result.outcome).toBe("trivial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a harness with no normalizer is unsupported and never reads its transcript", async () => {
    const normalize = vi.fn(async () => RECORDS);
    const { step, fetchImpl } = makeStep({ normalize });

    const [result] = await step([session("s1", { harness: "opencode" })]);

    expect(result).toMatchObject({
      outcome: "unsupported",
      message: "no normalizer for opencode sessions yet",
    });
    expect(normalize).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("settles a refused payload (422) as rejected and carries on with the batch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 422 }))
      .mockResolvedValueOnce(accepted());
    const { step } = makeStep({ fetchImpl: fetchImpl });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["rejected", "shipped"]);
    expect(results[0]).toMatchObject({ httpStatus: 422, message: "ingest rejected: HTTP 422" });
  });

  it("a server failure stops the batch so unprocessed sessions retry after backoff", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    const { step } = makeStep({ fetchImpl: fetchImpl });

    const results = await step([session("s1"), session("s2")]);

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("failed");
    expect(results[0].message).toContain("HTTP 503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a network error is a failed result, never a throw", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const { step } = makeStep({ fetchImpl: fetchImpl });

    const results = await step([session("s1"), session("s2")]);

    expect(results).toEqual([
      { session: session("s1"), outcome: "failed", message: "socket hang up" },
    ]);
  });
});

/** One Claude Code transcript line. */
function line(type: string, uuid: string, second: number, content: unknown): string {
  return JSON.stringify({
    type,
    uuid,
    timestamp: `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    sessionId: "s",
    message: { role: type, model: "claude-x", content },
  });
}

describe("createShipStep worthiness, judged on the normalized and redacted records", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dosu-ship-worth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Ships one real transcript through the default normalizer. */
  async function shipTranscript(lines: string[]) {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines.join("\n"));
    const fetchImpl = vi.fn().mockResolvedValue(accepted());
    const step = createShipStep({
      apiKey: "k",
      deploymentId: "dep1",
      backendUrl: "https://api.dosu.test",
      fetchImpl,
      isIncognito: () => false,
      resolveProject: () => ({ project: "github.com/acme/app", rule: "origin" }),
    });
    const [result] = await step([session("s", { path })]);
    return { result, fetchImpl };
  }

  it("ships a terse, tool-heavy run: tool arguments and results count, not just prose", async () => {
    // Two words of prose each way; the substance is in the tool traffic. A text-only turn
    // count called this trivial.
    const { result, fetchImpl } = await shipTranscript([
      line("user", "u1", 0, "fix it"),
      line("assistant", "a1", 1, [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test 2>&1" } },
      ]),
      line("user", "u2", 2, [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: `FAIL auth.test.ts\n${"at x\n".repeat(500)}`,
        },
      ]),
      line("assistant", "a2", 3, [{ type: "text", text: "Fixed." }]),
    ]);

    expect(result.outcome).toBe("shipped");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("a short exchange is trivial and never uploaded", async () => {
    const { result, fetchImpl } = await shipTranscript([
      line("user", "u1", 0, "hello"),
      line("assistant", "a1", 1, [{ type: "text", text: "Hi! How can I help?" }]),
    ]);

    expect(result.outcome).toBe("trivial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a long prompt nobody answered is trivial", async () => {
    const { result } = await shipTranscript([line("user", "u1", 0, "y".repeat(5000))]);

    expect(result.outcome).toBe("trivial");
  });

  it("the threshold is on the records as shipped, after redaction", async () => {
    // 2,100 characters of which most is one secret: redacted, it falls under the bar.
    const secret = `ghp_${"a".repeat(36)}`;
    const { result } = await shipTranscript([
      line("user", "u1", 0, `use ${secret} ${"z".repeat(10)}`),
      line("assistant", "a1", 1, [{ type: "text", text: `${secret.repeat(50)} ok` }]),
    ]);

    expect(result.outcome).toBe("trivial");
  });
});

describe("createShipStep worthiness thresholds", () => {
  const user = { role: "user", content: "u", timestamp: "2026-09-01T00:00:00.000Z" };
  const assistant = (content: string) => ({
    role: "assistant",
    content,
    timestamp: "2026-09-01T00:00:01.000Z",
  });

  it.each([
    // The user record holds one character.
    ["exactly the minimum", [user, assistant("a".repeat(MIN_SESSION_CHARS - 1))], "shipped"],
    ["one character short", [user, assistant("a".repeat(MIN_SESSION_CHARS - 2))], "trivial"],
    [
      "no user record",
      [
        assistant("a".repeat(3000)),
        { role: "tool", tool_call_id: "t", content: "r", timestamp: "x" },
      ],
      "trivial",
    ],
    [
      "only a tool result answering the user",
      [
        user,
        { role: "tool", tool_call_id: "t", content: "r".repeat(MIN_SESSION_CHARS), timestamp: "x" },
      ],
      "shipped",
    ],
    [
      "tool arguments count",
      [
        user,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t", name: "Edit", args: "a".repeat(MIN_SESSION_CHARS - 1) }],
          timestamp: "x",
        },
      ],
      "shipped",
    ],
  ])("%s", async (_label, body, outcome) => {
    const meta = { role: "meta", source: "claude-code", cwd: "/m".repeat(5000) };
    const { step } = makeStep({ normalize: async () => [meta, ...body] });

    const [result] = await step([session("s1")]);

    // The meta record never counts, however long its strings.
    expect(result.outcome).toBe(outcome);
  });
});

describe("createShipStep continuation", () => {
  const turn = (i: number) => [
    { role: "user", content: `question ${i}`, timestamp: `2026-09-01T00:0${i}:00.000Z` },
    { role: "assistant", content: "a".repeat(2000), timestamp: `2026-09-01T00:0${i}:30.000Z` },
  ];
  const meta = { role: "meta", source: "claude-code", cwd: "/repo/app" };
  const first = [meta, ...turn(1)];
  const grown = [...first, ...turn(2)];
  const hash = (records: unknown[], count: number) =>
    prefixSha256(records as NormalizedRecord[], count);
  const shippedFirst = { records: 3, prefix_sha256: hash(first, 3) };

  function body(fetchImpl: ReturnType<typeof vi.fn>, call = 0) {
    return JSON.parse(fetchImpl.mock.calls[call][1].body);
  }

  it("a first ship reports how many records went and their hash", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => first });

    const [result] = await step([session("s1")]);

    expect(result).toMatchObject({ records: 3, prefixSha256: hash(first, 3) });
    expect(body(fetchImpl).metadata.continuation).toBeUndefined();
  });

  it("a session that grew after shipping sends the meta record and only the new tail", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => grown });

    const [result] = await step([session("s1")], () => shippedFirst);

    const sent = body(fetchImpl);
    expect(sent.records).toEqual([meta, ...turn(2)]);
    expect(sent.metadata.continuation).toEqual({
      from_record: 3,
      prefix_sha256: shippedFirst.prefix_sha256,
    });
    // What has shipped now covers the whole session.
    expect(result).toMatchObject({ outcome: "shipped", records: 5, prefixSha256: hash(grown, 5) });
  });

  it("ships the whole session again when the shipped prefix no longer matches", async () => {
    const rewritten = [meta, { ...turn(1)[0], content: "edited" }, turn(1)[1], ...turn(2)];
    const { step, fetchImpl } = makeStep({ normalize: async () => rewritten });

    await step([session("s1")], () => shippedFirst);

    expect(body(fetchImpl).records).toEqual(rewritten);
    expect(body(fetchImpl).metadata.continuation).toBeUndefined();
  });

  it("a new tail too small to learn from is trivial and never uploaded", async () => {
    const pleasantries = [
      ...first,
      { role: "user", content: "thanks!", timestamp: "2026-09-01T00:09:00.000Z" },
      { role: "assistant", content: "Anytime.", timestamp: "2026-09-01T00:09:01.000Z" },
    ];
    const { step, fetchImpl } = makeStep({ normalize: async () => pleasantries });

    const [result] = await step([session("s1")], () => shippedFirst);

    expect(result.outcome).toBe("trivial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a session touched without new records is trivial", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => first });

    const [result] = await step([session("s1")], () => shippedFirst);

    expect(result.outcome).toBe("trivial");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the parent of a child session, and only then", async () => {
    const { step, fetchImpl } = makeStep();

    await step([session("child", { parentId: "parent-1" }), session("top")]);

    expect(body(fetchImpl, 0).metadata.parent_session_id).toBe("parent-1");
    expect("parent_session_id" in body(fetchImpl, 1).metadata).toBe(false);
  });
});
