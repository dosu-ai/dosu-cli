import { describe, expect, it } from "vitest";
import type { InsightsReport } from "./insights";
import { renderHTML } from "./render-html";

function makeReport(over: Partial<InsightsReport> = {}): InsightsReport {
  return {
    generatedAt: "2026-04-16T12:00:00Z",
    windowDays: 30,
    deploymentName: "Acme Docs",
    current: {
      totalResponses: 100,
      totalWithResponse: 80,
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
      totalWithResponse: 60,
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
      answerRate: 0.8,
      answerRateDelta: 0.05,
      responsesDelta: 20,
      positiveRateDelta: 0.057,
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
  it("includes the deployment name and a doctype", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("Acme Docs");
  });

  it("renders the at-a-glance prose verbatim", () => {
    const html = renderHTML(makeReport({ atAGlance: "Hello world" }));
    expect(html).toContain("Hello world");
  });

  it("escapes HTML in deployment name and at-a-glance prose", () => {
    const html = renderHTML(
      makeReport({
        deploymentName: "Pwn <script>alert(1)</script>",
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
    expect(html).toContain("$ dosu threads list");
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
          answerRate: 0.6,
          answerRateDelta: -0.2,
          responsesDelta: -15,
          positiveRateDelta: -0.1,
        },
      }),
    );
    expect(html).toContain("delta-down");
    expect(html).toContain("▼");
  });

  it("shows 'no change' when a delta is essentially zero", () => {
    const html = renderHTML(
      makeReport({
        derived: { answerRate: 0.8, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
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
          answerRate: 0.8,
          answerRateDelta: 0,
          responsesDelta: -30,
          positiveRateDelta: 0,
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
        derived: { answerRate: 0.8, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
      }),
    );
    expect(html).toContain("→");
  });

  it("uses celebratory flair for high-volume deployments", () => {
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

  it("uses chef's-kiss flair when answer rate is at least 95%", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 30 },
        derived: { answerRate: 0.97, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
      }),
    );
    expect(html).toContain("Almost everything got answered");
  });

  it("uses Day-One flair for empty deployments", () => {
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
        derived: { answerRate: 0.5, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
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
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("renders the headline metric with the response count", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="headline"');
    expect(html).toContain('class="headline-number">100</div>');
    expect(html).toContain("responses answered");
  });

  it("includes a percent change in the headline when prior > 0", () => {
    const html = renderHTML(makeReport());
    // 100 vs 80 → +20 → +25%
    expect(html).toContain("(+25%)");
  });

  it("omits percent change in headline when prior window is empty", () => {
    const html = renderHTML(
      makeReport({
        previous: {
          ...makeReport().previous,
          totalResponses: 0,
        },
        derived: {
          answerRate: 0.8,
          answerRateDelta: null,
          responsesDelta: 100,
          positiveRateDelta: null,
        },
      }),
    );
    // No prior baseline → no percentage
    expect(html).toMatch(/\+100 vs the prior 30 days/);
  });

  it("renders the scorecard with a letter grade and three mini bars", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain('class="scorecard"');
    expect(html).toContain("grade-letter");
    expect(html).toContain("Answer rate");
    expect(html).toContain("High-confidence");
    expect(html).toContain("Sentiment");
  });

  it("hides the scorecard for empty deployments", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 0, totalWithResponse: 0 },
      }),
    );
    expect(html).not.toContain('class="scorecard"');
  });

  it("uses a great grade for healthy deployments", () => {
    const html = renderHTML(makeReport());
    // 80/50/86 → ~72 → B (good tone)
    expect(html).toMatch(/grade-(great|good)/);
  });

  it("uses an alarm grade for struggling deployments", () => {
    const html = renderHTML(
      makeReport({
        current: {
          totalResponses: 50,
          totalWithResponse: 15, // 30% answer rate
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
          answerRate: 0.3,
          answerRateDelta: -0.4,
          responsesDelta: 0,
          positiveRateDelta: -0.5,
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
          totalWithResponse: 0,
          byConfidence: { high: 0, medium: 0, low: 0 },
        },
      }),
    );
    expect(html).not.toContain("Confidence Breakdown");
  });

  it("renders the reactions stacked bar when reactions exist", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/<h2[^>]*>Reactions<\/h2>/);
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
    expect(html).toContain("Answer rate");
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
});
