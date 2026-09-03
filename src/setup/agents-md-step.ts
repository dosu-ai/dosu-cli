/**
 * AGENTS.md step — writes a marker-delimited Dosu section into the repo's
 * AGENTS.md during setup so coding agents receive the canonical Dosu
 * knowledge instructions.
 *
 * The section lives between HTML-comment markers so re-running setup updates
 * it in place instead of appending duplicates, and users can freely edit the
 * rest of the file.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../debug/logger";
import { FALLBACK_DOSU_RULE, fetchDosuRule } from "../rules/installer";
import * as p from "../tui/prompts";
import { formatSetupSummary } from "./styles";

/**
 * Bump when the section content changes meaningfully. The version is stamped
 * into the start marker for compatibility across section revisions.
 */
const DOSU_SECTION_VERSION = 2;

export const DOSU_SECTION_START = `<!-- dosu:mcp:start v${DOSU_SECTION_VERSION} -->`;
export const DOSU_SECTION_END = "<!-- dosu:mcp:end -->";

/** Matches any start marker: current, older versions, and the unversioned original. */
const SECTION_START_RE = /<!-- dosu:mcp:start(?: v(\d+))? -->/;

type AgentsMdAction = "created" | "updated" | "unchanged";

export interface AgentsMdResult {
  path: string;
  action: AgentsMdAction;
}

interface SectionLocation {
  start: number;
  end: number;
}

/**
 * True when `cwd` is inside a git work tree. Gates whether setup offers the
 * AGENTS.md step at all — writing an AGENTS.md into an arbitrary directory
 * (home dir, /tmp) would just be litter.
 */
export function inGitWorkTree(cwd: string = process.cwd()): boolean {
  try {
    // Exits 0 but prints "false" in bare repos and inside .git itself, so
    // the stdout check matters — exit code alone is not enough.
    const stdout = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

/** Repo-level setup state of the Dosu section in this work tree's AGENTS.md. */
export type DosuSectionState = "current" | "outdated" | "missing";

/**
 * Read-only check for the welcome banner: does `cwd`'s AGENTS.md carry the
 * Dosu section, and is it the current revision? Never throws — a malformed
 * or unreadable section reads as "missing", which just points at Setup.
 */
export function dosuAgentsSectionState(cwd: string = process.cwd()): DosuSectionState {
  try {
    const path = join(cwd, "AGENTS.md");
    if (!existsSync(path)) return "missing";
    const content = readFileSync(path, "utf-8");
    const startMatch = content.match(SECTION_START_RE);
    if (!startMatch || !content.includes(DOSU_SECTION_END)) return "missing";
    // An unversioned marker predates versioning entirely.
    return Number(startMatch[1] ?? 0) >= DOSU_SECTION_VERSION ? "current" : "outdated";
  } catch {
    return "missing";
  }
}

function lineEndingFor(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function renderDosuAgentsSection(content: string, lineEnding: "\r\n" | "\n"): string {
  const body = content.trim().replace(/\r?\n/g, lineEnding);
  return `${DOSU_SECTION_START}${lineEnding}${body}${lineEnding}${DOSU_SECTION_END}`;
}

export function buildDosuAgentsSection(content: string = FALLBACK_DOSU_RULE): string {
  return renderDosuAgentsSection(content, "\n");
}

function findSection(content: string): SectionLocation | null {
  const startMatch = content.match(SECTION_START_RE);
  const start = startMatch?.index ?? -1;
  const end = content.indexOf(DOSU_SECTION_END, Math.max(start, 0));

  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start) {
    throw new Error("Dosu AGENTS.md markers are incomplete; refusing to overwrite the file");
  }
  return { start, end };
}

/**
 * Create AGENTS.md with the Dosu section, or upsert the section into an
 * existing file (replace between markers when present, append otherwise).
 */
export function upsertDosuAgentsSection(
  cwd: string = process.cwd(),
  content: string = FALLBACK_DOSU_RULE,
): AgentsMdResult {
  const path = join(cwd, "AGENTS.md");

  if (!existsSync(path)) {
    const section = buildDosuAgentsSection(content);
    writeFileSync(path, `${section}\n`);
    return { path, action: "created" };
  }

  const existing = readFileSync(path, "utf-8");
  const lineEnding = lineEndingFor(existing);
  const section = renderDosuAgentsSection(content, lineEnding);
  const location = findSection(existing);

  let next: string;
  if (location) {
    next =
      existing.slice(0, location.start) +
      section +
      existing.slice(location.end + DOSU_SECTION_END.length);
  } else {
    next = `${existing.trimEnd()}${lineEnding}${lineEnding}${section}${lineEnding}`;
  }

  if (next === existing) return { path, action: "unchanged" };
  writeFileSync(path, next);
  return { path, action: "updated" };
}

/**
 * Setup-flow wrapper: upsert the section and report via clack. Returns
 * `true` when AGENTS.md ends up carrying the Dosu section (including the
 * already-up-to-date case).
 */
export async function stepUpdateAgentsMd(
  cwd: string = process.cwd(),
  content?: string,
): Promise<boolean> {
  logger.info("setup", "Step: update AGENTS.md");
  try {
    const result = upsertDosuAgentsSection(cwd, content ?? (await fetchDosuRule()));
    logger.info("setup", `AGENTS.md ${result.action} at ${result.path}`);
    const status = result.action === "unchanged" ? "already up to date" : result.action;
    p.log.success(formatSetupSummary("AGENTS.md", [{ path: result.path, status }]));
    return true;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `AGENTS.md update failed: ${msg}`);
    p.log.error(`Could not update AGENTS.md: ${msg}`);
    return false;
  }
}
