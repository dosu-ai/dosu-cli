/**
 * AGENTS.md step — writes a marker-delimited Dosu section into the repo's
 * AGENTS.md during setup so coding agents receive the canonical Dosu
 * knowledge instructions.
 *
 * The section lives between HTML-comment markers so re-running setup updates
 * it in place instead of appending duplicates, and users can freely edit the
 * rest of the file.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { logger } from "../debug/logger";
import { FALLBACK_DOSU_RULE, fetchDosuRule } from "../rules/installer";
import { assertSafeProjectPath } from "./project-root";
import { formatSetupSummary } from "./styles";

/**
 * Bump when the section content changes meaningfully. The version is stamped
 * into the start marker for compatibility across section revisions.
 */
const DOSU_SECTION_VERSION = 3;

export const DOSU_SECTION_START = `<!-- dosu:mcp:start v${DOSU_SECTION_VERSION} -->`;
export const DOSU_SECTION_END = "<!-- dosu:mcp:end -->";

/** Matches any start marker: current, older versions, and the unversioned original. */
const SECTION_START_RE = /<!-- dosu:mcp:start(?: v(\d+))? -->/;

type AgentsMdAction = "created" | "updated" | "unchanged";
type AgentsMdRemoveAction = "removed" | "not_found";

export interface AgentsMdResult {
  path: string;
  action: AgentsMdAction;
}

export interface AgentsMdRemoveResult {
  path: string;
  action: AgentsMdRemoveAction;
}

interface SectionLocation {
  start: number;
  end: number;
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
  const starts = [...content.matchAll(new RegExp(SECTION_START_RE.source, "g"))];
  const ends = [...content.matchAll(new RegExp(DOSU_SECTION_END, "g"))];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || (ends[0]?.index ?? -1) < starts[0].index) {
    throw new Error("Dosu AGENTS.md markers are incomplete; refusing to overwrite the file");
  }
  return { start: starts[0].index, end: ends[0].index };
}

/** Read-only preflight used before a bulk flow performs any project write. */
export function validateAgentsMdMutation(cwd: string): void {
  const path = join(cwd, "AGENTS.md");
  assertSafeProjectPath(cwd, path);
  if (existsSync(path)) findSection(readFileSync(path, "utf-8"));
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
  assertSafeProjectPath(cwd, path);

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

/** Remove only the marker-delimited Dosu section; preserve all user content. */
export function removeDosuAgentsSection(cwd: string = process.cwd()): AgentsMdRemoveResult {
  const path = join(cwd, "AGENTS.md");
  assertSafeProjectPath(cwd, path);
  if (!existsSync(path)) return { path, action: "not_found" };

  const existing = readFileSync(path, "utf-8");
  const location = findSection(existing);
  if (!location) return { path, action: "not_found" };

  const lineEnding = lineEndingFor(existing);
  const next = (
    existing.slice(0, location.start) + existing.slice(location.end + DOSU_SECTION_END.length)
  )
    .replace(/(?:\r?\n){3,}/g, `${lineEnding}${lineEnding}`)
    .replace(/^(?:\r?\n)+/, "")
    .trimEnd();

  if (!next) unlinkSync(path);
  else writeFileSync(path, `${next}${lineEnding}`);
  return { path, action: "removed" };
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

/** Setup-flow wrapper for removing an obsolete project instruction section. */
export function stepRemoveAgentsMd(cwd: string = process.cwd()): boolean {
  logger.info("setup", "Step: remove AGENTS.md section");
  try {
    const result = removeDosuAgentsSection(cwd);
    if (result.action === "removed") {
      p.log.info(formatSetupSummary("AGENTS.md", [{ path: result.path, status: "removed" }]));
    }
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `AGENTS.md removal failed: ${msg}`);
    p.log.error(`Could not remove the Dosu AGENTS.md section: ${msg}`);
    return false;
  }
}
