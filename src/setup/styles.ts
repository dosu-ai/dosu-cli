/** Setup flow UI helpers and styled output. */

import pc from "picocolors";

export const IconAdd = "\u2714";
export const IconRemove = "-";

/** Dosu brand green rgb(82, 164, 15); 24-bit when the terminal advertises truecolor, else the
 * nearest ANSI green. */
const BRAND_FG = "\u001B[38;2;82;164;15m";
const BRAND_BG = "\u001B[48;2;82;164;15m";
const INK_FG = "\u001B[38;2;14;14;14m";
const RESET_FG = "\u001B[39m";
const RESET_BG = "\u001B[49m";

export function hasTruecolor(): boolean {
  return /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
}

/** Brand-green foreground text. */
export function brand(msg: string): string {
  if (!pc.isColorSupported) return msg;
  return hasTruecolor() ? `${BRAND_FG}${msg}${RESET_FG}` : pc.green(msg);
}

/** The dosu wordmark chip: ink text on a solid brand-green block. */
export function brandBadge(msg: string): string {
  if (!pc.isColorSupported) return `[ ${msg} ]`;
  const label = pc.bold(` ${msg} `);
  return hasTruecolor()
    ? `${BRAND_BG}${INK_FG}${label}${RESET_FG}${RESET_BG}`
    : pc.bgGreen(pc.black(label));
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
  const styled = marker === IconRemove ? pc.red(marker) : brand(marker);
  const lines = items.map((item) => {
    const path = `${item.path}${item.status ? ` (${item.status})` : ""}`;
    return item.label ? `${styled} ${item.label}\n  ${dim(path)}` : `${styled} ${dim(path)}`;
  });
  return `${title}\n${lines.join("\n")}`;
}

/** Fallback hint shown whenever the CLI opens a browser; single source of truth for the copy. */
export function browserFallbackHint(url: string): string {
  return dim(`If your browser doesn't open automatically, visit:\n${url}`);
}

export function info(msg: string): string {
  return pc.cyan(msg);
}
