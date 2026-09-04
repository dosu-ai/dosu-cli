import { describe, expect, it } from "vitest";
import { brandBadge } from "../setup/styles";
import { type BannerContext, LOGO_MARK, renderBanner } from "./banner";
import { visibleWidth } from "./layout";

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

  it("includes the sync row only when a mining run is active", () => {
    expect(stripAnsi(renderBanner(makeContext()))).not.toContain("mining sessions");

    const active = stripAnsi(renderBanner(makeContext({ mining: true })));
    expect(active).toContain("sync");
    expect(active).toContain("\u26CF\uFE0F mining sessions... \u00B7 see Activity");
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
});
