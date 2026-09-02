/**
 * TUI welcome screen: the logomark sitting beside a compact header — the dosu
 * wordmark chip with dim version/host metadata — and a checklist of what this
 * machine already has configured (workspace, account, mcp, library, agents).
 *
 * Pure string rendering: everything is injectable so tests can assert the
 * layout without a TTY.
 */

import pc from "picocolors";
import { brand, brandBadge, hasTruecolor } from "../setup/styles";
import { centerBlock } from "./layout";

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
 * Compact block-art rendering of the Dosu logomark — the smiling "d" from
 * `logomark.svg` in the marketing site — colored like the app icon rather
 * than flat brand green: sage page edges along the spine, cream cover and
 * smile, darker moss bottom page block. Five rows is the floor: any smaller
 * and the smile stops reading.
 */
type LogoTone = "cream" | "sage" | "moss";

const LOGO_ROWS: ReadonlyArray<ReadonlyArray<readonly [LogoTone, string]>> = [
  [["cream", "▄▄▄▄▄▄"]],
  [
    ["sage", "██"],
    ["cream", "    ▀▄"],
  ],
  [
    ["sage", "██"],
    ["cream", "▀▄▄▄▀█"],
  ],
  [
    ["sage", "██"],
    ["cream", "   ▄▄▀"],
  ],
  [["moss", "█████▀"]],
];

/** Plain (uncolored) rows of the logomark, for tests and no-color terminals. */
export const LOGO_MARK: readonly string[] = LOGO_ROWS.map((row) =>
  row.map(([, art]) => art).join(""),
);

const LOGO_WIDTH = Math.max(...LOGO_MARK.map((row) => row.length));

/** App-icon palette (`dosu-icon.svg`): cream #F3F6F1, sage #B4BB91, moss #778561. */
const LOGO_TONES: Record<LogoTone, { fg: string; fallback: (art: string) => string }> = {
  cream: { fg: "\u001B[38;2;243;246;241m", fallback: pc.white },
  sage: { fg: "\u001B[38;2;180;187;145m", fallback: pc.green },
  moss: { fg: "\u001B[38;2;119;133;97m", fallback: (art) => pc.dim(pc.green(art)) },
};

function paintLogoRow(row: ReadonlyArray<readonly [LogoTone, string]>): string {
  return row
    .map(([tone, art]) => {
      if (!pc.isColorSupported) return art;
      const { fg, fallback } = LOGO_TONES[tone];
      return hasTruecolor() ? `${fg}${art}\u001B[39m` : fallback(art);
    })
    .join("");
}

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

const COLUMN_GAP = "   ";

/**
 * Banner lines: the logomark on the left, the header + checklist column on
 * the right, both top-aligned so the header sits beside the top of the logo
 * and every text row shares the same left edge. Side by side keeps the
 * welcome screen about half the height of stacking the logo above the text.
 */
export function renderBanner(ctx: BannerContext): string {
  const width = ctx.width ?? process.stdout.columns ?? 80;
  const logo = LOGO_ROWS.map(paintLogoRow);
  const text = [
    `${brandBadge("dosu")}  ${pc.dim(`cli ${ctx.version} ${DOT} ${ctx.webAppHost}`)}`,
    "",
    ...checklistRows(ctx),
  ];

  const height = Math.max(logo.length, text.length);
  const combined: string[] = [];
  for (let i = 0; i < height; i += 1) {
    const logoRow = logo[i] ?? "";
    const logoPad = " ".repeat(LOGO_WIDTH - (LOGO_MARK[i]?.length ?? 0));
    const textRow = text[i] ?? "";
    combined.push(`${logoRow}${logoPad}${COLUMN_GAP}${textRow}`.trimEnd());
  }

  return ["", ...centerBlock(combined, width), ""].join("\n");
}
