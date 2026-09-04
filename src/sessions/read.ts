/** Turns a scanned `AgentSession` into user/assistant text turns; tool calls, thinking, and
 * scaffolding are deliberately dropped. Callers must still redactSecrets before anything leaves. */

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

/** Extract message content text: a bare string, or typed items filtered to the given types. */
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

/** Read a session's conversational turns; any failure degrades to fewer (or zero) turns,
 * never an exception. */
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

/** Estimated tokens of conversational content, the mining analytics' "cost to learn" baseline:
 * text chars / 4 over user/assistant turns only. */
export function estimateSessionTokens(session: AgentSession): number {
  let chars = 0;
  for (const turn of readSessionTurns(session)) chars += turn.text.length;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Fewer conversational turns than this and a session can't hold a real finding. */
const MIN_WORTH_TURNS = 4;
/** Total conversation text below this is a greeting, not an investigation. */
const MIN_WORTH_CHARS = 2000;

/** Cheap pre-filter that keeps trivial sessions from costing a gateway run; deliberately
 * permissive, rejecting only sessions that are structurally too small, never judging content. */
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
