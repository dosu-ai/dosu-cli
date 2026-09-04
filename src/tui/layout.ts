/**
 * Centered terminal layout: patches `stdout.write` to inject a left margin
 * on every rendered line (clack has no indent support), so all TUI output
 * shares one centered content column.
 */

import pc from "picocolors";
import { brand } from "../setup/styles";

const ESC = String.fromCharCode(27);

/** Nominal content-column width; even an 80-column terminal gets a margin. */
const CONTENT_WIDTH = 64;

/** Splits output into line breaks, ANSI escape sequences, and visible text. */
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

/**
 * Blank rows above full-screen frames. A function of the terminal only,
 * never the frame height: true vertical centering jiggled on live updates.
 */
export function frameTopMargin(rows: number = process.stdout.rows ?? 24): number {
  return Math.max(2, Math.min(6, Math.floor(rows / 8)));
}

/**
 * Breadcrumb header ("Home › Pages › <leaf>"): dim trail, bold leaf, leaf
 * clipped so a long title can't push the trail off screen.
 */
export function breadcrumb(segments: readonly string[], width: number = contentWidth()): string {
  const head = segments.slice(0, -1);
  const leaf = segments[segments.length - 1] ?? "";
  const trailWidth = head.reduce((total, segment) => total + segment.length + 3, 0);
  const room = Math.max(8, width - trailWidth);
  const clipped = leaf.length <= room ? leaf : `${leaf.slice(0, room - 1)}\u2026`;
  return head.map((segment) => pc.dim(`${segment} \u203A `)).join("") + pc.bold(clipped);
}

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/** Printable width, ignoring ANSI color codes. */
export function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

/** Padding inside each equal-width tab cell (cells mode). */
const TAB_CELL_PAD = 2;

/**
 * A tab strip shared by the tabbed screens: one row of labels over a rule
 * whose heavier segment sits under the active tab (visible even without
 * color). Spread mode stretches the labels across `width` like flex
 * space-between; cells mode sits them side by side in equal-width cells,
 * each label centered, with the whole active cell underlined.
 */
export function tabStrip<Id extends string>(
  labels: ReadonlyArray<readonly [Id, string]>,
  active: Id,
  width: number,
  { spread = true }: { spread?: boolean } = {},
): [string, string] {
  if (!spread) {
    const cellW = Math.max(...labels.map(([, label]) => label.length)) + 2 * TAB_CELL_PAD;
    let row = "";
    let rule = "";
    for (const [id, label] of labels) {
      const left = Math.floor((cellW - label.length) / 2);
      const cell = " ".repeat(left) + label + " ".repeat(cellW - label.length - left);
      row += id === active ? brand(pc.bold(cell)) : pc.dim(cell);
      rule += id === active ? brand("\u2501".repeat(cellW)) : pc.dim("\u2500".repeat(cellW));
    }
    return [row, rule];
  }
  // Narrow frames fall back to a minimum gap and let the row run long.
  const GAP_MIN = 3;
  const totalLen = labels.reduce((sum, [, label]) => sum + label.length, 0);
  const slots = Math.max(1, labels.length - 1);
  const spare = Math.max(GAP_MIN * slots, width - totalLen);
  const baseGap = Math.floor(spare / slots);
  const bonus = spare % slots; // first `bonus` gaps get one extra column
  let row = "";
  let col = 0;
  let activeStart = 0;
  let activeLen = 0;
  labels.forEach(([id, label], i) => {
    if (i > 0) {
      const gap = baseGap + (i <= bonus ? 1 : 0);
      row += " ".repeat(gap);
      col += gap;
    }
    if (id === active) {
      activeStart = col;
      activeLen = label.length;
      row += brand(pc.bold(label));
    } else {
      row += pc.dim(label);
    }
    col += label.length;
  });
  const tail = Math.max(0, width - activeStart - activeLen);
  const rule =
    pc.dim("\u2500".repeat(activeStart)) +
    brand("\u2501".repeat(activeLen)) +
    pc.dim("\u2500".repeat(tail));
  return [row, rule];
}

/** Center a multi-line block as a unit so its rows stay left-aligned. */
export function centerBlock(lines: readonly string[], width: number): string[] {
  const blockWidth = Math.max(...lines.map(visibleWidth));
  const pad = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
  return lines.map((line) => pad + line);
}

/**
 * Indent every rendered line by `pad`. Escapes at a line start are held back
 * so the pad lands before them (a leading background color would paint the margin).
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
 * Patch `stream.write` to center all interactive output; returns a restore
 * function. No-ops on non-TTY, no-margin, or already-installed layouts.
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
