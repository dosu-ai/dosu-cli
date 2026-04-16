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
    narratives: {
      atAGlance: "You're crushing it this month.",
      topics: "Mostly questions about deployment and onboarding.",
      suggestions: "1. Add a runbook.\n2. Tag answers.",
    },
    cheers: ["Big win this week."],
    ...over,
  };
}

describe("renderHTML", () => {
  it("includes the deployment name and a doctype", () => {
    const html = renderHTML(makeReport());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("Acme Docs");
  });

  it("renders the at-a-glance narrative when provided", () => {
    const html = renderHTML(
      makeReport({ narratives: { atAGlance: "Hello world", topics: null, suggestions: null } }),
    );
    expect(html).toContain("Hello world");
  });

  it("falls back to generated at-a-glance when narrative is null and there are responses", () => {
    const html = renderHTML(
      makeReport({ narratives: { atAGlance: null, topics: null, suggestions: null } }),
    );
    expect(html).toContain("logged 100 responses");
    expect(html).toContain("80% answer rate");
  });

  it("falls back to a welcome at-a-glance when there are no responses", () => {
    const empty = makeReport({
      current: {
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
      },
      derived: {
        answerRate: null,
        answerRateDelta: null,
        responsesDelta: 0,
        positiveRateDelta: null,
      },
      narratives: { atAGlance: null, topics: null, suggestions: null },
    });
    const html = renderHTML(empty);
    expect(html).toContain("brand new");
    expect(html).toContain("Day one");
  });

  it("escapes HTML in deployment name and narratives", () => {
    const html = renderHTML(
      makeReport({
        deploymentName: "Pwn <script>alert(1)</script>",
        narratives: {
          atAGlance: "Look: <img src=x onerror=alert(1)> & co",
          topics: null,
          suggestions: null,
        },
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("renders a confidence bar chart with all three levels", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("High");
    expect(html).toContain("Medium");
    expect(html).toContain("Low");
    expect(html).toContain("Confidence Breakdown");
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
        derived: { answerRate: 0.8, answerRateDelta: 0, responsesDelta: -30, positiveRateDelta: 0 },
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

  it("shows a fallback message when topics narrative is missing", () => {
    const html = renderHTML(
      makeReport({ narratives: { atAGlance: "x", topics: null, suggestions: "y" } }),
    );
    expect(html).toContain("Not enough signal yet to summarize topics");
  });

  it("shows a friendly message when suggestions narrative is missing", () => {
    const html = renderHTML(
      makeReport({ narratives: { atAGlance: "x", topics: "y", suggestions: null } }),
    );
    expect(html).toContain("too busy answering questions");
  });

  it("renders all cheers as list items", () => {
    const html = renderHTML(makeReport({ cheers: ["First", "Second", "Third"] }));
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li>Second</li>");
    expect(html).toContain("<li>Third</li>");
  });

  it("uses a celebratory flair for high-volume deployments", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 1500 },
      }),
    );
    expect(html).toContain("1,000 responses");
  });

  it("uses the triple-digits flair when responses are between 100 and 999", () => {
    const html = renderHTML(
      makeReport({ current: { ...makeReport().current, totalResponses: 250 } }),
    );
    expect(html).toContain("Triple digits");
  });

  it("uses the chef's-kiss flair when answer rate is at least 95%", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 30 },
        derived: { answerRate: 0.97, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
      }),
    );
    expect(html).toContain("Almost everything got answered");
  });

  it("uses the default flair when no rule matches", () => {
    const html = renderHTML(
      makeReport({
        current: { ...makeReport().current, totalResponses: 30 },
        derived: { answerRate: 0.5, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
      }),
    );
    expect(html).toContain("Keep the questions coming");
  });

  it("formats answer-rate delta in percentage points", () => {
    const html = renderHTML(makeReport());
    expect(html).toContain("▲ 5 pts");
  });

  it("renders an em-dash when the answer rate is null", () => {
    const html = renderHTML(
      makeReport({
        current: {
          ...makeReport().current,
          totalResponses: 0,
          totalWithResponse: 0,
        },
        derived: {
          answerRate: null,
          answerRateDelta: null,
          responsesDelta: 0,
          positiveRateDelta: null,
        },
      }),
    );
    expect(html).toContain('class="stat-value">—</div>');
  });

  it("formats the generated date in long form", () => {
    const html = renderHTML(makeReport({ generatedAt: "2026-04-16T12:00:00Z" }));
    expect(html).toMatch(/Apr 1[56]/);
  });

  it("shows a 'no change' delta when delta is essentially zero", () => {
    const html = renderHTML(
      makeReport({
        derived: { answerRate: 0.8, answerRateDelta: 0, responsesDelta: 0, positiveRateDelta: 0 },
      }),
    );
    expect(html).toContain("no change");
  });

  it("formats negative deltas with a down triangle", () => {
    const html = renderHTML(
      makeReport({
        derived: {
          answerRate: 0.8,
          answerRateDelta: -0.1,
          responsesDelta: 0,
          positiveRateDelta: 0,
        },
      }),
    );
    expect(html).toContain("▼ 10 pts");
  });
});
