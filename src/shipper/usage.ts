/** Token usage read from a session's raw journal, shipped next to the trajectory records so the
 * backend can price a session (or a segment of it) at query time. The trajectory normalizer
 * drops usage, so this is a second, independent pass over the same log. Tokens only, never
 * dollars: prices change, and the server owns the price table.
 *
 * One entry per billable API request, keyed by an id that is stable across re-ships of a growing
 * session, so the server can dedupe the overlap between traces of one session. Harnesses whose
 * logs record no usage (Cursor, opencode, pi) yield null and ship as before. */

import { readFileSync } from "node:fs";
import type { AgentSession } from "../sessions/scan";

export interface RequestUsage {
  /** Stable request id: Claude Code's request / API message id, a synthesized one for Codex. */
  id: string;
  model: string | null;
  /** When the request's last journal line landed; ties it to the trace's events. */
  timestamp: string | null;
  /** Uncached input tokens. */
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** The 1-hour-TTL part of cache_write (Claude Code only). */
  cache_write_1h: number;
  /** Claude Code's fast mode bills at a premium; null when not recorded. */
  speed: string | null;
  /** Tool calls the request made, matching the trajectory's tool_call ids. */
  tool_call_ids: string[];
}

export interface SessionUsage {
  requests: RequestUsage[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseLines(transcript: string): Json[] {
  const lines: Json[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) lines.push(value);
    } catch {
      // A torn final line of a live session; the rest of the log still counts.
    }
  }
  return lines;
}

function billed(request: RequestUsage): boolean {
  return (
    request.input + request.output + request.cache_read + request.cache_write > 0 ||
    request.tool_call_ids.length > 0
  );
}

/** Claude Code writes one journal line per content block, each repeating the whole message's
 * usage. Lines of one API request share `requestId` (older logs: only `message.id`); the line
 * with the highest output carries the final count. */
export function claudeUsage(transcript: string): RequestUsage[] {
  const requests = new Map<string, RequestUsage>();
  for (const line of parseLines(transcript)) {
    if (line.type !== "assistant" || !isObject(line.message)) continue;
    const message = line.message;
    const usage = message.usage;
    const id = str(line.requestId) ?? str(message.id) ?? str(line.uuid);
    if (!isObject(usage) || id === null) continue;
    const toolCallIds = Array.isArray(message.content)
      ? message.content
          .filter((block) => isObject(block) && block.type === "tool_use")
          .map((block) => str((block as Json).id))
          .filter((toolId): toolId is string => toolId !== null)
      : [];
    const cacheCreation = isObject(usage.cache_creation) ? usage.cache_creation : {};
    const entry: RequestUsage = {
      id,
      model: str(message.model),
      timestamp: str(line.timestamp),
      input: int(usage.input_tokens),
      output: int(usage.output_tokens),
      cache_read: int(usage.cache_read_input_tokens),
      cache_write: int(usage.cache_creation_input_tokens),
      cache_write_1h: int(cacheCreation.ephemeral_1h_input_tokens),
      speed: str(usage.speed),
      tool_call_ids: toolCallIds,
    };
    const previous = requests.get(id);
    if (previous === undefined) {
      requests.set(id, entry);
      continue;
    }
    const latest = entry.output >= previous.output ? entry : previous;
    requests.set(id, {
      ...latest,
      timestamp: entry.timestamp ?? previous.timestamp,
      tool_call_ids: [...new Set([...previous.tool_call_ids, ...entry.tool_call_ids])],
    });
  }
  // Claude Code's locally synthesized messages (model "<synthetic>") carry all-zero usage.
  return [...requests.values()].filter(billed);
}

/** Codex logs a `token_count` event after each model request: `last_token_usage` is that
 * request's usage, `total_token_usage` the running session total. Repeated readings of one
 * request (same running total) count once, and the running total, which only grows, names the
 * request stably across re-ships. Codex's input_tokens includes the cached part. */
export function codexUsage(transcript: string): RequestUsage[] {
  const requests: RequestUsage[] = [];
  let model: string | null = null;
  let ownSessionId: string | null = null;
  let historyStart: number | null = null;
  let lastTotal: number | null = null;
  let toolCallIds: string[] = [];
  for (const line of parseLines(transcript)) {
    const payload = isObject(line.payload) ? line.payload : {};
    // A forked subagent's rollout replays its parent's history first; that usage is the
    // parent's (same filter as the trajectory normalizer's fork handling).
    const ordinal = typeof line.ordinal === "number" ? line.ordinal : null;
    if (historyStart !== null && ordinal !== null && ordinal < historyStart) continue;
    if (line.type === "session_meta") {
      const metaId = str(payload.id);
      if (ownSessionId === null) {
        ownSessionId = metaId;
        if (str(payload.forked_from_id) !== null) {
          const start = payload.subagent_history_start_ordinal;
          historyStart = typeof start === "number" ? start : null;
        }
      }
    } else if (line.type === "turn_context") {
      model = str(payload.model) ?? model;
    } else if (line.type === "response_item") {
      const callId = str(payload.call_id);
      if (callId !== null && typeof payload.type === "string" && payload.type.endsWith("_call")) {
        toolCallIds.push(callId);
      }
    } else if (line.type === "event_msg" && payload.type === "token_count") {
      const info = isObject(payload.info) ? payload.info : null;
      const last = info && isObject(info.last_token_usage) ? info.last_token_usage : null;
      const total = info && isObject(info.total_token_usage) ? info.total_token_usage : null;
      if (last === null || total === null) continue;
      const runningTotal = int(total.total_tokens);
      if (runningTotal === lastTotal) continue;
      lastTotal = runningTotal;
      const input = int(last.input_tokens);
      const cached = int(last.cached_input_tokens);
      const cacheWrite = int(last.cache_write_input_tokens);
      // Cached and cache-write input are parts of input_tokens; split them out unless a
      // producer reports a breakdown that does not fit inside the total.
      const disjoint = cached + cacheWrite <= input;
      const request: RequestUsage = {
        id: `codex:${runningTotal}`,
        model,
        timestamp: str(line.timestamp),
        input: Math.max(0, input - cached - (disjoint ? cacheWrite : 0)),
        output: int(last.output_tokens),
        cache_read: cached,
        cache_write: disjoint ? cacheWrite : 0,
        cache_write_1h: 0,
        speed: null,
        tool_call_ids: toolCallIds,
      };
      toolCallIds = [];
      if (billed(request)) requests.push(request);
    }
  }
  return requests;
}

const READERS: Partial<Record<AgentSession["harness"], (transcript: string) => RequestUsage[]>> = {
  claude: claudeUsage,
  codex: codexUsage,
};

/** The session's token usage, or null when its harness records none or the log is unreadable.
 * Never throws: usage is an annotation on the transcript and must not block shipping it. */
export function readSessionUsage(session: AgentSession): SessionUsage | null {
  const reader = READERS[session.harness];
  if (!reader) return null;
  try {
    const requests = reader(readFileSync(session.path, "utf8"));
    return requests.length > 0 ? { requests } : null;
  } catch {
    return null;
  }
}
