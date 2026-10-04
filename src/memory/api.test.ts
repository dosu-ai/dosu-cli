import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { fullRecallStatus, memoryApiFromConfig, recallQuick, startFullRecall } from "./api";

const session = { access_token: "a", refresh_token: "r", expires_at: 4_102_444_800 };
const savedBackend = process.env.DOSU_BACKEND_URL_OVERRIDE;

afterEach(() => {
  if (savedBackend === undefined) delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  else process.env.DOSU_BACKEND_URL_OVERRIDE = savedBackend;
});

describe("memoryApiFromConfig", () => {
  it("uses the CLI's backend URL and the API key of the MCP entry", () => {
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test/";
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1", api_key: "test-key" }));
    expect(memoryApiFromConfig()).toEqual({
      backendURL: "https://api.example.test",
      apiKey: "test-key",
    });
  });

  it("is null when there is nothing to authenticate with", () => {
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test";
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1" }));
    expect(memoryApiFromConfig()).toBeNull();
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1", api_key: "k", mode: "oss" }));
    expect(memoryApiFromConfig()).toBeNull();
  });
});

describe("two-stage recall client (backend shapes from phase2-impl.md 12.2)", () => {
  const api = { backendURL: "http://memory.test", apiKey: "test-key" };
  const request = { repo: "acme/widgets", session_id: "s-1", prompt: "Fix the counter" };
  const JOB = "7d1e2f30-5a4b-4c6d-8e9f-0a1b2c3d4e5f";
  const QUICK_ID = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";
  const job = (extra: Record<string, unknown> = {}) => ({
    job_id: JOB,
    status: "pending",
    mode: "retrieval",
    quick_recall_id: null,
    note: null,
    episode_ids: null,
    available_episode_ids: null,
    latency_ms: null,
    recall_latency_ms: null,
    cost_usd: null,
    error: null,
    recall_id: null,
    ...extra,
  });
  let sent: { url: string; init?: RequestInit }[] = [];
  const answer = (body: unknown, status = 200) =>
    (async (url: unknown, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  afterEach(() => {
    sent = [];
  });

  it("reads the quick note and its recall id", async () => {
    const quick = {
      note: "From this repository's playbook, ...",
      episode_ids: [JOB],
      available_episode_ids: [JOB],
      latency_ms: 412,
      cost_usd: null,
      recall_id: QUICK_ID,
    };
    expect(await recallQuick(api, request, answer(quick))).toEqual({
      note: quick.note,
      latency_ms: 412,
      recall_id: QUICK_ID,
    });
    expect(sent[0].url).toBe("http://memory.test/v1/agent-memory/recall/quick");
    expect(JSON.parse(String(sent[0].init?.body))).toEqual(request);
  });

  it("reads the job id from the 202 answer that starts a full recall", async () => {
    expect(await startFullRecall(api, request, answer(job(), 202))).toEqual({ job_id: JOB });
    expect(sent[0].url).toBe("http://memory.test/v1/agent-memory/recall/full");
    expect(sent[0].init?.method).toBe("POST");
  });

  it.each([
    ["pending", job(), { status: "pending", note: "", error: null, latency_ms: null }],
    [
      "done",
      job({ status: "done", note: "Run `make test` first.", latency_ms: 10_234, recall_id: JOB }),
      { status: "done", note: "Run `make test` first.", error: null, latency_ms: 10_234 },
    ],
    [
      "done with nothing to say",
      job({ status: "done", note: "", latency_ms: 9_000 }),
      { status: "done", note: "", error: null, latency_ms: 9_000 },
    ],
    [
      "failed",
      job({
        status: "failed",
        error: "TimeoutError: no note by the deadline",
        latency_ms: 120_001,
      }),
      {
        status: "failed",
        note: "",
        error: "TimeoutError: no note by the deadline",
        latency_ms: 120_001,
      },
    ],
  ])("reads a %s job", async (_label, body, parsed) => {
    expect(await fullRecallStatus(api, JOB, answer(body))).toEqual(parsed);
    expect(sent[0].url).toBe(`http://memory.test/v1/agent-memory/recall/full/${JOB}`);
    expect(sent[0].init?.method).toBe("GET");
    expect(sent[0].init?.body).toBeUndefined();
    expect(sent[0].init?.headers).toEqual({ "X-Dosu-API-Key": "test-key" });
  });

  it("gives up on an unknown status or a 4xx, and retries a 5xx", async () => {
    expect(await fullRecallStatus(api, JOB, answer(job({ status: "running" })))).toEqual({
      error: "full recall job has an unknown status: running",
      permanent: true,
    });
    expect(await fullRecallStatus(api, JOB, answer({ detail: "Job not found" }, 404))).toEqual({
      error: "HTTP 404",
      permanent: true,
    });
    expect(await fullRecallStatus(api, JOB, answer({ detail: "busy" }, 503))).toEqual({
      error: "HTTP 503",
      permanent: false,
    });
  });
});
