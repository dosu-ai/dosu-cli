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

  it("includes a dark-mode media query in the inlined CSS", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("formats the generated date in long form", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/Apr 1[56]/);
  });
});
