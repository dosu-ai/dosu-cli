/**
 * Setup flow UI helpers and styled output.
 */

import pc from "picocolors";

export const IconAdd = "+";
export const IconRemove = "-";

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
