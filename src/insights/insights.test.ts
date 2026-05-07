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
      current: stats({ totalResponses: 50 }),
      combined: stats({ totalResponses: 90 }),
    });
    expect(r.previous.totalResponses).toBe(40);
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

  it("fires onProgress before each slow phase", async () => {
    const stages: string[] = [];
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());
    await buildInsights({
      client: createMockClient() as never,
      cfg,
      ask: okAsk,
      windowDays: 30,
      now: NOW,
      onProgress: (s) => stages.push(s),
    });
    expect(stages).toEqual(["stats", "narrative"]);
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

  it("falls back to 'your space' when name is missing", async () => {
    mockQuery.mockResolvedValueOnce(stats());
    mockQuery.mockResolvedValueOnce(stats());
    const r = await buildInsights({
      client: createMockClient() as never,
      cfg: { ...cfg, deployment_name: undefined },
      ask: okAsk,
      windowDays: 30,
      now: NOW,
    });
    expect(r.spaceName).toBe("your space");
  });

  it("uses /ask answer for atAGlance when available", async () => {
    const r = await build({
      current: stats({ totalResponses: 10 }),
      combined: stats({ totalResponses: 12 }),
      ask: async () => "Custom prose from Dosu.",
    });
    expect(r.atAGlance).toBe("Custom prose from Dosu.");
  });

  it("falls back to a stats-grounded atAGlance when /ask returns null", async () => {
    const r = await build({
      current: stats({
        totalResponses: 10,
        byConfidence: { high: 8, medium: 1, low: 1 },
      }),
      combined: stats({
        totalResponses: 12,
        byConfidence: { high: 9, medium: 2, low: 1 },
      }),
      ask: async () => null,
    });
    expect(r.atAGlance).toContain("10 responses");
    expect(r.atAGlance).toContain("80%");
  });
});

describe("cheers", () => {
  it("welcomes empty spaces", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/brand new/);
  });

  it("celebrates a high high-confidence share", async () => {
    const r = await build({
      current: stats({
        totalResponses: 100,
        byConfidence: { high: 90, medium: 8, low: 2 },
      }),
      combined: stats({
        totalResponses: 100,
        byConfidence: { high: 90, medium: 8, low: 2 },
      }),
    });
    expect(r.cheers.some((c) => /high-confidence/.test(c))).toBe(true);
  });

  it("celebrates dominant high-confidence", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
      combined: stats({
        totalResponses: 30,
        byConfidence: { high: 20, medium: 5, low: 5 },
      }),
    });
    expect(r.cheers.some((c) => /high-confidence/.test(c))).toBe(true);
  });

  it("celebrates positive feedback", async () => {
    const r = await build({
      current: stats({
        totalResponses: 50,
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
        reactions: {
          totalPositive: 9,
          totalNegative: 1,
          messagesWithReactions: 10,
          reactionRate: 0.2,
          positiveRate: 0.9,
        },
      }),
    });
    expect(r.cheers.some((c) => /positive/.test(c))).toBe(true);
  });

  it("celebrates rising volume", async () => {
    const r = await build({
      current: stats({ totalResponses: 80 }),
      combined: stats({ totalResponses: 130 }),
    });
    expect(r.cheers.some((c) => /Volume is up/.test(c))).toBe(true);
  });

  it("does not celebrate 'rising volume' when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 80 }),
      combined: stats({ totalResponses: 80 }),
    });
    expect(r.cheers.some((c) => /Volume is up/.test(c))).toBe(false);
  });

  it("falls back to a generic cheer when no rule fires", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        byConfidence: { high: 5, medium: 10, low: 15 },
      }),
      combined: stats({
        totalResponses: 60,
        byConfidence: { high: 10, medium: 20, low: 30 },
      }),
    });
    expect(r.cheers).toHaveLength(1);
    expect(r.cheers[0]).toMatch(/30 responses logged/);
  });
});

describe("investigate", () => {
  it("is empty for a brand-new space", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.investigate).toHaveLength(0);
  });

  it("flags a meaningful drop in high-confidence share with exact before/after percentages", async () => {
    const r = await build({
      // current: 60/100 = 60% high; previous: 90/100 = 90% high → delta -30 pts
      current: stats({
        totalResponses: 100,
        byConfidence: { high: 60, medium: 20, low: 20 },
      }),
      combined: stats({
        totalResponses: 200,
        byConfidence: { high: 150, medium: 30, low: 20 },
      }),
    });
    expect(r.investigate.some((c) => /High-confidence share dropped from 90% to 60%/.test(c))).toBe(
      true,
    );
  });

  it("flags growing low-confidence count", async () => {
    const r = await build({
      current: stats({
        totalResponses: 40,
        byConfidence: { high: 10, medium: 10, low: 20 },
      }),
      combined: stats({
        totalResponses: 60,
        byConfidence: { high: 20, medium: 20, low: 25 },
      }),
    });
    expect(r.investigate.some((c) => /Low-confidence answers grew/.test(c))).toBe(true);
  });

  it("flags a drop in positive feedback rate with exact before/after percentages", async () => {
    // current: 5 pos / 5 neg → 50%; previous (via subtraction): 9 pos / 1 neg → 90%
    const r = await build({
      current: stats({
        totalResponses: 50,
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
        reactions: {
          totalPositive: 14,
          totalNegative: 6,
          messagesWithReactions: 20,
          reactionRate: 0.2,
          positiveRate: 0.7,
        },
      }),
    });
    expect(r.investigate.some((c) => /Positive feedback fell from 90% to 50%/.test(c))).toBe(true);
  });

  it("flags more negative than positive feedback", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
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
      current: stats({ totalResponses: 30 }),
      combined: stats({ totalResponses: 100 }),
    });
    expect(r.investigate.some((c) => /Volume is down/.test(c))).toBe(true);
  });

  it("flags a low overall high-confidence share independent of trend", async () => {
    const r = await build({
      // current: 8/20 high = 40%; previous: 8/20 high = 40%
      current: stats({
        totalResponses: 20,
        byConfidence: { high: 8, medium: 6, low: 6 },
      }),
      combined: stats({
        totalResponses: 40,
        byConfidence: { high: 16, medium: 12, low: 12 },
      }),
    });
    expect(r.investigate.some((c) => /medium- or low-confidence/.test(c))).toBe(true);
  });

  it("does not flag 'low-confidence growing' when prior window is empty", async () => {
    const r = await build({
      current: stats({
        totalResponses: 20,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
      combined: stats({
        totalResponses: 20,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
    });
    expect(r.investigate.some((c) => /Low-confidence answers grew/.test(c))).toBe(false);
  });

  it("does not flag 'volume is down' when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 5 }),
      combined: stats({ totalResponses: 5 }),
    });
    expect(r.investigate.some((c) => /Volume is down/.test(c))).toBe(false);
  });
});

describe("suggestions", () => {
  it("points empty spaces at setup and a try-it-yourself ask", async () => {
    const r = await build({ current: stats(), combined: stats() });
    expect(r.suggestions).toHaveLength(2);
    expect(r.suggestions[0].command).toBe("dosu setup");
    expect(r.suggestions[1].command).toBe('dosu ask "what is Dosu?"');
  });

  it("suggests auditing low-confidence threads when they grow", async () => {
    const r = await build({
      current: stats({
        totalResponses: 30,
        byConfidence: { high: 5, medium: 10, low: 15 },
      }),
      combined: stats({
        totalResponses: 60,
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

  it("suggests sharing the win when metrics are healthy and volume is high", async () => {
    const r = await build({
      current: stats({
        totalResponses: 100,
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

  it("suggests browsing recent threads when volume is rising", async () => {
    const r = await build({
      current: stats({ totalResponses: 40 }),
      combined: stats({ totalResponses: 50 }),
    });
    const rising = r.suggestions.find((s) => /what your team is asking/.test(s.headline));
    expect(rising?.command).toBe("dosu threads list");
  });

  it("always includes at least one suggestion (fallback)", async () => {
    const r = await build({
      current: stats({ totalResponses: 5 }),
      combined: stats({ totalResponses: 10 }),
    });
    expect(r.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it("does not emit the rising-volume suggestion when prior window is empty", async () => {
    const r = await build({
      current: stats({ totalResponses: 40 }),
      combined: stats({ totalResponses: 40 }),
    });
    expect(r.suggestions.some((s) => /what your team is asking/.test(s.headline))).toBe(false);
  });

  it("audit-low-confidence fires on absolute threshold without '(+X vs prior)' suffix", async () => {
    const r = await build({
      current: stats({
        totalResponses: 20,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
      combined: stats({
        totalResponses: 20,
        byConfidence: { high: 5, medium: 5, low: 10 },
      }),
    });
    const audit = r.suggestions.find((s) => /Audit/.test(s.headline));
    expect(audit).toBeDefined();
    expect(audit?.detail).not.toMatch(/vs prior/);
  });

  it("dedupes suggestions by command so the same CTA never appears twice", async () => {
    // Both audit-low-confidence and rising-volume use `dosu threads list`.
    // Trigger both: low-conf elevated AND volume up >= 10.
    const r = await build({
      current: stats({
        totalResponses: 50,
        byConfidence: { high: 10, medium: 15, low: 25 },
      }),
      combined: stats({
        totalResponses: 80,
        byConfidence: { high: 20, medium: 30, low: 30 },
      }),
    });
    const threadsListCount = r.suggestions.filter((s) => s.command === "dosu threads list").length;
    expect(threadsListCount).toBe(1);
    // Audit wins because it appears earlier in the priority order
    expect(r.suggestions.find((s) => s.command === "dosu threads list")?.headline).toMatch(/Audit/);
  });

  it("caps suggestions at 4 to keep the report scannable", async () => {
    const r = await build({
      // Trigger every rule simultaneously: low-conf grew, positive rate dropped,
      // low high-confidence share, volume rising
      current: stats({
        totalResponses: 50,
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
  const s = stats({
    totalResponses: 10,
    byConfidence: { high: 8, medium: 1, low: 1 },
  });
  const d = {
    highConfidenceRate: 0.8,
    highConfidenceRateDelta: 0.05,
    responsesDelta: 2,
    positiveRateDelta: null,
    hasPriorWindow: true,
  };

  it("buildAtAGlancePrompt embeds the stats", () => {
    const p = buildAtAGlancePrompt(s, d, 30);
    expect(p).toContain("last 30 days");
    expect(p).toContain("10 total responses");
    expect(p).toContain("80% high-confidence share");
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

  it("fallbackAtAGlance handles empty spaces warmly", () => {
    const f = fallbackAtAGlance(
      stats(),
      {
        highConfidenceRate: null,
        highConfidenceRateDelta: null,
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

  it("fallbackAtAGlance omits any volume trend text when deltas are flat", () => {
    const f = fallbackAtAGlance(s, { ...d, responsesDelta: 0 }, 30);
    expect(f).not.toContain("Volume is up");
    expect(f).not.toContain("Volume is down");
  });

  it("fallbackAtAGlance includes positive feedback rate when reactions exist", () => {
    const withReactions = stats({
      totalResponses: 10,
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
