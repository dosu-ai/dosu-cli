/**
 * TUI welcome banner: the logomark beside a checklist of what this machine
 * has configured, with a dosu-cli badge footer. Pure string rendering.
 */

import pc from "picocolors";
import { brand, brandBadge, hasTruecolor } from "../setup/styles";

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
  /** Setup steps still missing ("Library", "MCP", "agents"); rendered as warning rows. */
  setupMissing?: string[];
  /** Dosu section state in this repo's AGENTS.md; only set inside a git work tree. */
  repoAgentsMd?: "current" | "outdated" | "missing";
  /** True when a knowledge-sync run is mining right now. */
  mining?: boolean;
  /** A newer published version, when the update check found one. */
  update?: { version: string; hint: string };
}

const CHECK = "\u2714";
const CIRCLE = "\u25CB";
const DOT = "\u00B7";

/**
 * Block-art Dosu logomark (the smiling "d") in the two app-icon greens.
 * Five rows is the floor: any smaller and the smile stops reading.
 */
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

/** Aligned lowercase "label   value" rows for the machine state. */
function checklistRows(ctx: BannerContext): string[] {
  const on = brand(CHECK);
  const off = pc.dim(CIRCLE);
  const rows: Array<[string, string]> = [["workspace", ctx.directory]];
  rows.push([
    "account",
    ctx.signedIn ? `${on} signed in` : `${off} ${pc.dim("not signed in \u00B7 run Setup")}`,
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
  else if (ctx.agents.length > 0) rows.push(["agents", `${on} ${ctx.agents.join(` ${DOT} `)}`]);
  if (ctx.mining) {
    rows.push([
      "sync",
      `\u26CF\uFE0F ${brand("mining sessions...")} ${pc.dim(`${DOT} see Activity`)}`,
    ]);
  }
  if (ctx.update) {
    rows.push([
      "update",
      `${pc.yellow(`\u2191 ${ctx.update.version} available`)} ${pc.dim(`${DOT} ${ctx.update.hint}`)}`,
    ]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${pc.dim(label.padEnd(labelWidth))}  ${value}`);
}

const COLUMN_GAP = "   ";

/**
 * Banner lines: logomark left, checklist right, top-aligned, with the
 * dosu-cli badge and dim version/host metadata as the footer.
 */
export function renderBanner(ctx: BannerContext): string {
  const logo = LOGO_ROWS.map(paintLogoRow);
  const text = [
    ...checklistRows(ctx),
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
