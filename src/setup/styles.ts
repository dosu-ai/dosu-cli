/**
 * Setup flow UI helpers and styled output.
 *
 * Equivalent to Go's internal/setup/styles.go
 */

import pc from "picocolors";

export const IconSuccess = "\u2714"; // ✔
export const IconError = "\u2716"; // ✖
export const IconWarning = "\u26A0"; // ⚠
export const IconQuestion = "?";
export const IconAdd = "+";
export const IconRemove = "-";
export const IconCursor = "\u276F"; // ❯

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

export function bold(msg: string): string {
  return pc.bold(msg);
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
