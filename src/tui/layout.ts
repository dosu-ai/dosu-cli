/**
 * Centered terminal layout.
 *
 * Clack renders its prompts anchored to column 0 with no indent support, so
 * to center the TUI and setup wizard we patch `stdout.write` and inject a
 * left margin at the start of every rendered line. The injector understands
 * the cursor-control sequences clack emits when it re-renders a prompt
 * (cursor-left + erase + rewrite), so redrawn frames get re-padded too.
 *
 * Everything shares one nominal content column (`CONTENT_WIDTH`); the margin
 * centers that column in the terminal, and the banner centers itself within
 * it, so all output lines up.
 */

const ESC = String.fromCharCode(27);

/**
 * Nominal width of the centered content column. Narrow enough that the
 * clack rail sits near the terminal's center, and that even a standard
 * 80-column terminal gets a visible margin.
 */
const CONTENT_WIDTH = 64;

/**
 * Splits terminal output into newlines, carriage returns, ANSI escape
 * sequences (including private modes like cursor hide/show), and runs of
 * visible text.
 */
const TOKEN_PATTERN = new RegExp(`(\r\n|\r|\n|${ESC}\\[[0-9;?]*[A-Za-z])`);

/** Escape finals that move the cursor back to a known column (line start). */
const COLUMN_RESET_FINALS = new Set(["D", "G", "H", "f"]);

let active = false;

/** Width of the content column for the current terminal. */
export function contentWidth(columns: number = process.stdout.columns ?? 80): number {
  return Math.min(columns, CONTENT_WIDTH);
}

/** Left margin that centers the content column in the terminal. */
export function layoutMargin(columns: number = process.stdout.columns ?? 80): number {
  return Math.max(0, Math.floor((columns - contentWidth(columns)) / 2));
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/** Printable width, ignoring ANSI color codes. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

/** Center a (possibly colored) line within `width` columns. */
export function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return " ".repeat(pad) + text;
}

/** Center a multi-line block as a unit so its rows stay left-aligned. */
export function centerBlock(lines: readonly string[], width: number): string[] {
  const blockWidth = Math.max(...lines.map(visibleWidth));
  const pad = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
  return lines.map((line) => pad + line);
}

/**
 * Indent every rendered line of `text` by `pad`, tracking line starts across
 * calls via the returned state. Exposed for tests.
 *
 * Escape sequences seen at a line start are held back until the first
 * visible text so the pad lands *before* them — otherwise a line that opens
 * with a background color (e.g. the wordmark badge) would paint the whole
 * margin green.
 */
export function padLines(text: string, pad: string, state: { atLineStart: boolean }): string {
  let out = "";
  let held = "";
  for (const part of text.split(TOKEN_PATTERN)) {
    if (part === "") continue;
    if (part === "\n" || part === "\r" || part === "\r\n") {
      out += held + part;
      held = "";
      state.atLineStart = true;
    } else if (part.startsWith(`${ESC}[`)) {
      if (state.atLineStart) held += part;
      else out += part;
      if (COLUMN_RESET_FINALS.has(part[part.length - 1])) state.atLineStart = true;
    } else {
      if (state.atLineStart) {
        out += pad + held;
        held = "";
        state.atLineStart = false;
      }
      out += part;
    }
  }
  return out + held;
}

/**
 * Patch `stream.write` so all interactive output renders in a centered
 * column. Returns a restore function. No-ops (and restores nothing) when the
 * stream isn't a TTY, the terminal is too narrow for a margin, or a centered
 * layout is already installed (nested flows share the outer margin).
 */
export function installCenteredLayout(stream: NodeJS.WriteStream = process.stdout): () => void {
  if (active || !stream.isTTY) return () => {};
  const margin = layoutMargin(stream.columns ?? 80);
  if (margin === 0) return () => {};

  active = true;
  const pad = " ".repeat(margin);
  const original = stream.write;
  const state = { atLineStart: true };

  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== "string") {
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }
    return (original as (...args: unknown[]) => boolean).call(
      stream,
      padLines(chunk, pad, state),
      ...rest,
    );
  }) as typeof stream.write;

  return () => {
    stream.write = original;
    active = false;
  };
}
