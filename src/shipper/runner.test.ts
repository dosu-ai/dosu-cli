import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  resolveProjectDir?: (s: AgentSession) => string | null;
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
    resolveProjectDir: overrides.resolveProjectDir ?? (() => "/repo/app"),
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
      // repo resolved from the transcript's own cwd by the default resolver.
      expect(body.metadata.repo).toBe(dir);
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
        repo: "/repo/app",
        agent: "claude",
        session_id: "s1",
      },
    });
  });

  it("omits session_url when the backend returns none", async () => {
    const { step } = makeStep({
      fetchImpl: vi.fn().mockResolvedValue(accepted({ task_id: "task-2", session_url: null })),
    });

    const [result] = await step([session("s1")]);

    expect(result).toEqual({ session: session("s1"), outcome: "shipped", taskId: "task-2" });
  });

  it("tolerates a 202 with an unparseable body", async () => {
    const { step } = makeStep({
      fetchImpl: vi.fn().mockResolvedValue(new Response("not json", { status: 202 })),
    });

    const [result] = await step([session("s1")]);

    expect(result.outcome).toBe("shipped");
    expect(result.taskId).toBe("unknown");
  });

  it("falls back to the scanner's project mapping, then 'unknown', for repo", async () => {
    const { step, fetchImpl } = makeStep({ resolveProjectDir: () => null });

    await step([session("s1", { project: "-repo-app" }), session("s2")]);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).metadata.repo).toBe("-repo-app");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).metadata.repo).toBe("unknown");
  });

  it("never ships an incognito session", async () => {
    const { step, fetchImpl } = makeStep({ isIncognito: (s) => s.id === "s1" });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["incognito", "shipped"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).metadata.session_id).toBe("s2");
  });

  it("skips sessions that have no shippable transcript", async () => {
    const { step, fetchImpl } = makeStep({ normalize: async () => null });

    const results = await step([session("s1")]);

    expect(results).toEqual([
      { session: session("s1"), outcome: "skipped", message: "no shippable transcript" },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips past a rejected payload (422) instead of wedging the batch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 422 }))
      .mockResolvedValueOnce(accepted());
    const { step } = makeStep({ fetchImpl: fetchImpl });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["skipped", "shipped"]);
    expect(results[0].message).toContain("HTTP 422");
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
