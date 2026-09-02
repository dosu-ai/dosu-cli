import { describe, expect, it } from "vitest";
import { type BannerContext, LOGO_MARK, renderBanner } from "./banner";
import { center, visibleWidth } from "./layout";

const ESC = String.fromCharCode(27);

function makeContext(overrides: Partial<BannerContext> = {}): BannerContext {
  return {
    version: "v0.52.0",
    webAppHost: "app.dosu.dev",
    directory: "dosu-cli",
    signedIn: true,
    agents: [],
    width: 80,
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

describe("center", () => {
  it("pads a line to the middle of the width", () => {
    expect(center("abcd", 10)).toBe("   abcd");
  });

  it("never pads negatively when the line overflows", () => {
    expect(center("abcdefghij", 4)).toBe("abcdefghij");
  });
});

describe("renderBanner", () => {
  it("puts the wordmark and version metadata on one header line", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    const headerLine = banner
      .split("\n")
      .find((line) => line.includes("cli v0.52.0 \u00B7 app.dosu.dev"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("dosu");
    expect(banner).not.toContain("Your team's knowledge");
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
    const shared = banner
      .split("\n")
      .find((line) => line.includes("\u2588\u2588") && line.includes("workspace"));
    expect(shared).toBeDefined();
  });

  it("puts the header beside the top of the logomark, not floating alone", () => {
    const banner = stripAnsi(
      renderBanner(makeContext({ deploymentName: "My Deploy", agents: ["Cursor"] })),
    );
    const headerLine = banner.split("\n").find((line) => line.includes("cli v0.52.0"));
    expect(headerLine).toContain(LOGO_MARK[0]);
  });

  it("shows the wordmark, version, and web app host", () => {
    const banner = stripAnsi(renderBanner(makeContext()));
    expect(banner).toContain("dosu");
    expect(banner).toContain("cli v0.52.0 \u00B7 app.dosu.dev");
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

  it("defaults the width when none is provided", () => {
    const banner = renderBanner(makeContext({ width: undefined }));
    expect(stripAnsi(banner)).toContain("cli v0.52.0");
  });
});
