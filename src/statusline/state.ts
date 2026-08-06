/**
 * Status-line state: how much Dosu knowledge the session last received.
 *
 * Written from inside `dosu hooks post-tool-use` / `stop` (which already run on
 * the agent's hot path and hold the knowledge payloads) and rendered by the
 * embedded Python status-line script. Two delivery paths feed it:
 *
 *  1. Explicit `read_knowledge` MCP tool calls — counted from the PostToolUse
 *     payload's `tool_response`.
 *  2. Hook-injected knowledge — counted from the ticket result context at each
 *     delivery point (PostToolUse injection, Stop, late harvest).
 *
 * Everything here is best-effort and must never throw into the hook hot path:
 * the row is purely cosmetic. State files self-prune after 7 days — nothing
 * else cleans the directory up.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../debug/logger";
import { writeSecureFile } from "../mcp/config-helpers";

const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Distinct documents, so a doc matching at several line ranges counts once. */
const PAGE_RE = /url="(https:\/\/app\.dosu\.dev\/[^"]+)"/g;
/** One per branch note. UUID-shaped, so note prose can't produce a false match. */
const NOTE_RE = /^author_id: [0-9a-f-]{36}\s*$/gm;
/** Oversized tool results are offloaded to disk; the response is just a pointer. */
const OFFLOAD_RE = /saved to (?<path>\/\S+\.txt)/;

/** Must match the STATE_DIR baked into the Python status-line script. */
export function knowledgeStateDir(home: string = homedir()): string {
  return join(home, ".dosu", "statusline-state");
}

export function knowledgeStatePath(sessionId: string, home: string = homedir()): string {
  return join(knowledgeStateDir(home), `${sessionId}.knowledge.json`);
}

export interface KnowledgeCounts {
  pages: number;
  notes: number;
}

/** Coerce an MCP tool response of unknown shape into searchable text. */
function unwrap(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["result", "content", "text"]) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string") return v;
    }
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Undo JSON string escaping if the text arrived as raw JSON. */
function normalize(text: string): string {
  if (!text.includes('\\"') && !text.includes("\\n")) return text;
  return text.replaceAll("\\n", "\n").replaceAll('\\"', '"');
}

/**
 * The searchable text of a tool response, following an offload pointer when
 * present. Every real repo+branch lookup measured took the offload path (the
 * payloads reach ~140KB), and the on-disk copy is raw JSON with escaped quotes
 * — a truncated file falls back to matching against the escaped text.
 */
export function loadToolResponseText(toolResponse: unknown): string {
  const text = unwrap(toolResponse);
  const hit = OFFLOAD_RE.exec(text);
  const path = hit?.groups?.path;
  if (!path || !existsSync(path)) return normalize(text);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return normalize(text);
  }
  try {
    return unwrap(JSON.parse(raw));
  } catch {
    return normalize(raw); // truncated or partial file
  }
}

/** Distinct knowledge pages, and branch notes from the notes section only. */
export function countKnowledge(text: string): KnowledgeCounts {
  const pages = new Set<string>();
  for (const m of text.matchAll(PAGE_RE)) pages.add(m[1]);
  // Notes are returned only when the lookup had both repo and branch; the
  // notes section precedes org knowledge in the payload.
  const notesSection = text.includes("## Branch notes") ? text.split("## Org knowledge")[0] : "";
  const notes = notesSection.match(NOTE_RE)?.length ?? 0;
  return { pages: pages.size, notes };
}

/** Drop state from sessions that ended long ago; nothing else cleans up. */
function prune(dir: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".knowledge.json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > STATE_TTL_MS) rmSync(path, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Record a knowledge delivery for the status line (latest delivery wins).
 * Zero counts are not written — "no notes returned" usually means the lookup
 * omitted repo/branch, and the row must never render an all-zero state.
 */
export function recordKnowledgeCounts(
  sessionId: string,
  counts: KnowledgeCounts,
  home: string = homedir(),
  now: number = Date.now(),
): void {
  if (!sessionId || (!counts.pages && !counts.notes)) return;
  try {
    const dir = knowledgeStateDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    prune(dir, now);
    writeSecureFile(knowledgeStatePath(sessionId, home), JSON.stringify(counts));
  } catch (err) {
    // Cosmetic feature: never let a state write disturb the hook.
    logger.debug("statusline", `state write failed: ${err instanceof Error ? err.message : err}`);
  }
}
