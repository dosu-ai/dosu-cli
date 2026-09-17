/**
 * Session digest matching parse_agent_logs.build_digest: each JSONL line
 * that has text or tool_use becomes a turn with file line numbers and tool
 * previews (path/pattern/command). The HTML "Work to learn this" expander
 * reads this — empty tools collapse every assistant turn to "Reasoning".
 */

import { readFileSync } from "node:fs";
import { readSessionTurns } from "../sessions/read";
import type { AgentSession } from "../sessions/scan";
import { extractUserQueries } from "./queries";
import type { DigestTool, DigestTurn, ReportDigest } from "./types";

const CHARS_PER_TOKEN = 4;
const MAX_ASSISTANT_CHARS = 4000;
const MCP_DIGEST_TOOLS = new Set(["CallMcpTool", "GetMcpTools"]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function estimateTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN);
}

function digestEstTokens(texts: string[], tools: DigestTool[], resultChars: number): number {
  const countable = tools.filter((t) => t.name !== "tool_result");
  let payload = texts.join("\n");
  if (countable.length > 0) payload += JSON.stringify(countable);
  let tokens = estimateTokens(payload);
  if (resultChars > 0) tokens += Math.max(1, Math.round(resultChars / CHARS_PER_TOKEN));
  return tokens;
}

function copyToolInputFields(entry: DigestTool, inp: unknown): void {
  const row = asRecord(inp);
  if (!row) return;
  if (typeof row.path === "string") entry.path = row.path;
  if (typeof row.file_path === "string") {
    entry.file_path = row.file_path;
    entry.path ??= row.file_path;
  }
  if (typeof row.pattern === "string") entry.pattern = row.pattern;
  if (row.command != null) entry.command_preview = String(row.command).slice(0, 160);
  if (row.prompt != null) {
    entry.prompt = String(row.prompt).slice(0, 160);
    entry.command_preview ??= entry.prompt;
  }
  if (typeof row.query === "string") entry.query = row.query;
  if (typeof row.description === "string" && !entry.command_preview) {
    entry.command_preview = row.description.slice(0, 160);
  }
}

function copyMcpFields(entry: DigestTool, name: string, inp: unknown): void {
  const row = asRecord(inp);
  if (!row) return;
  const isMcp =
    MCP_DIGEST_TOOLS.has(name) || name.startsWith("mcp__") || Boolean(row.toolName || row.server);
  if (!isMcp) return;
  const toolName = row.toolName ?? row.tool_name;
  if (typeof toolName === "string") entry.toolName = toolName;
  if (typeof row.server === "string") entry.server = row.server;
  if (name === "GetMcpTools" && typeof row.pattern === "string") entry.pattern = row.pattern;
  const args = asRecord(row.arguments);
  if (args) entry.arguments = args;
  else if (name.startsWith("mcp__")) entry.arguments = row;
}

function blocksToDigest(
  content: unknown,
  maxTextChars: number,
): { texts: string[]; tools: DigestTool[]; resultChars: number } {
  const texts: string[] = [];
  const tools: DigestTool[] = [];
  let resultChars = 0;
  const blocks = Array.isArray(content)
    ? content
    : typeof content === "string" && content
      ? [{ type: "text", text: content }]
      : [];
  for (const block of blocks) {
    const item = asRecord(block);
    if (!item) continue;
    const btype = item.type;
    if (
      (btype === "text" || btype === "input_text" || btype === "output_text") &&
      typeof item.text === "string" &&
      item.text
    ) {
      let t = item.text;
      if (t.length > maxTextChars) t = `${t.slice(0, maxTextChars)}\n…[truncated]`;
      texts.push(t);
    } else if (btype === "tool_use" && typeof item.name === "string") {
      const entry: DigestTool = { name: item.name };
      const inp = item.input ?? {};
      copyToolInputFields(entry, inp);
      copyMcpFields(entry, item.name, inp);
      tools.push(entry);
    } else if (btype === "tool_result") {
      const c = item.content;
      if (typeof c === "string") resultChars += c.length;
      else if (c != null) resultChars += JSON.stringify(c).length;
      tools.push({ name: "tool_result" });
    }
  }
  return { texts, tools, resultChars };
}

function pushTurn(
  turns: DigestTurn[],
  line: number,
  role: string,
  texts: string[],
  tools: DigestTool[],
  resultChars: number,
): void {
  if (role === "user" && texts.length > 0) {
    const qs = extractUserQueries(texts.join("\n"));
    if (qs.length > 0) texts.splice(0, texts.length, ...qs);
  }
  // Skip tool_result-only user rows so user-query cycles stay one stretch.
  if (role === "user" && texts.length === 0) return;
  if (texts.length === 0 && tools.length === 0) return;
  turns.push({
    line,
    role,
    text: texts,
    tools,
    est_tokens: digestEstTokens(texts, tools, resultChars),
  });
}

function digestCursor(raw: string): DigestTurn[] {
  const turns: DigestTurn[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: JsonRecord;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) continue;
      obj = parsed;
    } catch {
      continue;
    }
    const role = obj.role;
    if (role !== "user" && role !== "assistant") continue;
    const message = asRecord(obj.message);
    const { texts, tools, resultChars } = blocksToDigest(
      message?.content,
      role === "assistant" ? MAX_ASSISTANT_CHARS : 2000,
    );
    pushTurn(turns, i + 1, role, texts, tools, resultChars);
  }
  return turns;
}

function digestClaude(raw: string): DigestTurn[] {
  const turns: DigestTurn[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: JsonRecord;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) continue;
      obj = parsed;
    } catch {
      continue;
    }
    const etype = obj.type;
    if (etype !== "user" && etype !== "assistant") continue;
    if (obj.isSidechain === true) continue;
    const message = asRecord(obj.message);
    const { texts, tools, resultChars } = blocksToDigest(
      message?.content,
      etype === "assistant" ? MAX_ASSISTANT_CHARS : 2000,
    );
    pushTurn(turns, i + 1, etype, texts, tools, resultChars);
  }
  return turns;
}

function digestCodex(raw: string): DigestTurn[] {
  const turns: DigestTurn[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: JsonRecord;
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) continue;
      obj = parsed;
    } catch {
      continue;
    }
    const payload = asRecord(obj.payload) ?? {};
    const etype = obj.type;
    if (etype === "event_msg" && payload.type === "user_message") {
      const msg = String(payload.message ?? "").slice(0, 2000);
      if (msg) {
        turns.push({
          line: i + 1,
          role: "user",
          text: [msg],
          tools: [],
          est_tokens: estimateTokens(msg),
        });
      }
    } else if (etype === "event_msg" && payload.type === "agent_message") {
      let msg = String(payload.message ?? "");
      if (msg.length > MAX_ASSISTANT_CHARS)
        msg = `${msg.slice(0, MAX_ASSISTANT_CHARS)}\n…[truncated]`;
      if (msg) {
        turns.push({
          line: i + 1,
          role: "assistant",
          text: [msg],
          tools: [],
          est_tokens: estimateTokens(msg),
        });
      }
    } else if (etype === "response_item" && payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "function_call";
      const args = payload.arguments;
      const preview =
        typeof args === "string" ? args.slice(0, 160) : JSON.stringify(args ?? "").slice(0, 160);
      turns.push({
        line: i + 1,
        role: "assistant",
        text: [],
        tools: [{ name, command_preview: preview }],
        est_tokens: estimateTokens(preview),
      });
    }
  }
  return turns;
}

/** Build the skill-shaped digest; any failure degrades to no turns. */
export function sessionToDigest(session: AgentSession): ReportDigest {
  try {
    switch (session.harness) {
      case "claude":
        return { turns: digestClaude(readFileSync(session.path, "utf8")) };
      case "cursor":
        return { turns: digestCursor(readFileSync(session.path, "utf8")) };
      case "codex":
        return { turns: digestCodex(readFileSync(session.path, "utf8")) };
      case "opencode": {
        const turns = readSessionTurns(session).map((turn, index) => ({
          role: turn.role,
          line: index + 1,
          est_tokens: Math.round(turn.text.length / CHARS_PER_TOKEN),
          text: [turn.text],
          tools: [] as DigestTool[],
        }));
        return { turns };
      }
    }
  } catch {
    return { turns: [] };
  }
}

export function digestsForSessions(
  sessions: readonly AgentSession[],
): Record<string, ReportDigest> {
  const out: Record<string, ReportDigest> = {};
  for (const session of sessions) {
    out[session.id] = sessionToDigest(session);
  }
  return out;
}

export function digestTurnText(turn: DigestTurn): string {
  const texts = turn.text ?? [];
  if (typeof texts === "string") return texts;
  return texts.filter(Boolean).join("\n");
}
