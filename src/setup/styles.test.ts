import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import {
  brand,
  brandBadge,
  browserFallbackHint,
  dim,
  formatSetupSummary,
  IconAdd,
  IconRemove,
  info,
  wrapLog,
} from "./styles";

describe("wrapLog", () => {
  it("leaves lines that fit alone", () => {
    expect(wrapLog("short line", 80)).toBe("short line");
    expect(wrapLog("a\nb", 80)).toBe("a\nb");
  });

  it("word-wraps to the terminal width minus the clack gutter", () => {
    const wrapped = wrapLog("one two three four five six seven eight nine ten", 24);
    for (const line of wrapped.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
    expect(wrapped.replace(/\n/g, " ")).toBe("one two three four five six seven eight nine ten");
  });

  it("keeps existing newlines and wraps each paragraph independently", () => {
    const wrapped = wrapLog("fits\nthis paragraph is too long to fit on one line", 30);
    expect(wrapped.split("\n")[0]).toBe("fits");
    expect(wrapped.split("\n").length).toBeGreaterThan(2);
  });

  it("does not count ANSI codes toward the width", () => {
    const styled = `${info("dosu knowledge sync")} anytime`;
    // 27 visible chars in a 30-wide (26 usable) terminal: wraps once, at the space.
    expect(wrapLog(styled, 30)).toBe(`${info("dosu knowledge sync")}\nanytime`);
    expect(wrapLog(styled, 40)).toBe(styled);
  });

  it("never wraps narrower than 20 columns and defaults to stdout width", () => {
    const wrapped = wrapLog("aaaa bbbb cccc dddd eeee ffff", 10);
    expect(wrapped).toBe("aaaa bbbb cccc dddd\neeee ffff");
    expect(wrapLog("x")).toBe("x");
  });
});

describe("styles", () => {
  describe("icons", () => {
    it("defines expected unicode icons", () => {
      expect(IconAdd).toBe("\u2714");
      expect(IconRemove).toBe("-");
    });
  });

  describe("brand", () => {
    // Color support differs between local (non-TTY) and CI runs, so assert on the stripped text.
    it("keeps the label intact whatever the color support", () => {
      expect(stripVTControlCharacters(brand("dosu"))).toBe("dosu");
    });

    it("badge wraps the label: padded chip when colored, brackets when not", () => {
      const badge = stripVTControlCharacters(brandBadge("dosu"));
      expect(badge === "[ dosu ]" || badge === " dosu ").toBe(true);
    });
  });

  describe("formatters", () => {
    it("dim returns a string", () => {
      expect(typeof dim("text")).toBe("string");
    });

    it("info returns a string", () => {
      expect(typeof info("text")).toBe("string");
    });

    it("browserFallbackHint puts the URL on its own line", () => {
      const hint = browserFallbackHint("https://example.com/auth?x=1");
      expect(hint).toContain("If your browser doesn't open automatically, visit:\n");
      expect(hint).toContain("https://example.com/auth?x=1");
    });

    it("formats labeled installation paths with optional status", () => {
      const summary = stripVTControlCharacters(
        formatSetupSummary("Skill ready for 2 agent(s):", [
          { label: "Claude Code", path: "/tmp/claude/skills/dosu", status: "symlink" },
          { label: "Codex CLI", path: "/tmp/agents/skills/dosu" },
        ]),
      );

      expect(summary).toContain("Skill ready for 2 agent(s):");
      expect(summary).toContain("\u2714 Claude Code\n  /tmp/claude/skills/dosu (symlink)");
      expect(summary).toContain("\u2714 Codex CLI\n  /tmp/agents/skills/dosu");
    });

    it("formats an unlabeled path and supports a custom marker", () => {
      expect(
        stripVTControlCharacters(
          formatSetupSummary("AGENTS.md", [
            { path: "/tmp/project/AGENTS.md", status: "already up to date" },
          ]),
        ),
      ).toContain("\u2714 /tmp/project/AGENTS.md (already up to date)");
      expect(
        stripVTControlCharacters(
          formatSetupSummary("Removed", [{ label: "Codex CLI", path: "/tmp/config" }], IconRemove),
        ),
      ).toContain("- Codex CLI\n  /tmp/config");
    });
  });
});
