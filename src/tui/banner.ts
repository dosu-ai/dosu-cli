/** TUI welcome banner: logomark, configured checklist, badge footer. Pure string rendering. */

import pc from "picocolors";
import { brand, brandBadge, hasTruecolor } from "../setup/styles";
import { layoutMargin, visibleWidth } from "./layout";

export interface BannerContext {
  /** e.g. "v0.52.0" */
  version: string;
  /** e.g. "app.dosu.dev" */
  webAppHost: string;
  /** Basename of the working directory. */
  directory: string;
  signedIn: boolean;
  /** Signed in on disk, but the server rejected the refresh: only a new login helps. */
  sessionExpired?: boolean;
  /** Selected MCP deployment, when one is locked in. */
  deploymentName?: string;
  /** Library the MCP answers from, when known. */
  libraryName?: string;
  /** Display names of agents that already have Dosu MCP configured. */
  agents: string[];
  /** Setup steps still missing ("Library", "MCP", "agents", "hooks"); rendered as warning rows. */
  setupMissing?: string[];
  /** Dosu section state in this repo's AGENTS.md; only set inside a git work tree. */
  repoAgentsMd?: "current" | "outdated" | "missing";
  /** True when a knowledge-sync run is studying right now. */
  studying?: boolean;
  /** A newer published version, when the update check found one. */
  update?: { version: string; hint: string };
}

const CHECK = "\u2714";
const CIRCLE = "\u25CB";
const DOT = "\u00B7";

/** Block-art Dosu logomark; five rows is the floor, any smaller and the smile stops reading. */
type LogoTone = "sage" | "moss";

const LOGO_ROWS: ReadonlyArray<ReadonlyArray<readonly [LogoTone, string]>> = [
  [["sage", "▄▄▄▄▄▄"]],
  [["sage", "██    ▀▄"]],
  [["sage", "██▀▄▄▄▀█"]],
  [["sage", "██   ▄▄▀"]],
  [["moss", "█████▀"]],
];

/** Plain (uncolored) rows of the logomark, for tests and no-color terminals. */
export const LOGO_MARK: readonly string[] = LOGO_ROWS.map((row) =>
  row.map(([, art]) => art).join(""),
);

const LOGO_WIDTH = Math.max(...LOGO_MARK.map((row) => row.length));

/** App-icon palette (`dosu-icon.svg`): sage #B4BB91, moss #778561. */
const LOGO_TONES: Record<LogoTone, { fg: string; fallback: (art: string) => string }> = {
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

/** Gap between the logomark and the checklist, and between a label and its value. */
const COLUMN_GAP = "   ";
const LABEL_GAP = "  ";
const LIST_SEP = ` ${DOT} `;

/** Wrap a row value to `room` visible columns. Breaks at ` · ` list separators first, and inside
 * an item at spaces only when that item alone is wider than the room, so a multi-word name like
 * "Codex (CLI + Desktop)" stays whole whenever it can. ANSI codes ride along with their word and
 * count for nothing. */
export function wrapValue(text: string, room: number): string[] {
  const lines: string[] = [];
  let current = "";
  const append = (piece: string, sep: string) => {
    if (current === "") current = piece;
    else if (visibleWidth(current) + sep.length + visibleWidth(piece) <= room) {
      current += sep + piece;
    } else {
      lines.push(current);
      current = piece;
    }
  };
  for (const item of text.split(LIST_SEP)) {
    const pieces = visibleWidth(item) <= room ? [item] : item.split(" ");
    pieces.forEach((piece, i) => {
      append(piece, i === 0 ? LIST_SEP : " ");
    });
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [text];
}

/** Aligned lowercase "label   value" rows for the machine state. A value that would run past
 * `width` columns wraps onto continuation lines under the value column; left to the terminal, it
 * would wrap to column 0, outside the centered layout's margin. */
function checklistRows(ctx: BannerContext, width: number): string[] {
  const on = brand(CHECK);
  const off = pc.dim(CIRCLE);
  const rows: Array<[string, string]> = [["workspace", ctx.directory]];
  rows.push([
    "account",
    ctx.sessionExpired
      ? `${off} ${pc.yellow("session expired")} ${pc.dim(`${DOT} run Log in`)}`
      : ctx.signedIn
        ? `${on} signed in`
        : `${off} ${pc.dim(`not signed in ${DOT} run Setup`)}`,
  ]);
  // A missing setup step outranks a stale display name.
  const missing = new Set(ctx.setupMissing ?? []);
  const warnRow = `${off} ${pc.yellow("not configured")} ${pc.dim(`${DOT} run Setup`)}`;
  if (missing.has("MCP")) rows.push(["mcp", warnRow]);
  else if (ctx.deploymentName) rows.push(["mcp", `${on} ${ctx.deploymentName}`]);
  if (missing.has("Library")) rows.push(["library", warnRow]);
  else if (ctx.libraryName) rows.push(["library", `${on} ${ctx.libraryName}`]);
  if (ctx.repoAgentsMd) {
    rows.push([
      "repo",
      ctx.repoAgentsMd === "current"
        ? `${on} AGENTS.md has the Dosu section`
        : `${off} ${pc.yellow(
            ctx.repoAgentsMd === "outdated"
              ? "AGENTS.md Dosu section outdated"
              : "AGENTS.md missing the Dosu section",
          )} ${pc.dim(`${DOT} run Setup`)}`,
    ]);
  }
  if (missing.has("agents")) rows.push(["agents", warnRow]);
  else if (ctx.agents.length > 0) rows.push(["agents", `${on} ${ctx.agents.join(LIST_SEP)}`]);
  if (missing.has("hooks")) rows.push(["hooks", warnRow]);
  if (ctx.studying) {
    rows.push([
      "sync",
      `\uD83D\uDCDA ${brand("studying sessions...")} ${pc.dim(`${DOT} see activity`)}`,
    ]);
  }
  if (ctx.update) {
    rows.push([
      "update",
      `${pc.yellow(`\u2191 ${ctx.update.version} available`)} ${pc.dim(`${DOT} ${ctx.update.hint}`)}`,
    ]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueColumn = LOGO_WIDTH + COLUMN_GAP.length + labelWidth + LABEL_GAP.length;
  const room = Math.max(1, width - valueColumn);
  const indent = " ".repeat(labelWidth + LABEL_GAP.length);
  return rows.flatMap(([label, value]) =>
    wrapValue(value, room).map((line, i) =>
      i === 0 ? `${pc.dim(label.padEnd(labelWidth))}${LABEL_GAP}${line}` : `${indent}${line}`,
    ),
  );
}

/** Columns a banner line may use: everything right of the centered layout's left margin, less
 * one so a line that exactly fills the terminal doesn't trigger auto-wrap. */
export function bannerWidth(columns: number = process.stdout.columns ?? 80): number {
  return columns - layoutMargin(columns) - 1;
}

/** Banner lines: logomark left, checklist right, top-aligned, badge and metadata footer. */
export function renderBanner(ctx: BannerContext, width: number = bannerWidth()): string {
  const logo = LOGO_ROWS.map(paintLogoRow);
  const text = [
    ...checklistRows(ctx, width),
    "",
    `${brandBadge("dosu-cli")} ${pc.dim(`${ctx.version} ${DOT} ${ctx.webAppHost}`)}`,
  ];

  const height = Math.max(logo.length, text.length);
  const combined: string[] = [];
  for (let i = 0; i < height; i += 1) {
    const logoRow = logo[i] ?? "";
    const logoPad = " ".repeat(LOGO_WIDTH - (LOGO_MARK[i]?.length ?? 0));
    const textRow = text[i] ?? "";
    combined.push(`${logoRow}${logoPad}${COLUMN_GAP}${textRow}`.trimEnd());
  }

  // Left-anchored: self-centering made the banner drift as checklist rows changed.
  return ["", ...combined, ""].join("\n");
}
