/**
 * Setup flow UI helpers and styled output.
 */

import pc from "picocolors";

export const IconSuccess = "\u2714"; // ✔
export const IconError = "\u2716"; // ✖
export const IconWarning = "\u26A0"; // ⚠
export const IconQuestion = "?";
export const IconAdd = "+";
export const IconRemove = "-";

export function success(msg: string): string {
  return pc.green(`${IconSuccess} ${msg}`);
}

export function error(msg: string): string {
  return pc.red(`${IconError} ${msg}`);
}

export function warning(msg: string): string {
  return pc.yellow(`${IconWarning} ${msg}`);
}

export function question(msg: string): string {
  return pc.yellow(`${IconQuestion} ${msg}`);
}

export function dim(msg: string): string {
  return pc.dim(msg);
}

export interface SetupSummaryItem {
  label?: string;
  path: string;
  status?: string;
}

export function formatSetupSummary(
  title: string,
  items: readonly SetupSummaryItem[],
  marker: string = IconAdd,
): string {
  const lines = items.map((item) => {
    const path = `${item.path}${item.status ? ` (${item.status})` : ""}`;
    return item.label ? `${marker} ${item.label}\n  ${dim(path)}` : `${marker} ${dim(path)}`;
  });
  return `${title}\n${lines.join("\n")}`;
}

export function bold(msg: string): string {
  return pc.bold(msg);
}

/**
 * Muted fallback hint shown whenever the CLI opens a browser, so a closed or
 * missing browser isn't a dead end. Single source of truth for the copy —
 * print via `console.log` in plain flows or `p.log.message` in clack flows.
 */
export function browserFallbackHint(url: string): string {
  return dim(`If your browser doesn't open automatically, visit:\n${url}`);
}

export function info(msg: string): string {
  return pc.cyan(msg);
}

export function printSuccess(msg: string): void {
  console.log(success(msg));
}

export function printError(msg: string): void {
  console.log(error(msg));
}

export function printWarning(msg: string): void {
  console.log(warning(msg));
}

export function printBox(...lines: string[]): void {
  const maxLen = Math.max(...lines.map((l) => l.length));
  const border = dim("-".repeat(maxLen));
  console.log(border);
  for (const line of lines) {
    console.log(info(line));
  }
  console.log(border);
}
