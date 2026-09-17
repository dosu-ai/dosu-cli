import { describe, expect, it } from "vitest";
import {
  breadcrumb,
  contentWidth,
  frameTopMargin,
  installCenteredLayout,
  layoutMargin,
  padLines,
} from "./layout";

const ESC = String.fromCharCode(27);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

describe("breadcrumb", () => {
  it("joins the trail with › separators, leaf last", () => {
    expect(stripAnsi(breadcrumb(["Home", "Pages", "OAuth tokens"], 64))).toBe(
      "Home \u203A Pages \u203A OAuth tokens",
    );
    expect(stripAnsi(breadcrumb(["Home", "Activity"], 64))).toBe("Home \u203A Activity");
  });

  it("clips a long leaf but keeps the trail whole", () => {
    const line = stripAnsi(breadcrumb(["Home", "Pages", "x".repeat(100)], 40));
    expect(line.startsWith("Home \u203A Pages \u203A ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("\u2026")).toBe(true);
  });

  it("renders a single segment as just the leaf", () => {
    expect(stripAnsi(breadcrumb(["Home"], 64))).toBe("Home");
  });
});

function fakeStream(overrides: Partial<{ isTTY: boolean; columns: number }> = {}) {
  const written: unknown[] = [];
  const stream = {
    isTTY: true,
    columns: 100,
    write(chunk: unknown) {
      written.push(chunk);
      return true;
    },
    ...overrides,
  } as unknown as NodeJS.WriteStream;
  return { stream, written };
}

describe("contentWidth / layoutMargin", () => {
  it("caps the content column and centers it", () => {
    expect(contentWidth(120)).toBe(64);
    expect(layoutMargin(120)).toBe(28);
  });

  it("uses the full terminal when narrow", () => {
    expect(contentWidth(60)).toBe(60);
    expect(layoutMargin(60)).toBe(0);
  });
});

describe("frameTopMargin", () => {
  it("scales with terminal height", () => {
    expect(frameTopMargin(24)).toBe(3);
    expect(frameTopMargin(40)).toBe(5);
  });

  it("clamps to a floor on tiny terminals and a ceiling on tall ones", () => {
    expect(frameTopMargin(10)).toBe(2);
    expect(frameTopMargin(200)).toBe(6);
  });
});

describe("padLines", () => {
  it("indents every rendered line", () => {
    const state = { atLineStart: true };
    expect(padLines("a\nb\n", "  ", state)).toBe("  a\n  b\n");
  });

  it("tracks line starts across calls", () => {
    const state = { atLineStart: true };
    expect(padLines("par", "  ", state)).toBe("  par");
    expect(padLines("tial\nnext", "  ", state)).toBe("tial\n  next");
  });

  it("re-pads after cursor-to-column sequences, passing them through", () => {
    const state = { atLineStart: true };
    // The erase that follows the column reset is held until the pad lands,
    // so the margin cells stay untouched by whatever attributes follow.
    expect(padLines(`x${ESC}[999D${ESC}[Jy`, "  ", state)).toBe(`  x${ESC}[999D  ${ESC}[Jy`);
  });

  it("pads before escape sequences that open a line", () => {
    const state = { atLineStart: true };
    const bg = `${ESC}[48;2;82;164;15m`;
    const reset = `${ESC}[49m`;
    // The badge's background color must not paint the margin: pad first,
    // then the color, then the text.
    expect(padLines(`\n${bg} dosu ${reset}\n`, "  ", state)).toBe(`\n  ${bg} dosu ${reset}\n`);
  });

  it("flushes held escapes when no text follows", () => {
    const state = { atLineStart: true };
    expect(padLines(`${ESC}[?25l`, "  ", state)).toBe(`${ESC}[?25l`);
  });

  it("does not pad after sequences that keep the column", () => {
    const state = { atLineStart: true };
    expect(padLines(`a${ESC}[2Kb`, "  ", state)).toBe(`  a${ESC}[2Kb`);
  });

  it("does not emit padding for empty lines", () => {
    const state = { atLineStart: true };
    expect(padLines("\n\n", "  ", state)).toBe("\n\n");
  });
});

describe("installCenteredLayout", () => {
  it("pads writes and restores the original write", () => {
    const { stream, written } = fakeStream({ columns: 100 });
    const restore = installCenteredLayout(stream);
    stream.write("hello\n");
    expect(written).toEqual([`${" ".repeat(18)}hello\n`]);

    restore();
    stream.write("raw");
    expect(written).toEqual([`${" ".repeat(18)}hello\n`, "raw"]);
  });

  it("passes non-string chunks through untouched", () => {
    const { stream, written } = fakeStream({ columns: 100 });
    const restore = installCenteredLayout(stream);
    const buf = Buffer.from("bytes");
    stream.write(buf);
    expect(written).toEqual([buf]);
    restore();
  });

  it("is a no-op for non-TTY streams", () => {
    const { stream, written } = fakeStream({ isTTY: false });
    installCenteredLayout(stream)();
    stream.write("plain");
    expect(written).toEqual(["plain"]);
  });

  it("is a no-op when the terminal has no room for a margin", () => {
    const { stream, written } = fakeStream({ columns: 64 });
    installCenteredLayout(stream)();
    stream.write("plain");
    expect(written).toEqual(["plain"]);
  });

  it("nested installs share the outer margin", () => {
    const outer = fakeStream({ columns: 100 });
    const restoreOuter = installCenteredLayout(outer.stream);

    const inner = fakeStream({ columns: 100 });
    const restoreInner = installCenteredLayout(inner.stream);
    inner.stream.write("x");
    expect(inner.written).toEqual(["x"]);

    restoreInner();
    outer.stream.write("y");
    expect(outer.written).toEqual([`${" ".repeat(18)}y`]);
    restoreOuter();
  });
});
