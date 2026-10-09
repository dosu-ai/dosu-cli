import { describe, expect, it } from "vitest";
import { brandBadge } from "../setup/styles";
import { type BannerContext, bannerWidth, LOGO_MARK, renderBanner, wrapValue } from "./banner";
import { layoutMargin, visibleWidth } from "./layout";

const ESC = String.fromCharCode(27);

function makeContext(overrides: Partial<BannerContext> = {}): BannerContext {
  return {
    version: "v0.52.0",
    webAppHost: "app.dosu.dev",
    directory: "dosu-cli",
    signedIn: true,
    agents: [],
    ...overrides,
  };
}

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

describe("visibleWidth", () => {
  it("ignores ANSI color codes", () => {
    expect(visibleWidth(`${ESC}[32mdosu${ESC}[0m`)).toBe(4);
    expect(visibleWidth("plain")).toBe(5);
  });
});

describe("renderBanner", () => {
  it("leads with the workspace row beside the top of the logo, metadata elsewhere", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    const titleLine = banner
      .split("\n")
      .find((line) => line.includes("workspace") && line.includes(LOGO_MARK[0]));
    expect(titleLine).toBeDefined();
    expect(titleLine).not.toContain("v0.52.0");
    expect(banner).not.toContain("Your team's knowledge");
  });

  it("renders the dosu-cli wordmark in the footer as the brand badge", () => {
    // Compare against brandBadge itself so the assertion holds with or
    // without color support in the test environment.
    const banner = renderBanner(makeContext());
    expect(banner).toContain(`${brandBadge("dosu-cli")} `);
    const footer = stripAnsi(banner)
      .split("\n")
      .find((line) => line.includes("v0.52.0"));
    expect(footer).toContain("dosu-cli");
    expect(footer).toContain("v0.52.0 \u00B7 app.dosu.dev");
  });

  it("shows the logomark block art", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    for (const row of LOGO_MARK) {
      expect(banner).toContain(row);
    }
  });

  it("lays the logomark out beside the checklist, not above it", () => {
    const banner = stripAnsi(
      renderBanner(makeContext({ deploymentName: "My Deploy", agents: ["Cursor"] })),
    );
    // Workspace leads beside the logo's top row; account sits beside the ██ rows.
    const workspaceShared = banner
      .split("\n")
      .find((line) => line.includes(LOGO_MARK[0]) && line.includes("workspace"));
    const accountShared = banner
      .split("\n")
      .find((line) => line.includes("\u2588\u2588") && line.includes("account"));
    expect(workspaceShared).toBeDefined();
    expect(accountShared).toBeDefined();
  });

  it("puts the version metadata as a footer under the checklist", () => {
    const banner = stripAnsi(
      renderBanner(makeContext({ deploymentName: "My Deploy", agents: ["Cursor"] })),
    );
    const lines = banner.split("\n");
    const metaIndex = lines.findIndex((line) => line.includes("v0.52.0"));
    const agentsIndex = lines.findIndex((line) => line.includes("agents"));
    expect(metaIndex).toBeGreaterThan(agentsIndex);
  });

  it("shows the wordmark, version, and web app host", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    expect(banner).toContain("dosu-cli");
    expect(banner).toContain("v0.52.0 \u00B7 app.dosu.dev");
  });

  it("shows the workspace row", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    expect(banner).toContain("workspace");
    expect(banner).toContain("dosu-cli");
  });

  it("marks the account row signed in or out", () => {
    expect(stripAnsi(renderBanner(makeContext({ signedIn: true })))).toContain("signed in");
    expect(stripAnsi(renderBanner(makeContext({ signedIn: false })))).toContain(
      "not signed in \u00B7 run Setup",
    );
  });

  it("flags an expired session over a stale signed-in token", () => {
    const expired = stripAnsi(renderBanner(makeContext({ signedIn: true, sessionExpired: true })));
    const accountRow = expired.split("\n").find((line) => line.includes("account"));
    expect(accountRow).toContain("session expired \u00B7 run Log in");
    expect(accountRow).not.toContain("signed in");
  });

  it("includes mcp and agent rows only when configured", () => {
    const bare = stripAnsi(renderBanner(makeContext()));
    expect(bare).not.toContain("mcp");
    expect(bare).not.toContain("agents");

    const full = stripAnsi(
      renderBanner(makeContext({ deploymentName: "My Deploy", agents: ["Cursor", "Claude Code"] })),
    );
    expect(full).toContain("mcp");
    expect(full).toContain("My Deploy");
    expect(full).toContain("Cursor \u00B7 Claude Code");
  });

  it("includes the library row only when a library name is known", () => {
    expect(stripAnsi(renderBanner(makeContext()))).not.toContain("library");

    const withLibrary = stripAnsi(renderBanner(makeContext({ libraryName: "Main Library" })));
    expect(withLibrary).toContain("library");
    expect(withLibrary).toContain("Main Library");
  });

  it("warns per missing setup step instead of omitting the row", () => {
    const interrupted = stripAnsi(renderBanner(makeContext({ setupMissing: ["Library", "MCP"] })));
    expect(interrupted).toContain("mcp");
    expect(interrupted).toContain("library");
    const warnRows = interrupted
      .split("\n")
      .filter((line) => line.includes("not configured \u00B7 run Setup"));
    expect(warnRows).toHaveLength(2);
  });

  it("shows the repo row only when a work-tree state is known", () => {
    expect(stripAnsi(renderBanner(makeContext()))).not.toContain("repo");

    const current = stripAnsi(renderBanner(makeContext({ repoAgentsMd: "current" })));
    expect(current).toContain("repo");
    expect(current).toContain("AGENTS.md has the Dosu section");

    const missing = stripAnsi(renderBanner(makeContext({ repoAgentsMd: "missing" })));
    expect(missing).toContain("AGENTS.md missing the Dosu section \u00B7 run Setup");

    const outdated = stripAnsi(renderBanner(makeContext({ repoAgentsMd: "outdated" })));
    expect(outdated).toContain("AGENTS.md Dosu section outdated \u00B7 run Setup");
  });

  it("lets a missing step outrank a stale display name", () => {
    // A deployment name left over from an old target must not read as
    // configured while the MCP step is missing.
    const banner = stripAnsi(
      renderBanner(makeContext({ deploymentName: "Old Deploy", setupMissing: ["MCP"] })),
    );
    const mcpRow = banner.split("\n").find((line) => line.includes("mcp"));
    expect(mcpRow).toContain("not configured");
    expect(mcpRow).not.toContain("Old Deploy");
  });

  it("anchors every row to the same left edge (no per-block centering)", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    const rows = banner.split("\n").filter((line) => line.trim() !== "");
    expect(rows[0].startsWith(LOGO_MARK[0])).toBe(true);
  });

  it("includes the sync row only when a study run is active", () => {
    expect(stripAnsi(renderBanner(makeContext()))).not.toContain("studying sessions");

    const active = stripAnsi(renderBanner(makeContext({ studying: true })));
    expect(active).toContain("sync");
    expect(active).toContain("\uD83D\uDCDA studying sessions... \u00B7 see activity");
  });

  it("includes the update row only when a newer version is known", () => {
    expect(stripAnsi(renderBanner(makeContext()))).not.toContain("update");

    const withUpdate = stripAnsi(
      renderBanner(makeContext({ update: { version: "0.53.0", hint: 'Run "dosu upgrade"' } })),
    );
    expect(withUpdate).toContain("update");
    expect(withUpdate).toContain("\u2191 0.53.0 available");
    expect(withUpdate).toContain('Run "dosu upgrade"');
  });

  describe("agents row wrapping", () => {
    const agents = [
      "Claude Code",
      "Claude Desktop",
      "Cursor",
      "VS Code",
      "Codex (CLI + Desktop)",
      "GitHub Copilot CLI",
    ];

    it("keeps every line within the given width, wrapping the agent list at separators", () => {
      const width = 90;
      const banner = stripAnsi(renderBanner(makeContext({ agents }), width));
      const lines = banner.split("\n");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      // Every agent is still named, and none was split mid-name.
      for (const agent of agents) expect(banner).toContain(agent);
      const agentLines = lines.filter((line) => agents.some((a) => line.includes(a)));
      expect(agentLines.length).toBeGreaterThan(1);
      // Continuation lines carry no label and start at the value column, under the check mark
      // (the logomark may still occupy the left of the row).
      const valueColumn = agentLines[0].indexOf("\u2714");
      const firstNameColumn = (line: string) =>
        Math.min(...agents.map((a) => line.indexOf(a)).filter((i) => i >= 0));
      for (const line of agentLines.slice(1)) {
        expect(line).not.toContain("agents");
        expect(firstNameColumn(line)).toBe(valueColumn);
        expect(line.slice(0, valueColumn).trimEnd().endsWith("\u00B7")).toBe(false);
      }
    });

    it("wraps any long row, not just agents", () => {
      const banner = stripAnsi(
        renderBanner(makeContext({ deploymentName: "A deployment with a very long name" }), 50),
      );
      const lines = banner.split("\n");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
      // The name spans two rows; strip the logomark column before joining them back up.
      const checklist = lines.map((line) => line.slice(LOGO_MARK[0].length + 2).trim());
      expect(checklist.join(" ")).toContain("A deployment with a very long name");
    });

    it("leaves a list that fits on one line alone", () => {
      const banner = stripAnsi(renderBanner(makeContext({ agents }), 200));
      const agentLines = banner.split("\n").filter((line) => line.includes("Claude Code"));
      expect(agentLines).toHaveLength(1);
      expect(agentLines[0]).toContain(agents.join(" \u00B7 "));
    });

    it("still names every agent in a terminal too narrow to lay them out", () => {
      const banner = stripAnsi(renderBanner(makeContext({ agents }), 10));
      const flat = banner.replace(/\s+/g, " ");
      for (const agent of agents) expect(flat).toContain(agent);
    });
  });
});

describe("wrapValue", () => {
  it("packs list items greedily at the separator", () => {
    expect(wrapValue("aa \u00B7 bb \u00B7 cc \u00B7 dd", 7)).toEqual([
      "aa \u00B7 bb",
      "cc \u00B7 dd",
    ]);
  });

  it("keeps a multi-word item whole when it fits on its own line", () => {
    expect(wrapValue("short \u00B7 a long agent name \u00B7 x", 17)).toEqual([
      "short",
      "a long agent name",
      "x",
    ]);
  });

  it("falls back to breaking an item at spaces only when it alone overflows", () => {
    expect(wrapValue("one two three", 7)).toEqual(["one two", "three"]);
  });

  it("measures visible width, carrying ANSI codes along with their word", () => {
    const green = (s: string) => `${ESC}[32m${s}${ESC}[39m`;
    expect(wrapValue(`${green("\u2714")} aa \u00B7 bb`, 4)).toEqual([
      `${green("\u2714")} aa`,
      "bb",
    ]);
  });

  it("returns the input as one line when there is nothing to wrap", () => {
    expect(wrapValue("", 10)).toEqual([""]);
    expect(wrapValue("fits", 10)).toEqual(["fits"]);
  });
});

describe("bannerWidth", () => {
  it("spans from the centered layout's left margin to one short of the right edge", () => {
    expect(bannerWidth(128)).toBe(128 - layoutMargin(128) - 1);
    // At 64 columns or fewer there is no margin, so the whole row minus one is usable.
    expect(bannerWidth(64)).toBe(63);
  });
});
