/**
 * Session content readers — the native replacement for deja's read path,
 * companion to the scanner in `scan.ts`.
 *
 * Turns a scanned `AgentSession` into an ordered list of conversational
 * turns (user/assistant text only). Tool calls, tool results, thinking
 * blocks, and system/developer scaffolding are deliberately dropped: the
 * miner wants what was said, and every byte excluded here is a byte that
 * cannot leak. Callers must still pass the result through `redactSecrets`
 * before it leaves the machine.
 *
 * Line shapes verified against real logs (2026-08):
 * - Claude Code: `{type: "user"|"assistant", message: {content: string |
 *   [{type: "text"|"thinking"|"tool_use"|"tool_result", …}]}}`, with
 *   `isSidechain: true` marking subagent traffic.
 * - Cursor: `{role, message: {content: [{type: "text"|"tool_use", …}]}}`
 *   plus role-less marker lines (`{type: "turn_ended"}`).
 * - Codex: `{type: "response_item", payload: {type: "message", role,
 *   content: [{type: "input_text"|"output_text", text}]}}`; roles include
 *   "developer" (base instructions), and user items may carry injected
 *   `<user_instructions>`/`<ENVIRONMENT_CONTEXT>` blocks.
 * - opencode: sqlite `message` rows (role inside the `data` JSON) with
 *   `part` rows holding the text chunks.
 */

import { readFileSync } from "node:fs";
import { type AgentSession, querySqlite } from "./scan";

export interface SessionTurn {
  role: "user" | "assistant";
  text: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** Parse a .jsonl payload, skipping blank and malformed lines. */
function jsonlRecords(raw: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record) records.push(record);
    } catch {
      // Tail of a log being written concurrently, or plain corruption.
    }
  }
  return records;
}

/**
 * Extract the text of a message content field: either a bare string or an
 * array of typed items, keeping only the given item types.
 */
function textFromContent(content: unknown, textTypes: ReadonlySet<string>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    const item = asRecord(entry);
    if (!item) continue;
    if (
      typeof item.type === "string" &&
      textTypes.has(item.type) &&
      typeof item.text === "string"
    ) {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function pushTurn(turns: SessionTurn[], role: "user" | "assistant", text: string): void {
  if (text.trim() !== "") turns.push({ role, text });
}

const PLAIN_TEXT = new Set(["text"]);
const CODEX_TEXT = new Set(["input_text", "output_text"]);

function readClaude(raw: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const record of jsonlRecords(raw)) {
    const role = record.type;
    if (role !== "user" && role !== "assistant") continue;
    if (record.isSidechain === true) continue;
    const message = asRecord(record.message);
    if (!message) continue;
    pushTurn(turns, role, textFromContent(message.content, PLAIN_TEXT));
  }
  return turns;
}

function readCursor(raw: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const record of jsonlRecords(raw)) {
    const role = record.role;
    if (role !== "user" && role !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    pushTurn(turns, role, textFromContent(message.content, PLAIN_TEXT));
  }
  return turns;
}

/** Injected scaffolding Codex records as user text but nobody typed. */
function isCodexInjectedBlock(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  return (
    head.startsWith("<user_instructions>") ||
    head.startsWith("<environment_context>") ||
    head.startsWith("<recommended_plugins>")
  );
}

function readCodex(raw: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const record of jsonlRecords(raw)) {
    if (record.type !== "response_item") continue;
    const payload = asRecord(record.payload);
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent(payload.content, CODEX_TEXT);
    if (role === "user" && isCodexInjectedBlock(text)) continue;
    pushTurn(turns, role, text);
  }
  return turns;
}

function readOpencode(dbPath: string, sessionId: string): SessionTurn[] {
  // The id is interpolated into SQL; scanner-produced ids are opaque tokens,
  // so anything outside this charset is unexpected input, not a session.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return [];
  const rows = querySqlite(
    dbPath,
    "SELECT m.data AS message, p.data AS part FROM part p " +
      "JOIN message m ON m.id = p.message_id " +
      `WHERE p.session_id = '${sessionId}' ORDER BY p.time_created, p.id`,
  );
  if (!rows) return [];
  const turns: SessionTurn[] = [];
  for (const row of rows) {
    if (typeof row.message !== "string" || typeof row.part !== "string") continue;
    try {
      const message = asRecord(JSON.parse(row.message));
      const part = asRecord(JSON.parse(row.part));
      const role = message?.role;
      if (role !== "user" && role !== "assistant") continue;
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      pushTurn(turns, role, part.text);
    } catch {
      // Malformed row — skip.
    }
  }
  return turns;
}

/**
 * Read the conversational turns of a scanned session. Unreadable files,
 * missing sqlite builtins, and malformed content all degrade to fewer (or
 * zero) turns — never an exception.
 */
export function readSessionTurns(session: AgentSession): SessionTurn[] {
  try {
    switch (session.harness) {
      case "claude":
        return readClaude(readFileSync(session.path, "utf8"));
      case "cursor":
        return readCursor(readFileSync(session.path, "utf8"));
      case "codex":
        return readCodex(readFileSync(session.path, "utf8"));
      case "opencode":
        return readOpencode(session.path, session.id);
    }
  } catch {
    return [];
  }
}

/** chars → tokens, the same coarse model the log-backfill report uses. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimated tokens of conversational content in a session — the "cost to
 * learn" baseline the mining analytics accumulate. Same model as the
 * log-backfill skill's report: text chars ÷ 4, over the user/assistant
 * turns only (tool noise is excluded by readSessionTurns).
 */
export function estimateSessionTokens(session: AgentSession): number {
  let chars = 0;
  for (const turn of readSessionTurns(session)) chars += turn.text.length;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Fewer conversational turns than this and a session can't hold a real finding. */
const MIN_WORTH_TURNS = 4;
/** Total conversation text below this is a greeting, not an investigation. */
const MIN_WORTH_CHARS = 2000;

/**
 * Cheap local pre-filter deciding whether a session could plausibly contain
 * durable knowledge — the gate that keeps trivial sessions (quick questions,
 * aborted starts, empty logs) from ever costing a gateway run. Deliberately
 * permissive: it only rejects sessions that are structurally too small,
 * never judges content. Unreadable sessions are not worth mining either.
 */
export function isWorthMining(session: AgentSession): boolean {
  const turns = readSessionTurns(session);
  if (turns.length < MIN_WORTH_TURNS) return false;
  let chars = 0;
  for (const turn of turns) {
    chars += turn.text.length;
    if (chars >= MIN_WORTH_CHARS) return true;
  }
  return false;
}
