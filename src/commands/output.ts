/**
 * Shared output formatting utilities for CLI commands.
 */

import pc from "picocolors";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code stripping requires matching control characters
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Print data as JSON (for --json flag / agent consumption) or formatted text.
 */
export function printResult(data: unknown, opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  // Fallback: pretty-print JSON when no custom formatter is used
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Print a table of rows with headers.
 */
export function printTable(
  headers: string[],
  rows: string[][],
  opts: { json?: boolean; rawData?: unknown } = {},
): void {
  if (opts.json && opts.rawData !== undefined) {
    console.log(JSON.stringify(opts.rawData, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(pc.dim("No results found."));
    return;
  }

  // Calculate column widths (strip ANSI codes for accurate visible-width measurement)
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)),
  );

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  console.log(pc.bold(headerLine));
  console.log(pc.dim("─".repeat(headerLine.length)));

  // Print rows (pad based on visible width to handle ANSI escape codes)
  for (const row of rows) {
    console.log(
      row
        .map((cell, i) => {
          const s = cell ?? "";
          const pad = Math.max(0, widths[i] - stripAnsi(s).length);
          return s + " ".repeat(pad);
        })
        .join("  "),
    );
  }
}

/**
 * Print a labeled section with key-value pairs.
 */
export function printInfo(
  entries: Array<[string, string | undefined]>,
  opts: { json?: boolean; rawData?: unknown } = {},
): void {
  if (opts.json && opts.rawData !== undefined) {
    console.log(JSON.stringify(opts.rawData, null, 2));
    return;
  }

  const maxLabel = Math.max(...entries.map(([label]) => label.length));
  for (const [label, value] of entries) {
    if (value !== undefined) {
      console.log(`${pc.bold(label.padEnd(maxLabel))}  ${value}`);
    }
  }
}

/**
 * Truncate a string to a max length, adding ellipsis if needed.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

/**
 * Format a date string into a short readable format.
 */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
