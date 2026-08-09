import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { browserFallbackHint, dim, formatSetupSummary, IconAdd, IconRemove, info } from "./styles";

describe("styles", () => {
  describe("icons", () => {
    it("defines expected unicode icons", () => {
      expect(IconAdd).toBe("+");
      expect(IconRemove).toBe("-");
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
      expect(summary).toContain("+ Claude Code\n  /tmp/claude/skills/dosu (symlink)");
      expect(summary).toContain("+ Codex CLI\n  /tmp/agents/skills/dosu");
    });

    it("formats an unlabeled path and supports a custom marker", () => {
      expect(
        stripVTControlCharacters(
          formatSetupSummary("AGENTS.md", [
            { path: "/tmp/project/AGENTS.md", status: "already up to date" },
          ]),
        ),
      ).toContain("+ /tmp/project/AGENTS.md (already up to date)");
      expect(
        stripVTControlCharacters(
          formatSetupSummary("Removed", [{ label: "Codex CLI", path: "/tmp/config" }], IconRemove),
        ),
      ).toContain("- Codex CLI\n  /tmp/config");
    });
  });
});
