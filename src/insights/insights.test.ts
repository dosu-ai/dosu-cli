import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import {
  type AskFn,
  buildAtAGlancePrompt,
  buildInsights,
  buildSuggestionsPrompt,
  buildTopicsPrompt,
  type UsageStats,
} from "./insights";

const mockQuery = vi.fn();

function createMockClient(): unknown {
  function proxy(path: string[] = []): unknown {
    return new Proxy(() => {}, {
      get(_, prop: string) {
        if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
        return proxy([...path, prop]);
      },
    });
  }
  return proxy();
}

const cfg: Config = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  space_id: "sp1",
  deployment_id: "d1",
  deployment_name: "Acme Docs",
  api_key: "sk_user_test",
};

const NOW = () => new Date("2026-04-16T12:00:00Z");

beforeEach(() => {
  mockQuery.mockReset();
});

function stats(over: Partial<UsageStats> = {}): UsageStats {
  return {
    totalResponses: 0,
    totalWithResponse: 0,
    byConfidence: { high: 0, medium: 0, low: 0 },
    reactions: {
      totalPositive: 0,
      totalNegative: 0,
      messagesWithReactions: 0,
      reactionRate: 0,
      positiveRate: 0,
    },
    ...over,
  };
}

const okAsk: AskFn = async (q) => `answered: ${q.slice(0, 16)}`;

describe("buildInsights", () => {
  it("queries current window and combined window", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 50, totalWithResponse: 40 }));
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 90, totalWithResponse: 70 }));

    await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(mockQuery).toHaveBeenNthCalledWith(1, "analytics.getUsageStats", {
      spaceId: "sp1",
      days: 30,
    });
    expect(mockQuery).toHaveBeenNthCalledWith(2, "analytics.getUsageStats", {
      spaceId: "sp1",
      days: 60,
    });
  });

  it("derives previous window by subtracting current from combined", async () => {
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 50,
        totalWithResponse: 40,
        byConfidence: { high: 30, medium: 15, low: 5 },
        reactions: {
          totalPositive: 10,
          totalNegative: 2,
          messagesWithReactions: 12,
          reactionRate: 0.24,
          positiveRate: 0.83,
        },
      }),
    );
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 90,
        totalWithResponse: 70,
        byConfidence: { high: 50, medium: 25, low: 15 },
        reactions: {
          totalPositive: 14,
          totalNegative: 6,
          messagesWithReactions: 20,
          reactionRate: 0.22,
          positiveRate: 0.7,
        },
      }),
    );

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.previous.totalResponses).toBe(40);
    expect(r.previous.totalWithResponse).toBe(30);
    expect(r.previous.byConfidence).toEqual({ high: 20, medium: 10, low: 10 });
    expect(r.previous.reactions.totalPositive).toBe(4);
    expect(r.previous.reactions.totalNegative).toBe(4);
    expect(r.previous.reactions.positiveRate).toBeCloseTo(0.5, 5);
  });

  it("clamps subtraction to zero when combined is smaller than current (defensive)", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 50 }));
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 30 }));

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.previous.totalResponses).toBe(0);
  });

  it("computes answer-rate delta between windows", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 100, totalWithResponse: 90 }));
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 200, totalWithResponse: 160 }));

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    // current = 90/100 = 0.9; previous = 70/100 = 0.7; delta = 0.2
    expect(r.derived.answerRate).toBeCloseTo(0.9, 5);
    expect(r.derived.answerRateDelta).toBeCloseTo(0.2, 5);
    expect(r.derived.responsesDelta).toBe(0);
  });

  it("returns null answer-rate when there are no responses", async () => {
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.derived.answerRate).toBeNull();
    expect(r.derived.answerRateDelta).toBeNull();
    expect(r.derived.positiveRateDelta).toBeNull();
  });

  it("preserves narrative answers and tolerates per-call failures", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 10, totalWithResponse: 8 }));
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 12, totalWithResponse: 10 }));

    let n = 0;
    const ask: AskFn = async (q) => {
      n += 1;
      if (n === 2) return null; // simulate failure
      return `OK: ${q.slice(0, 8)}`;
    };

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask,
      windowDays: 30,
      now: NOW,
    });

    expect(r.narratives.atAGlance).toMatch(/^OK: /);
    expect(r.narratives.topics).toBeNull();
    expect(r.narratives.suggestions).toMatch(/^OK: /);
  });

  it("throws when space_id is missing", async () => {
    await expect(
      buildInsights({
        client: createMockClient() as never,
        cfg: { ...cfg, space_id: undefined },
        ask: okAsk,
      }),
    ).rejects.toThrow(/space_id/);
  });

  it("returns the welcome cheer when there are no responses", async () => {
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/brand new/);
  });

  it("celebrates a high answer rate", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 100, totalWithResponse: 95 }));
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 100, totalWithResponse: 95 }));

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers.some((c) => /answer rate/.test(c))).toBe(true);
  });

  it("celebrates dominant high-confidence responses", async () => {
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 30,
        totalWithResponse: 28,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
    );
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 30,
        totalWithResponse: 28,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
    );

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers.some((c) => /high-confidence/.test(c))).toBe(true);
  });

  it("celebrates positive feedback when rate >= 80%", async () => {
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 50,
        totalWithResponse: 40,
        reactions: {
          totalPositive: 9,
          totalNegative: 1,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.9,
        },
      }),
    );
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 50,
        totalWithResponse: 40,
        reactions: {
          totalPositive: 9,
          totalNegative: 1,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.9,
        },
      }),
    );

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers.some((c) => /positive feedback/.test(c))).toBe(true);
  });

  it("celebrates rising volume", async () => {
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 80, totalWithResponse: 60 }));
    // combined 30 means previous = 0; current 80 - prev 0 = +80
    mockQuery.mockResolvedValueOnce(stats({ totalResponses: 80, totalWithResponse: 60 }));

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers.some((c) => /Volume is up/.test(c))).toBe(true);
  });

  it("falls back to a generic cheer when no rules trigger", async () => {
    // 30 responses, mediocre rates everywhere — no celebratable signal, and the
    // combined window is double so previous == current → no volume delta.
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 30,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 10, low: 15 },
      }),
    );
    mockQuery.mockResolvedValueOnce(
      stats({
        totalResponses: 60,
        totalWithResponse: 30,
        byConfidence: { high: 10, medium: 20, low: 30 },
      }),
    );

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/30 responses logged/);
  });

  it("falls back to 'your deployment' when deployment_name is missing", async () => {
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg: { ...cfg, deployment_name: undefined },
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.deploymentName).toBe("your deployment");
  });

  it("normalizes nullish stats from the API", async () => {
    mockQuery.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce(undefined);

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });

    expect(r.current.totalResponses).toBe(0);
    expect(r.previous.totalResponses).toBe(0);
  });

  it("uses real Date when `now` is not provided", async () => {
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());

    const r = await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
    });

    // Should be a valid ISO timestamp from "now"
    expect(() => new Date(r.generatedAt)).not.toThrow();
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("prompt builders", () => {
  const s = stats({ totalResponses: 10, totalWithResponse: 8 });
  const d = { answerRate: 0.8, answerRateDelta: 0.05, responsesDelta: 2, positiveRateDelta: null };

  it("at-a-glance prompt embeds the stats", () => {
    const p = buildAtAGlancePrompt(s, d, 30);
    expect(p).toContain("last 30 days");
    expect(p).toContain("10 total responses");
    expect(p).toContain("80% answer rate");
  });

  it("topics prompt names the window", () => {
    expect(buildTopicsPrompt(7)).toContain("last 7 days");
  });

  it("suggestions prompt asks for actionable items", () => {
    const p = buildSuggestionsPrompt(s, d, 30);
    expect(p).toContain("numbered list");
    expect(p).toContain("actionable");
  });
});
