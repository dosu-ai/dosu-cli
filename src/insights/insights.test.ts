import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import {
  type AskFn,
  buildAtAGlancePrompt,
  buildInsights,
  fallbackAtAGlance,
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

async function build(opts: { current: UsageStats; combined: UsageStats; ask?: AskFn }) {
  mockQuery.mockResolvedValueOnce(opts.current);
  mockQuery.mockResolvedValueOnce(opts.combined);
  return buildInsights({
    client: createMockClient() as never,
    cfg,
    ask: opts.ask ?? okAsk,
    windowDays: 30,
    now: NOW,
  });
}

describe("buildInsights", () => {
  it("queries current and combined windows", async () => {
    await build({ current: stats(), combined: stats() });
    expect(mockQuery).toHaveBeenNthCalledWith(1, "analytics.getUsageStats", {
      spaceId: "sp1",
      days: 30,
    });
    expect(mockQuery).toHaveBeenNthCalledWith(2, "analytics.getUsageStats", {
      spaceId: "sp1",
      days: 60,
    });
  });

  it("derives previous window via subtraction", async () => {
    const r = await build({
      current: stats({ totalResponses: 50, totalWithResponse: 40 }),
      combined: stats({ totalResponses: 90, totalWithResponse: 70 }),
    });
    expect(r.previous.totalResponses).toBe(40);
    expect(r.previous.totalWithResponse).toBe(30);
  });

  it("clamps subtraction to zero defensively", async () => {
    const r = await build({
      current: stats({ totalResponses: 50 }),
      combined: stats({ totalResponses: 30 }),
    });
    expect(r.previous.totalResponses).toBe(0);
  });

  it("normalizes nullish API responses", async () => {
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
    expect(r.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

  it("falls back to 'your deployment' when name is missing", async () => {
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

  it("uses /ask answer for atAGlance when available", async () => {
    const r = await build({
      current: stats({ totalResponses: 10, totalWithResponse: 8 }),
      combined: stats({ totalResponses: 12, totalWithResponse: 10 }),
      ask: async () => "Custom prose from Dosu.",
    });
    expect(r.atAGlance).toBe("Custom prose from Dosu.");
  });

  it("falls back to a stats-grounded atAGlance when /ask returns null", async () => {
    const r = await build({
      current: stats({ totalResponses: 10, totalWithResponse: 8 }),
      combined: stats({ totalResponses: 12, totalWithResponse: 10 }),
      ask: async () => null,
    });
    // The fallback is always non-null and should reference the real numbers.
    expect(r.atAGlance).toContain("10 responses");
    expect(r.atAGlance).toContain("80%");
  });
});

describe("cheers", () => {
  it("welcomes empty deployments", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/brand new/);
  });

  it("celebrates a high answer rate", async () => {
    const r = await build({
      current: stats({ totalResponses: 100, totalWithResponse: 95 }),
      combined: stats({ totalResponses: 100, totalWithResponse: 95 }),
    });
    expect(r.cheers.some((c) => /answer rate/.test(c))).toBe(true);
  });

  it("celebrates dominant high-confidence", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        totalWithResponse: 28,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
      combined: stats({
        totalResponses: 30,
        totalWithResponse: 28,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
    });
    expect(r.cheers.some((c) => /high-confidence/.test(c))).toBe(true);
  });

  it("celebrates positive feedback", async () => {
    const r = await build({
      current: stats({
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
      combined: stats({
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
    });
    expect(r.cheers.some((c) => /positive feedback/.test(c))).toBe(true);
  });

  it("celebrates rising volume", async () => {
    const r = await build({
      current: stats({ totalResponses: 80, totalWithResponse: 60 }),
      combined: stats({ totalResponses: 130, totalWithResponse: 100 }),
    });
    expect(r.cheers.some((c) => /Volume is up/.test(c))).toBe(true);
  });

  it("does not celebrate 'rising volume' when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 80, totalWithResponse: 60 }),
      combined: stats({ totalResponses: 80, totalWithResponse: 60 }),
    });
    expect(r.cheers.some((c) => /Volume is up/.test(c))).toBe(false);
  });

  it("falls back to a generic cheer when no rule fires", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 10, low: 15 },
      }),
      combined: stats({
        totalResponses: 60,
        totalWithResponse: 30,
        byConfidence: { high: 10, medium: 20, low: 30 },
      }),
    });
    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/30 responses logged/);
  });
});

describe("investigate", () => {
  it("is empty for a brand-new deployment", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.investigate).toHaveLength(0);
  });

  it("flags a meaningful drop in answer rate", async () => {
    const r = await build({
      // current: 60/100 = 60%; previous: 90/100 = 90% → delta -30 pts
      current: stats({ totalResponses: 100, totalWithResponse: 60 }),
      combined: stats({ totalResponses: 200, totalWithResponse: 150 }),
    });
    expect(r.investigate.some((c) => /Answer rate dropped/.test(c))).toBe(true);
  });

  it("flags growing low-confidence count", async () => {
    const r = await build({
      current: stats({
        totalResponses: 40,
        totalWithResponse: 30,
        byConfidence: { high: 10, medium: 10, low: 20 },
      }),
      combined: stats({
        totalResponses: 60,
        totalWithResponse: 50,
        byConfidence: { high: 20, medium: 20, low: 25 },
      }),
    });
    expect(r.investigate.some((c) => /Low-confidence answers grew/.test(c))).toBe(true);
  });

  it("flags a drop in positive feedback rate", async () => {
    const r = await build({
      current: stats({
        totalResponses: 50,
        totalWithResponse: 40,
        reactions: {
          totalPositive: 5,
          totalNegative: 5,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.5,
        },
      }),
      combined: stats({
        totalResponses: 100,
        totalWithResponse: 90,
        reactions: {
          totalPositive: 14,
          totalNegative: 6,
          messagesWithReactions: 20,
          reactionRate: 0.2,
          positiveRate: 0.7,
        },
      }),
    });
    expect(r.investigate.some((c) => /Positive feedback fell/.test(c))).toBe(true);
  });

  it("flags more negative than positive feedback", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        totalWithResponse: 25,
        reactions: {
          totalPositive: 2,
          totalNegative: 5,
          messagesWithReactions: 7,
          reactionRate: 0.23,
          positiveRate: 0.29,
        },
      }),
      combined: stats({
        totalResponses: 30,
        totalWithResponse: 25,
        reactions: {
          totalPositive: 2,
          totalNegative: 5,
          messagesWithReactions: 7,
          reactionRate: 0.23,
          positiveRate: 0.29,
        },
      }),
    });
    expect(r.investigate.some((c) => /negative reactions vs.*positive/.test(c))).toBe(true);
  });

  it("flags a meaningful drop in volume", async () => {
    const r = await build({
      current: stats({ totalResponses: 30, totalWithResponse: 25 }),
      combined: stats({ totalResponses: 100, totalWithResponse: 80 }),
    });
    expect(r.investigate.some((c) => /Volume is down/.test(c))).toBe(true);
  });

  it("flags a low overall answer rate independent of trend", async () => {
    const r = await build({
      current: stats({ totalResponses: 20, totalWithResponse: 8 }),
      combined: stats({ totalResponses: 40, totalWithResponse: 16 }),
    });
    expect(r.investigate.some((c) => /didn't get an answer/.test(c))).toBe(true);
  });

  it("does not flag 'low-confidence growing' when prior window is empty", async () => {
    const r = await build({
      current: stats({
        totalResponses: 20,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
      combined: stats({
        totalResponses: 20,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
    });
    expect(r.investigate.some((c) => /Low-confidence answers grew/.test(c))).toBe(false);
  });

  it("does not flag 'volume is down' when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 5, totalWithResponse: 5 }),
      combined: stats({ totalResponses: 5, totalWithResponse: 5 }),
    });
    expect(r.investigate.some((c) => /Volume is down/.test(c))).toBe(false);
  });
});

describe("suggestions", () => {
  it("recommends setup + integrations for empty deployments", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.suggestions).toHaveLength(2);
    expect(r.suggestions[0].command).toBe("dosu setup");
    expect(r.suggestions[1].command).toBe("dosu integrations");
  });

  it("suggests auditing low-confidence threads when they grow", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        totalWithResponse: 25,
        byConfidence: { high: 5, medium: 10, low: 15 },
      }),
      combined: stats({
        totalResponses: 60,
        totalWithResponse: 50,
        byConfidence: { high: 10, medium: 20, low: 22 },
      }),
    });
    const audit = r.suggestions.find((s) => /Audit/.test(s.headline));
    expect(audit).toBeDefined();
    expect(audit?.command).toBe("dosu threads list");
    expect(audit?.detail).toContain("15");
  });

  it("suggests refreshing sources when positive rate drops", async () => {
    const r = await build({
      current: stats({
        totalResponses: 50,
        totalWithResponse: 40,
        reactions: {
          totalPositive: 5,
          totalNegative: 5,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.5,
        },
      }),
      combined: stats({
        totalResponses: 100,
        totalWithResponse: 90,
        reactions: {
          totalPositive: 14,
          totalNegative: 6,
          messagesWithReactions: 20,
          reactionRate: 0.2,
          positiveRate: 0.7,
        },
      }),
    });
    const refresh = r.suggestions.find((s) => /Refresh/.test(s.headline));
    expect(refresh?.command).toBe("dosu sources list");
  });

  it("suggests investigating unanswered threads when answer rate is low", async () => {
    const r = await build({
      current: stats({ totalResponses: 20, totalWithResponse: 8 }),
      combined: stats({ totalResponses: 40, totalWithResponse: 20 }),
    });
    const inv = r.suggestions.find((s) => /Investigate/.test(s.headline));
    expect(inv?.command).toBe("dosu threads list");
    expect(inv?.detail).toContain("12");
  });

  it("suggests sharing the win when metrics are healthy and volume is high", async () => {
    const r = await build({
      current: stats({
        totalResponses: 100,
        totalWithResponse: 90,
        byConfidence: { high: 80, medium: 8, low: 2 },
        reactions: {
          totalPositive: 9,
          totalNegative: 1,
          messagesWithReactions: 10,
          reactionRate: 0.1,
          positiveRate: 0.9,
        },
      }),
      combined: stats({
        totalResponses: 100,
        totalWithResponse: 90,
        byConfidence: { high: 80, medium: 8, low: 2 },
        reactions: {
          totalPositive: 9,
          totalNegative: 1,
          messagesWithReactions: 10,
          reactionRate: 0.1,
          positiveRate: 0.9,
        },
      }),
    });
    const share = r.suggestions.find((s) => /Share/.test(s.headline));
    expect(share).toBeDefined();
    expect(share?.command).toBeUndefined();
  });

  it("recommends adding a source when volume is rising", async () => {
    const r = await build({
      current: stats({ totalResponses: 40, totalWithResponse: 35 }),
      combined: stats({ totalResponses: 50, totalWithResponse: 42 }),
    });
    const ride = r.suggestions.find((s) => /momentum/.test(s.headline));
    expect(ride?.command).toBe("dosu integrations");
  });

  it("always includes at least one suggestion (fallback)", async () => {
    const r = await build({
      current: stats({ totalResponses: 5, totalWithResponse: 5 }),
      combined: stats({ totalResponses: 10, totalWithResponse: 10 }),
    });
    expect(r.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it("does not emit 'Ride the momentum' when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 40, totalWithResponse: 35 }),
      combined: stats({ totalResponses: 40, totalWithResponse: 35 }),
    });
    expect(r.suggestions.some((s) => /momentum/.test(s.headline))).toBe(false);
  });

  it("audit-low-confidence fires on absolute threshold without '(+X vs prior)' suffix", async () => {
    const r = await build({
      current: stats({
        totalResponses: 20,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
      combined: stats({
        totalResponses: 20,
        totalWithResponse: 15,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
    });
    const audit = r.suggestions.find((s) => /Audit/.test(s.headline));
    expect(audit).toBeDefined();
    expect(audit?.detail).not.toMatch(/vs prior/);
  });

  it("caps suggestions at 4 to keep the report scannable", async () => {
    const r = await build({
      // Trigger every rule simultaneously: low-conf grew, positive rate dropped,
      // low answer rate, volume rising
      current: stats({
        totalResponses: 50,
        totalWithResponse: 25,
        byConfidence: { high: 5, medium: 10, low: 35 },
        reactions: {
          totalPositive: 3,
          totalNegative: 7,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.3,
        },
      }),
      combined: stats({
        totalResponses: 90,
        totalWithResponse: 70,
        byConfidence: { high: 30, medium: 30, low: 30 },
        reactions: {
          totalPositive: 18,
          totalNegative: 2,
          messagesWithReactions: 20,
          reactionRate: 0.22,
          positiveRate: 0.9,
        },
      }),
    });
    expect(r.suggestions.length).toBeLessThanOrEqual(4);
  });
});

describe("at-a-glance helpers", () => {
  const s = stats({ totalResponses: 10, totalWithResponse: 8 });
  const d = {
    answerRate: 0.8,
    answerRateDelta: 0.05,
    responsesDelta: 2,
    positiveRateDelta: null,
    hasPriorWindow: true,
  };

  it("buildAtAGlancePrompt embeds the stats", () => {
    const p = buildAtAGlancePrompt(s, d, 30);
    expect(p).toContain("last 30 days");
    expect(p).toContain("10 total responses");
    expect(p).toContain("80% answer rate");
  });

  it("buildAtAGlancePrompt includes a 'first window' note when prior is empty", () => {
    const p = buildAtAGlancePrompt(s, { ...d, hasPriorWindow: false }, 30);
    expect(p).toMatch(/first 30-day window/);
    expect(p).toMatch(/do NOT compare to a prior period/);
  });

  it("buildAtAGlancePrompt omits the 'first window' note when prior exists", () => {
    const p = buildAtAGlancePrompt(s, d, 30);
    expect(p).not.toMatch(/first 30-day window/);
  });

  it("fallbackAtAGlance handles empty deployments warmly", () => {
    const f = fallbackAtAGlance(
      stats(),
      {
        answerRate: null,
        answerRateDelta: null,
        responsesDelta: 0,
        positiveRateDelta: null,
        hasPriorWindow: false,
      },
      30,
    );
    expect(f).toContain("brand new");
    expect(f).toContain("30 days");
  });

  it("fallbackAtAGlance uses 'first window' copy when prior is empty", () => {
    const f = fallbackAtAGlance(s, { ...d, hasPriorWindow: false, responsesDelta: 10 }, 30);
    expect(f).toContain("first 30-day window");
    expect(f).not.toContain("Volume is up");
  });

  it("fallbackAtAGlance mentions volume rising", () => {
    const f = fallbackAtAGlance(s, { ...d, responsesDelta: 12 }, 30);
    expect(f).toContain("Volume is up 12");
  });

  it("fallbackAtAGlance mentions volume dropping", () => {
    const f = fallbackAtAGlance(s, { ...d, responsesDelta: -7 }, 30);
    expect(f).toContain("Volume is down 7");
  });

  it("fallbackAtAGlance includes positive feedback rate when reactions exist", () => {
    const withReactions = stats({
      totalResponses: 10,
      totalWithResponse: 8,
      reactions: {
        totalPositive: 4,
        totalNegative: 1,
        messagesWithReactions: 5,
        reactionRate: 0.5,
        positiveRate: 0.8,
      },
    });
    const f = fallbackAtAGlance(withReactions, d, 30);
    expect(f).toContain("80% positive feedback");
  });
});
