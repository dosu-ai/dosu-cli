import { describe, expect, it } from "vitest";
import { episode, memory, task, trace } from "./fixtures.test-utils";
import { buildReport } from "./model";
import type { ReportSession } from "./types";

function session(id: string, overrides: Partial<ReportSession> = {}): ReportSession {
  return {
    sessionId: id,
    harness: "claude",
    shippedAt: "2026-10-01T10:00:00Z",
    state: "complete",
    trace: trace(id),
    ...overrides,
  };
}

const base = {
  generatedAt: "2026-10-06T00:00:00Z",
  days: 30,
  orgName: "Acme",
  appUrl: "https://app",
};

describe("buildReport", () => {
  it("merges a memory touched by several sessions into one entry with every effect", () => {
    const shared = memory("m-shared");
    const report = buildReport({
      ...base,
      sessions: [
        session("s2", {
          shippedAt: "2026-10-02T00:00:00Z",
          trace: trace("s2", [[shared, ["confirmed", "updated"]]]),
        }),
        session("s1", {
          shippedAt: "2026-10-01T00:00:00Z",
          trace: trace("s1", [[shared, ["created"]]]),
        }),
      ],
    });

    // In the order it happened, whatever order the sessions arrive in.
    expect(report.memories).toHaveLength(1);
    expect(report.memories[0].effects).toEqual(["created", "confirmed", "updated"]);
    expect(report.memories[0].sessionIds).toEqual(["s1", "s2"]);
  });

  it("keeps the freshest copy of a memory's row", () => {
    const old = memory("m", { title: "Old title", updated_at: "2026-10-01T00:00:00Z" });
    const fresh = memory("m", { title: "New title", updated_at: "2026-10-03T00:00:00Z" });
    const report = buildReport({
      ...base,
      sessions: [
        session("s1", { trace: trace("s1", [[fresh, ["updated"]]]) }),
        session("s2", { trace: trace("s2", [[old, ["created"]]]) }),
      ],
    });

    expect(report.memories[0].item.title).toBe("New title");
  });

  it("ranks memories touched by more sessions first, then new knowledge over confirmations", () => {
    const report = buildReport({
      ...base,
      sessions: [
        session("s1", {
          trace: trace("s1", [
            [memory("confirmed-once"), ["confirmed"]],
            [memory("created-once"), ["created"]],
            [memory("twice"), ["confirmed"]],
          ]),
        }),
        session("s2", { trace: trace("s2", [[memory("twice"), ["confirmed"]]]) }),
      ],
    });

    expect(report.memories.map((m) => m.item.id)).toEqual([
      "twice",
      "created-once",
      "confirmed-once",
    ]);
  });

  it("totals what the sessions captured, counting each memory once per effect", () => {
    const shared = memory("m1");
    const report = buildReport({
      ...base,
      sessions: [
        session("s1", {
          trace: trace(
            "s1",
            [
              [shared, ["created"]],
              [memory("m2"), ["contradicted"]],
            ],
            { tasks: [task(1), task(2)], episodes: [episode("e1"), episode("e2")] },
          ),
        }),
        session("s2", { trace: trace("s2", [[shared, ["confirmed"]]]) }),
        session("s3", { state: "processing", trace: trace("s3", [], { status: "processing" }) }),
        session("s4", { state: "waiting", trace: undefined }),
      ],
    });

    expect(report.totals).toEqual({
      sessions: 4,
      processed: 2,
      tasks: 4,
      episodes: 4,
      memories: 2,
      created: 1,
      updated: 0,
      confirmed: 1,
      contradicted: 1,
    });
  });

  it("orders sessions by when they ended, not when they were shipped", () => {
    // A backfill ships a month of sessions in one minute.
    const ended = (at: string) => trace("x", [], { header: { ended_at: at } });
    const report = buildReport({
      ...base,
      sessions: [
        session("older", {
          shippedAt: "2026-10-06T00:00:00Z",
          trace: ended("2026-09-10T00:00:00Z"),
        }),
        session("newer", {
          shippedAt: "2026-10-06T00:00:00Z",
          trace: ended("2026-09-20T00:00:00Z"),
        }),
        session("unread", {
          shippedAt: "2026-10-06T00:00:00Z",
          state: "waiting",
          trace: undefined,
        }),
      ],
    });

    // Without a trace, the shipment is the best clock there is.
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["unread", "newer", "older"]);
  });

  it("orders sessions newest first by when they were shipped when nothing else is known", () => {
    const report = buildReport({
      ...base,
      sessions: [
        session("older", { shippedAt: "2026-10-01T00:00:00Z", state: "waiting", trace: undefined }),
        session("newer", { shippedAt: "2026-10-04T00:00:00Z", state: "waiting", trace: undefined }),
      ],
    });

    expect(report.sessions.map((s) => s.sessionId)).toEqual(["newer", "older"]);
  });
});
