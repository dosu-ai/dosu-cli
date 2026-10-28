/** Shared output formatting utilities for CLI commands. */

import pc from "picocolors";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code stripping requires matching control characters
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, "");

/** Bun's console.log silently truncates strings beyond 64KB once process.stdout materializes,
 * corrupting large --json payloads; large emissions use process.stdout.write instead. */
const CONSOLE_SAFE_CHARS = 32 * 1024;

function printJSON(data: unknown): void {
  const text = JSON.stringify(data, null, 2);
  if (text.length <= CONSOLE_SAFE_CHARS) {
    console.log(text);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

/** Print data as JSON (for --json flag / agent consumption) or formatted text. */
export function printResult(data: unknown, _opts: { json?: boolean }): void {
  printJSON(data);
}

/** Print a table of rows with headers. */
export function printTable(
  headers: string[],
  rows: string[][],
  opts: { json?: boolean; rawData?: unknown } = {},
): void {
  if (opts.json && opts.rawData !== undefined) {
    printJSON(opts.rawData);
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

/** Truncate a string to a max length, adding ellipsis if needed. */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

/** "3m ago" / "2h 10m ago" for status timestamps; falls back to the raw value. */
export function formatAge(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
