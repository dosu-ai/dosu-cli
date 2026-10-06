import { describe, expect, it, vi } from "vitest";
import type { ShippedSessionRecord } from "../sync/watermark";
import { fetchReportSessions } from "./fetch";
import { trace } from "./fixtures.test-utils";
import type { SessionDetail } from "./types";

function record(
  session: string,
  overrides: Partial<ShippedSessionRecord> = {},
): ShippedSessionRecord {
  return { at: "2026-10-01T10:00:00Z", session, task_id: "t", ...overrides };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function detail(sessionId: string, overrides: Partial<SessionDetail> = {}): SessionDetail {
  return { session_id: sessionId, traces: [trace(sessionId)], private_traces: 0, ...overrides };
}

const options = { apiKey: "sk_user_x", orgId: "org-1", backendUrl: "https://api.test/" };

describe("fetchReportSessions", () => {
  it("asks the session endpoint with the API key, the org, and the bare session id", async () => {
    const fetchImpl = vi.fn(async () => json(detail("abc/def")));

    await fetchReportSessions([record("claude/abc/def", { project: "dosu" })], {
      ...options,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The local record keys by harness/id; the backend knows only the id.
    expect(url).toBe("https://api.test/v1/memory/browse/sessions/abc%2Fdef?org=org-1");
    expect(init.headers).toMatchObject({ "X-Dosu-API-Key": "sk_user_x" });
  });

  it("reads a processed session's newest ingest", async () => {
    const newest = trace("s1", [], { header: { id: "newest" } });
    const fetchImpl = vi.fn(async () =>
      json(detail("s1", { traces: [newest, trace("s1", [], { header: { id: "older" } })] })),
    );

    const [session] = await fetchReportSessions([record("codex/s1", { project: "dosu" })], {
      ...options,
      fetchImpl,
    });

    expect(session).toMatchObject({
      sessionId: "s1",
      harness: "codex",
      project: "dosu",
      shippedAt: "2026-10-01T10:00:00Z",
      state: "complete",
    });
    expect(session.trace?.trace.id).toBe("newest");
  });

  it("tells processing, not-yet-ingested and someone-else's sessions apart", async () => {
    const replies: Record<string, Response> = {
      busy: json(detail("busy", { traces: [trace("busy", [], { status: "processing" })] })),
      waiting: json(detail("waiting", { traces: [] })),
      theirs: json(detail("theirs", { traces: [], private_traces: 1 })),
    };
    const fetchImpl = vi.fn(async (url: string) => {
      const id = decodeURIComponent(url.split("/sessions/")[1].split("?")[0]);
      return replies[id];
    });

    const sessions = await fetchReportSessions(
      [record("claude/busy"), record("claude/waiting"), record("claude/theirs")],
      { ...options, fetchImpl },
    );

    expect(sessions.map((s) => [s.sessionId, s.state, Boolean(s.trace)])).toEqual([
      ["busy", "processing", true],
      ["waiting", "waiting", false],
      ["theirs", "private", false],
    ]);
  });

  it("keeps a failed lookup in the report as an error instead of dropping it", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/ok?") ? json(detail("ok")) : json({ detail: "nope" }, 403),
    );

    const sessions = await fetchReportSessions([record("claude/ok"), record("claude/denied")], {
      ...options,
      fetchImpl,
    });

    expect(sessions.map((s) => s.state)).toEqual(["complete", "error"]);
    expect(sessions[1].error).toBe("HTTP 403");
  });

  it("reports a network failure as an error for that session", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const [session] = await fetchReportSessions([record("claude/s1")], { ...options, fetchImpl });

    expect(session).toMatchObject({ state: "error", error: "connect ECONNREFUSED" });
  });

  it("looks each session up once, using its latest shipment", async () => {
    const fetchImpl = vi.fn(async () => json(detail("s1")));

    const sessions = await fetchReportSessions(
      [
        record("claude/s1", { at: "2026-10-01T00:00:00Z" }),
        record("claude/s1", { at: "2026-10-03T00:00:00Z" }),
      ],
      { ...options, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].shippedAt).toBe("2026-10-03T00:00:00Z");
  });

  it("never has more than the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const id = decodeURIComponent(url.split("/sessions/")[1].split("?")[0]);
      return json(detail(id));
    });
    const records = Array.from({ length: 10 }, (_, i) => record(`claude/s${i}`));

    const sessions = await fetchReportSessions(records, { ...options, fetchImpl, concurrency: 3 });

    expect(peak).toBe(3);
    expect(sessions.map((s) => s.sessionId)).toEqual(records.map((_, i) => `s${i}`));
  });
});
