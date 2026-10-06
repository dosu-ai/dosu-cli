import { describe, expect, it } from "vitest";
import { episode, memory, task, trace } from "./fixtures.test-utils";
import { buildReportHtml } from "./html";
import { buildReport } from "./model";
import type { ReportSession } from "./types";

const APP = "https://app.dosu.test";

function session(id: string, overrides: Partial<ReportSession> = {}): ReportSession {
  return {
    sessionId: id,
    harness: "claude",
    project: "dosu",
    shippedAt: "2026-10-01T10:00:00Z",
    state: "complete",
    trace: trace(id),
    ...overrides,
  };
}

function render(sessions: ReportSession[]): string {
  return buildReportHtml(
    buildReport({
      generatedAt: "2026-10-06T12:00:00Z",
      days: 30,
      orgName: "Acme",
      appUrl: APP,
      sessions,
    }),
  );
}

/** Visible text, for wording checks that should not depend on markup. */
function text(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("buildReportHtml", () => {
  it("heads the page with the org, the period, and the totals", () => {
    const html = render([
      session("s1", { trace: trace("s1", [[memory("m1"), ["created"]]]) }),
      session("s2", { state: "processing", trace: trace("s2", [], { status: "processing" }) }),
    ]);

    const visible = text(html);
    expect(visible).toContain("Acme");
    expect(visible).toContain("last 30 days");
    expect(html).toMatch(/data-stat="sessions"[^>]*>[\s\S]*?>2</);
    expect(visible).toContain("1 processed");
    expect(visible).toContain("1 created");
  });

  it("lists each memory once across sessions, linking to it in Dosu with every effect", () => {
    const shared = memory("m-shared", { title: "Where the gateway lives" });
    const html = render([
      session("s1", {
        shippedAt: "2026-10-01T00:00:00Z",
        trace: trace("s1", [[shared, ["created"]]]),
      }),
      session("s2", {
        shippedAt: "2026-10-02T00:00:00Z",
        trace: trace("s2", [[shared, ["confirmed"]]]),
      }),
    ]);

    const section = html.split('id="memories"')[1].split("</section>")[0];
    expect(section.split(`href="${APP}/memories/m-shared"`)).toHaveLength(2);
    expect(text(section)).toContain("Where the gateway lives");
    expect(text(section)).toContain("Created");
    expect(text(section)).toContain("Confirmed");
    expect(text(section)).toContain("2 sessions");
  });

  it("renders each session like the session page: tasks, episodes captured, memories touched", () => {
    const html = render([
      session("s1", {
        trace: trace("s1", [[memory("m1"), ["updated"]]], {
          tasks: [
            task(1, { task_text: "Fix the flaky test", outcome: "partial", summary: "Half done" }),
          ],
          episodes: [episode("e1", { title: "Retry hid the race", episode_kind: "mistake" })],
        }),
      }),
    ]);

    const block = html.split('data-session="s1"')[1];
    const visible = text(block);
    for (const heading of ["Tasks", "Episodes captured", "Memories touched"]) {
      expect(visible).toContain(heading);
    }
    expect(visible).toContain("Fix the flaky test");
    expect(visible).toContain("Partial");
    expect(visible).toContain("Half done");
    expect(visible).toContain("Mistake");
    expect(block).toContain(`href="${APP}/memories/episodes/e1"`);
    expect(block).toContain(`href="${APP}/memories/sessions/s1"`);
    expect(block).toContain(`href="${APP}/memories/traces/trace-s1"`);
  });

  it("explains sessions that are processing, waiting, private, or failed to load", () => {
    const visible = text(
      render([
        session("busy", {
          state: "processing",
          trace: trace("busy", [], { status: "processing" }),
        }),
        session("waiting", { state: "waiting", trace: undefined }),
        session("theirs", { state: "private", trace: undefined }),
        session("broken", { state: "error", trace: undefined, error: "HTTP 500" }),
      ]),
    );

    expect(visible).toContain("Dosu is reading this session");
    expect(visible).toContain("Waiting for this session to be ingested");
    expect(visible).toContain("private to whoever submitted it");
    expect(visible).toContain("Could not load this session (HTTP 500)");
  });

  it("escapes everything that came from a transcript", () => {
    const html = render([
      session("s1", {
        trace: trace("s1", [[memory("m1", { title: "<script>alert(1)</script>" }), ["created"]]]),
      }),
    ]);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("shows redacted episodes as tombstones and invalidated memories as such", () => {
    const visible = text(
      render([
        session("s1", {
          trace: trace("s1", [[memory("m1", { active: false }), ["contradicted"]]], {
            episodes: [episode("e1", { redacted: true, title: "", snippet: "" })],
          }),
        }),
      ]),
    );

    expect(visible).toContain("Redacted by the submitter");
    expect(visible).toContain("Invalidated");
  });

  it("says when nothing was shipped in the period", () => {
    const visible = text(render([]));

    expect(visible).toContain("No sessions shipped to Dosu memory in the last 30 days");
    expect(visible).toContain("dosu knowledge sync");
  });
});
