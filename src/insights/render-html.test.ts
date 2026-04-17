import { describe, expect, it } from "vitest";
import type { InsightsReport } from "./insights";
import { renderHTML } from "./render-html";

function makeReport(over: Partial<InsightsReport> = {}): InsightsReport {
  return {
    generatedAt: "2026-04-16T12:00:00Z",
    windowDays: 30,
    spaceName: "Acme Docs",
    current: {
      totalResponses: 100,
      byConfidence: { high: 50, medium: 20, low: 10 },
      reactions: {
        totalPositive: 30,
        totalNegative: 5,
        messagesWithReactions: 35,
        reactionRate: 0.35,
        positiveRate: 0.857,
      },
    },
    previous: {
      totalResponses: 80,
      byConfidence: { high: 40, medium: 20, low: 10 },
      reactions: {
        totalPositive: 20,
        totalNegative: 5,
        messagesWithReactions: 25,
        reactionRate: 0.31,
        positiveRate: 0.8,
      },
    },
    derived: {
      highConfidenceRate: 0.625,
      highConfidenceRateDelta: 0.125,
      responsesDelta: 20,
      positiveRateDelta: 0.057,
      hasPriorWindow: true,
    },
    atAGlance: "You're crushing it this month.",
    cheers: ["Big win this week."],
    investigate: [],
    suggestions: [
      {
        headline: "Audit recent low-confidence answers",
        detail: "10 answers had low confidence this window.",
        command: "dosu threads list",
      },
    ],
    ...over,
  };
}

describe("renderHTML", () => {
  it("includes the space name and a doctype", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("Acme Docs");
  });

  it("renders the at-a-glance prose verbatim", () => {
    const html = renderHTML(makeReport({ atAGlance: "Hello world" }));
    expect(html).toContain("Hello world");
  });

  it("escapes HTML in space name and at-a-glance prose", () => {
    const html = renderHTML(
      makeReport({
        spaceName: "Pwn <script>alert(1)</script>",
        atAGlance: "Look: <img src=x onerror=alert(1)> & co",
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders both signal cards when both lists have entries", () => {
    const html = renderHTML(
      makeReport({
        cheers: ["Yay!"],
        investigate: ["Hmm."],
      }),
    );
    expect(html).toContain('class="signal-card signal-cheers"');
    expect(html).toContain('class="signal-card signal-investigate"');
    expect(html).toContain("Yay!");
    expect(html).toContain("Hmm.");
  });

  it("omits the cheers card when there are no cheers", () => {
    const html = renderHTML(makeReport({ cheers: [], investigate: ["Hmm."] }));
    expect(html).not.toContain('class="signal-card signal-cheers"');
    expect(html).toContain('class="signal-card signal-investigate"');
  });

  it("omits the investigate card when there are no investigate items", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="signal-card signal-cheers"');
    expect(html).not.toContain('class="signal-card signal-investigate"');
  });

  it("omits the entire signals section when both lists are empty", () => {
    const html = renderHTML(makeReport({ cheers: [], investigate: [] }));
    expect(html).not.toContain('class="signals"');
  });

  it("renders each suggestion as an article with headline, detail, and CTA", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("Audit recent low-confidence answers");
    expect(html).toContain("10 answers had low confidence");
    expect(html).toContain("dosu threads list");
    // CTA uses a terminal-prompt accent
    expect(html).toContain('class="cta-prompt"');
  });

  it("omits the CTA block for suggestions with no command", () => {
    const html = renderHTML(
      makeReport({
        suggestions: [{ headline: "Just FYI", detail: "Nothing to do, just sharing." }],
      }),
    );
    expect(html).toContain("Just FYI");
    expect(html).not.toContain('class="suggestion-cta"');
  });

  it("omits the suggestions section entirely when empty", () => {
    const html = renderHTML(makeReport({ suggestions: [] }));
    expect(html).not.toContain("Suggested Next Steps");
  });

  it("renders a confidence bar chart with all three levels", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("High");
    expect(html).toContain("Medium");
    expect(html).toContain("Low");
    expect(html).toContain("Confidence Breakdown");
  });

  it("color-codes positive deltas as 'up'", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("delta-up");
    expect(html).toContain("▲");
  });

  it("color-codes negative deltas as 'down'", () => {
    const html = renderHTML(
      makeReport({
        derived: {
          highConfidenceRate: 0.4,
          highConfidenceRateDelta: -0.2,
          responsesDelta: -15,
          positiveRateDelta: -0.1,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("delta-down");
    expect(html).toContain("▼");
  });

  it("shows 'no change' when a delta is essentially zero", () => {
    const html = renderHTML(
      makeReport({
        derived: {
          highConfidenceRate: 0.8,
          highConfidenceRateDelta: 0,
          responsesDelta: 0,
          positiveRateDelta: 0,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("no change");
    expect(html).toContain("delta-flat");
  });

  it("shows the trend with a positive arrow when responses are up", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("trend-up");
    expect(html).toContain("↑");
    expect(html).toContain("(+20)");
  });

  it("shows a down arrow when responses dropped", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 50 },
        derived: {
          highConfidenceRate: 0.8,
          highConfidenceRateDelta: 0,
          responsesDelta: -30,
          positiveRateDelta: 0,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("trend-down");
    expect(html).toContain("↓");
    expect(html).toContain("(-30)");
  });

  it("shows a flat arrow when responses match the prior window", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 80 },
        derived: {
          highConfidenceRate: 0.8,
          highConfidenceRateDelta: 0,
          responsesDelta: 0,
          positiveRateDelta: 0,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("→");
  });

  it("uses celebratory flair for high-volume spaces", () => {
    const html = renderHTML(
      makeReport({ current: { ...makeReport().current, totalResponses: 1500 } }),
    );
    expect(html).toContain("1,000 responses");
  });

  it("uses triple-digits flair when responses are 100-999", () => {
    const html = renderHTML(
      makeReport({ current: { ...makeReport().current, totalResponses: 250 } }),
    );
    expect(html).toContain("Triple digits");
  });

  it("uses chef's-kiss flair when high-confidence share is at least 90%", () => {
    const html = renderHTML(
      makeReport({
        current: {
          ...makeReport().current,
          totalResponses: 30,
          byConfidence: { high: 29, medium: 1, low: 0 },
        },
        derived: {
          highConfidenceRate: 0.97,
          highConfidenceRateDelta: 0,
          responsesDelta: 0,
          positiveRateDelta: 0,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("Almost every response landed with high confidence");
  });

  it("uses Day-One flair for empty spaces", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 0 },
      }),
    );
    expect(html).toContain("Day one");
  });

  it("uses default flair when no rule matches", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 30 },
        derived: {
          highConfidenceRate: 0.5,
          highConfidenceRateDelta: 0,
          responsesDelta: 0,
          positiveRateDelta: 0,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("Keep the questions coming");
  });

  it("escapes HTML in suggestion content", () => {
    const html = renderHTML(
      makeReport({
        suggestions: [
          {
            headline: "<script>x</script>",
            detail: "Run <bad>",
            command: "dosu & co",
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("dosu &amp; co");
  });

  it("does not include a dark-mode media query (always-light)", () => {
    const html = renderHTML(makeReport());
    expect(html).not.toContain("prefers-color-scheme: dark");
  });

  it("renders a terminal-prompt brand line with a blinking cursor", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="prompt"');
    expect(html).toContain("dosu insights");
    expect(html).toContain('class="cursor"');
    // The blink keyframes power the cursor animation
    expect(html).toContain("@keyframes blink");
  });

  it("includes a time-of-day greeting in the subtitle", () => {
    // 12:00 UTC → 04:00 PT (depending on test runner TZ this can land in
    // various hour buckets, but the structure is constant).
    const html = renderHTML(makeReport());
    expect(html).toMatch(
      /(Late )?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (morning|afternoon|evening|night)/,
    );
  });

  it("falls back to 'Snapshot' when generatedAt is unparseable", () => {
    const html = renderHTML(makeReport({ generatedAt: "not-a-date" }));
    expect(html).toContain("Snapshot");
  });

  it("section headings render as plain text without decorative emoji", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('<h2 class="section-heading">Confidence Breakdown</h2>');
    expect(html).toContain('<h2 class="section-heading">Suggested Next Steps</h2>');
    expect(html).toContain('<h2 class="section-heading">Period Comparison</h2>');
    expect(html).toContain('<h2 class="section-heading">Reactions</h2>');
    expect(html).not.toContain("section-icon");
    expect(html).not.toContain("signal-icon");
  });

  it("varies the headline label by count", () => {
    // count=99 → 99 % 3 = 0 → "responses logged"
    expect(
      renderHTML(makeReport({ current: { ...makeReport().current, totalResponses: 99 } })),
    ).toContain("responses logged");
    // count=100 → 100 % 3 = 1 → "questions handled"
    expect(
      renderHTML(makeReport({ current: { ...makeReport().current, totalResponses: 100 } })),
    ).toContain("questions handled");
    // count=101 → 101 % 3 = 2 → "threads fielded"
    expect(
      renderHTML(makeReport({ current: { ...makeReport().current, totalResponses: 101 } })),
    ).toContain("threads fielded");
  });

  it("shows the stable latest.html path in the fun-ending footer", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="fun-path"');
    expect(html).toContain("~/.config/dosu-cli/insights/latest.html");
  });

  it("provides hover transitions on suggestion + chart cards", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain(".suggestion:hover");
    expect(html).toContain(".stacked-bar-card:hover");
    expect(html).toContain(".compare-card:hover");
  });

  it("respects prefers-reduced-motion by disabling animations", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("prefers-reduced-motion");
  });

  it("renders the headline metric with the response count", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="headline"');
    expect(html).toContain('class="headline-number">100</div>');
    expect(html).toMatch(/responses logged|questions handled|threads fielded/);
  });

  it("includes a percent change in the headline when prior > 0", () => {
    const html = renderHTML(makeReport());
    // 100 vs 80 → +20 → +25%
    expect(html).toContain("(+25%)");
  });

  it("replaces headline delta with 'first N days of data' when prior window is empty", () => {
    const html = renderHTML(
      makeReport({
        previous: {
          ...makeReport().previous,
          totalResponses: 0,
        },
        derived: {
          highConfidenceRate: 0.625,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: false,
        },
      }),
    );
    expect(html).toContain("first 30 days of data");
    expect(html).not.toMatch(/vs the prior 30 days/);
    expect(html).not.toMatch(/▲ \+?100/);
  });

  it("omits the trend section entirely when prior window is empty", () => {
    const html = renderHTML(
      makeReport({
        previous: { ...makeReport().previous, totalResponses: 0 },
        derived: {
          highConfidenceRate: 0.625,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: false,
        },
      }),
    );
    expect(html).not.toMatch(/<div class="trend trend-/);
  });

  it("replaces the comparison table with a 'not enough history' card when prior is empty", () => {
    const html = renderHTML(
      makeReport({
        previous: { ...makeReport().previous, totalResponses: 0 },
        derived: {
          highConfidenceRate: 0.625,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: false,
        },
      }),
    );
    expect(html).toContain("Period Comparison");
    expect(html).toContain("Not enough history yet");
    expect(html).not.toMatch(/<table class="compare-table"/);
  });

  it("shows em-dash for responses/day and a hint when prior is empty", () => {
    const html = renderHTML(
      makeReport({
        previous: { ...makeReport().previous, totalResponses: 0 },
        derived: {
          highConfidenceRate: 0.625,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: false,
        },
      }),
    );
    expect(html).toContain("needs 30d of history");
    expect(html).not.toContain("3.3");
  });

  it("renders the scorecard with a letter grade and mini bars", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="scorecard"');
    expect(html).toContain("grade-letter");
    expect(html).not.toContain("Answer rate");
    expect(html).toContain("High-confidence");
    expect(html).toContain("Sentiment");
  });

  it("hides the scorecard for empty spaces", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 0 },
      }),
    );
    expect(html).not.toContain('class="scorecard"');
  });

  it("uses a great grade for healthy spaces", () => {
    const html = renderHTML(makeReport());
    // 80/50/86 → ~72 → B (good tone)
    expect(html).toMatch(/grade-(great|good)/);
  });

  it("excludes sentiment from the grade when no reactions exist and shows — in the mini-bar", () => {
    // conf = 90/100 = 0.9, no sentiment → score = round(0.9 * 100) = 90 → A+ Outstanding
    const html = renderHTML(
      makeReport({
        current: {
          totalResponses: 100,
          byConfidence: { high: 90, medium: 9, low: 0 },
          reactions: {
            totalPositive: 0,
            totalNegative: 0,
            messagesWithReactions: 0,
            reactionRate: 0,
            positiveRate: 0,
          },
        },
        derived: {
          highConfidenceRate: 0.9,
          highConfidenceRateDelta: 0,
          responsesDelta: 0,
          positiveRateDelta: null,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain('<div class="grade-score">90 / 100</div>');
    expect(html).toContain('<div class="grade-letter">A+</div>');
    expect(html).toContain("no reactions yet — excluded from grade");
    // The Sentiment mini-bar specifically renders "—", not the old 70% magic number
    expect(html).toMatch(
      /<span class="mini-label">Sentiment<\/span>\s*<span class="mini-value">—<\/span>/,
    );
    expect(html).not.toContain("neutral default");
  });

  it("uses an alarm grade for struggling spaces", () => {
    const html = renderHTML(
      makeReport({
        current: {
          totalResponses: 50,
          byConfidence: { high: 2, medium: 5, low: 8 },
          reactions: {
            totalPositive: 1,
            totalNegative: 9,
            messagesWithReactions: 10,
            reactionRate: 0.2,
            positiveRate: 0.1,
          },
        },
        derived: {
          highConfidenceRate: 0.04,
          highConfidenceRateDelta: -0.4,
          responsesDelta: 0,
          positiveRateDelta: -0.5,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toContain("grade-alarm");
  });

  it("renders a stacked confidence bar with all three segments", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="stacked-bar"');
    expect(html).toContain("seg-high");
    expect(html).toContain("seg-med");
    expect(html).toContain("seg-low");
    expect(html).toContain("Confidence Breakdown");
  });

  it("omits the confidence section when there are no answers to bucket", () => {
    const html = renderHTML(
      makeReport({
        current: {
          ...makeReport().current,
          totalResponses: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
        },
      }),
    );
    expect(html).not.toContain("Confidence Breakdown");
  });

  it("renders the reactions stacked bar when reactions exist", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/<h2[^>]*>[\s\S]*?Reactions<\/h2>/);
    expect(html).toContain("positive");
    expect(html).toContain("negative");
  });

  it("shows an empty card for reactions when none have been logged", () => {
    const html = renderHTML(
      makeReport({
        current: {
          ...makeReport().current,
          reactions: {
            totalPositive: 0,
            totalNegative: 0,
            messagesWithReactions: 0,
            reactionRate: 0,
            positiveRate: 0,
          },
        },
      }),
    );
    expect(html).toContain("empty-card");
    expect(html).toContain("No reactions logged yet");
  });

  it("renders the period-comparison table with current and prior columns", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="compare-table"');
    expect(html).toContain("This window");
    expect(html).toContain("Prior window");
    expect(html).toContain("Responses");
    expect(html).toContain("High-confidence share");
    expect(html).toContain("Negative reactions");
  });

  it("color-codes a rising metric as up in the comparison table", () => {
    const html = renderHTML(makeReport());
    // Responses 100 vs 80 → +20 (up is good)
    expect(html).toMatch(/delta-up[^>]*>▲ \+20</);
  });

  it("color-codes a rising negative-reaction count as down (bad)", () => {
    const html = renderHTML(
      makeReport({
        current: {
          ...makeReport().current,
          reactions: {
            ...makeReport().current.reactions,
            totalNegative: 12,
          },
        },
        previous: {
          ...makeReport().previous,
          reactions: {
            ...makeReport().previous.reactions,
            totalNegative: 5,
          },
        },
      }),
    );
    // Negative going up is bad → 'down' tone
    expect(html).toMatch(/delta-down[^>]*>▲ \+7</);
  });

  it("includes responses-per-day and reactions tally in the stats row", () => {
    const html = renderHTML(makeReport());
    // 100 / 30 → 3.3
    expect(html).toContain("3.3");
    expect(html).toContain("Responses / day");
    expect(html).toContain("👍");
    expect(html).toContain("👎");
  });

  it("formats the generated date in long form", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/Apr 1[56]/);
  });

  describe("pickGreeting time-of-day branches", () => {
    // Build an ISO string that parses back to the given local hour, regardless
    // of the runner's timezone (pickGreeting uses Date.getHours()).
    function localIsoAtHour(hour: number): string {
      const d = new Date();
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    }

    it("uses 'Late [day] night' for early-morning hours under 5", () => {
      const html = renderHTML(makeReport({ generatedAt: localIsoAtHour(3) }));
      expect(html).toMatch(
        /Late (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) night ·/,
      );
    });

    it("uses a morning greeting for hours 5 to 11", () => {
      const html = renderHTML(makeReport({ generatedAt: localIsoAtHour(9) }));
      expect(html).toMatch(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) morning ·/);
      expect(html).not.toContain("Late ");
    });

    it("uses an afternoon greeting for hours 12 to 16", () => {
      const html = renderHTML(makeReport({ generatedAt: localIsoAtHour(14) }));
      expect(html).toMatch(
        /(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) afternoon ·/,
      );
    });

    it("uses an evening greeting for hours 17 to 20", () => {
      const html = renderHTML(makeReport({ generatedAt: localIsoAtHour(19) }));
      expect(html).toMatch(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) evening ·/);
    });

    it("uses a bare '[day] night' greeting for hours 21 and up", () => {
      const html = renderHTML(makeReport({ generatedAt: localIsoAtHour(22) }));
      expect(html).toMatch(/(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) night ·/);
      expect(html).not.toMatch(
        /Late (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) night/,
      );
    });
  });

  it("shows em-dash in the stats row when highConfidenceRate is null", () => {
    const html = renderHTML(
      makeReport({
        current: {
          totalResponses: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
          reactions: {
            totalPositive: 0,
            totalNegative: 0,
            messagesWithReactions: 0,
            reactionRate: 0,
            positiveRate: 0,
          },
        },
        derived: {
          highConfidenceRate: null,
          highConfidenceRateDelta: null,
          responsesDelta: 0,
          positiveRateDelta: null,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toMatch(
      /<div class="stat-value">—<\/div>\s*<div class="stat-label">High-confidence<\/div>/,
    );
  });

  it("omits the headline percent when hasPriorWindow but prior total is 0", () => {
    const html = renderHTML(
      makeReport({
        previous: { ...makeReport().previous, totalResponses: 0 },
        derived: {
          highConfidenceRate: 0.625,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toMatch(/▲ \+100 vs the prior 30 days/);
    expect(html).not.toMatch(/▲ \+100 \(\+?\d+%\)/);
  });

  it("formats responses/day to two decimals when below 1.0", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 15 },
      }),
    );
    // 15 / 30 = 0.5 → "0.50"
    expect(html).toMatch(
      /<div class="stat-value">0\.50<\/div>\s*<div class="stat-label">Responses \/ day<\/div>/,
    );
  });

  it("shows em-dash for the prior high-confidence share when previous total is 0", () => {
    const html = renderHTML(
      makeReport({
        previous: {
          totalResponses: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
          reactions: {
            totalPositive: 0,
            totalNegative: 0,
            messagesWithReactions: 0,
            reactionRate: 0,
            positiveRate: 0,
          },
        },
        derived: {
          highConfidenceRate: 0.5,
          highConfidenceRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
          hasPriorWindow: true,
        },
      }),
    );
    expect(html).toMatch(/High-confidence share[\s\S]*?<td class="num prior">—<\/td>/);
  });
});
