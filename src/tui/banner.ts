/**
 * TUI welcome screen: a compact one-line header — the dosu wordmark chip
 * sitting next to the tagline — with dim version/host metadata under it and
 * a checklist of what this machine already has configured (workspace,
 * account, mcp, library, agents).
 *
 * Pure string rendering: everything is injectable so tests can assert the
 * layout without a TTY.
 */

import pc from "picocolors";
import { brand, brandBadge } from "../setup/styles";
import { center, centerBlock } from "./layout";

export interface BannerContext {
  /** e.g. "v0.52.0" */
  version: string;
  /** e.g. "app.dosu.dev" */
  webAppHost: string;
  /** Basename of the working directory. */
  directory: string;
  signedIn: boolean;
  /** Selected MCP deployment, when one is locked in. */
  deploymentName?: string;
  /** Library the MCP answers from, when known. */
  libraryName?: string;
  /** Display names of agents that already have Dosu MCP configured. */
  agents: string[];
  /** Terminal columns; defaults to the live terminal (or 80). */
  width?: number;
}

const CHECK = "\u2714";
const CIRCLE = "\u25CB";
const DOT = "\u00B7";

/**
 * Compact block-art rendering of the Dosu logomark — the smiling book from
 * the app icon: page edges along the left spine, smile on the cover. Shown
 * above the wordmark, in brand green.
 */
export const LOGO_MARK: readonly string[] = [
  "▄▄▄▄▄▄▄▄▄▄",
  "█▌      ▐█",
  "█▌ ▀▄▄▀ ▐█",
  "█▌      ▐█",
  "▀▀▀▀▀▀▀▀▀▀",
];

/** Aligned lowercase "label   value" rows for the machine state. */
function checklistRows(ctx: BannerContext): string[] {
  const on = brand(CHECK);
  const off = pc.dim(CIRCLE);
  const rows: Array<[string, string]> = [["workspace", ctx.directory]];
  rows.push([
    "account",
    ctx.signedIn ? `${on} signed in` : `${off} ${pc.dim("not signed in \u00B7 run Setup")}`,
  ]);
  if (ctx.deploymentName) rows.push(["mcp", `${on} ${ctx.deploymentName}`]);
  if (ctx.libraryName) rows.push(["library", `${on} ${ctx.libraryName}`]);
  if (ctx.agents.length > 0) rows.push(["agents", `${on} ${ctx.agents.join(` ${DOT} `)}`]);

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${pc.dim(label.padEnd(labelWidth))}  ${value}`);
}

export function renderBanner(ctx: BannerContext): string {
  const width = ctx.width ?? process.stdout.columns ?? 80;
  const header = `${brandBadge("dosu")}  ${pc.bold("Your team's knowledge, in every AI agent.")}`;
  const meta = pc.dim(`cli ${ctx.version} ${DOT} ${ctx.webAppHost}`);
  const lines = [
    "",
    ...centerBlock(LOGO_MARK.map(brand), width),
    "",
    center(header, width),
    center(meta, width),
    "",
    ...centerBlock(checklistRows(ctx), width),
    "",
  ];
  return lines.join("\n");
}
