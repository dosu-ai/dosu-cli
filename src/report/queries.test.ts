import { describe, expect, it } from "vitest";
import { extractUserQueries, sessionTitleFromUserText } from "./queries";

describe("extractUserQueries", () => {
  it("returns every user_query block when tags are present", () => {
    expect(
      extractUserQueries("<user_query>first ask</user_query><user_query>second ask</user_query>"),
    ).toEqual(["first ask", "second ask"]);
  });

  it("falls back to the cleaned text when no tags are present", () => {
    expect(extractUserQueries("plain question <timestamp>2026-09-09</timestamp>")).toEqual([
      "plain question",
    ]);
  });

  it("drops injected scaffolding blocks", () => {
    expect(extractUserQueries("# AGENTS.md\nrepo rules")).toEqual([]);
    expect(extractUserQueries("<INSTRUCTIONS>do things</INSTRUCTIONS>")).toEqual([]);
    expect(
      extractUserQueries("<permissions instructions>ask first</permissions instructions>"),
    ).toEqual([]);
    expect(extractUserQueries("   ")).toEqual([]);
  });
});

describe("sessionTitleFromUserText", () => {
  it("collapses whitespace and truncates long titles with an ellipsis", () => {
    const long = `explain   ${"word ".repeat(30)}`;
    const title = sessionTitleFromUserText(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("returns empty for scaffolding-only text", () => {
    expect(sessionTitleFromUserText("# AGENTS.md\nrules")).toBe("");
  });
});
