import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectKey } from "../sessions/project";
import type { AgentSession } from "../sessions/scan";
import { createShipStep } from "./runner";

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

const RECORDS = [
  { role: "meta", source: "claude-code" },
  { role: "user", content: "hi", timestamp: "2026-09-01T00:00:00.000Z" },
];

function accepted(body: unknown = { task_id: "task-1", session_url: "https://app/m/s1" }) {
  return new Response(JSON.stringify(body), { status: 202 });
}

interface StepOverrides {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  isIncognito?: (s: AgentSession) => boolean;
  normalize?: (s: AgentSession) => Promise<typeof RECORDS | null>;
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
            content: [{ type: "text", text: "single-flight via a pid lock file" }],
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
