/** Client for the agent-memory backend (`/v1/agent-memory/*`, dosu backend
 * `public_api/agent_memory/router.py`). Every request and response shape the CLI relies on lives
 * in this file. Auth is the MCP entry's `X-Dosu-API-Key`; the backend resolves the org from it. */

import { loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";

/** One compact event rebuilt from a Claude Code transcript line. `ts` is that line's client
 * timestamp. `file_edit` is context only: the backend must not append it to the episode's steps,
 * which hold shell commands alone (as in the frozen memwriter). */
export type MemoryEvent =
  | { type: "user_prompt"; ts: string; text: string }
  | { type: "assistant_text"; ts: string; text: string }
  | { type: "command"; ts: string; command: string; rc: number; error_line: string | null }
  | { type: "file_edit"; ts: string; tool: string; path: string };

/** `POST /v1/agent-memory/sessions/{session_id}/events` (backend `SessionBatch`).
 * `(org, session_id, seq)` is unique server-side; a resent chunk carries the same seq and content.
 * Lines are 1-based and inclusive. `diff` is the latest snapshot against the session's starting
 * commit: `""` means no changes, `null` means git could not produce one (keep the previous). */
export interface ChunkRequest {
  repo: string;
  source: "claude_code";
  seq: number;
  first_line: number;
  last_line: number;
  events: MemoryEvent[];
  diff: string | null;
}

/** `POST /v1/agent-memory/recall`, called on a session's first prompt. */
export interface RecallRequest {
  repo: string;
  session_id: string;
  prompt: string;
}

/** An empty `note` means nothing to inject. `episode_ids` were read in full;
 * `available_episode_ids` are all earlier done episodes the writer saw. */
export interface RecallResponse {
  note: string;
  episode_ids: string[];
  available_episode_ids: string[];
  latency_ms: number;
  cost_usd: number | null;
}

const RECALL_PATH = "/v1/agent-memory/recall";

function sessionPath(sessionId: string, action: "events" | "flush"): string {
  return `/v1/agent-memory/sessions/${encodeURIComponent(sessionId)}/${action}`;
}

export interface MemoryApi {
  backendURL: string;
  apiKey: string;
}

/** Credentials from the CLI config; null when logged out, in OSS mode, or without an API key. */
export function memoryApiFromConfig(): MemoryApi | null {
  try {
    const cfg = loadConfig();
    if (cfg.mode === "oss") return null;
    const apiKey = cfg.active_account?.target?.api_key;
    const backendURL = getBackendURL().replace(/\/$/, "");
    if (!apiKey || !backendURL) return null;
    return { backendURL, apiKey };
  } catch {
    return null;
  }
}

export type ApiOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; error: string };

const CHUNK_TIMEOUT_MS = 30_000;
const FLUSH_TIMEOUT_MS = 30_000;
/** Below the UserPromptSubmit hook's 120 s timeout so a slow recall still exits cleanly. */
const RECALL_TIMEOUT_MS = 110_000;

async function postJSON(
  api: MemoryApi,
  path: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ApiOutcome> {
  try {
    const resp = await fetchImpl(`${api.backendURL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dosu-API-Key": api.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    return { ok: true, body: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function postChunk(
  api: MemoryApi,
  sessionId: string,
  chunk: ChunkRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return postJSON(api, sessionPath(sessionId, "events"), chunk, CHUNK_TIMEOUT_MS, fetchImpl);
}

/** Process the session's episode now instead of after the quiet period. The backend answers 404
 * for a session it has no batch of. */
export function flushSession(
  api: MemoryApi,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return postJSON(api, sessionPath(sessionId, "flush"), {}, FLUSH_TIMEOUT_MS, fetchImpl);
}

export async function recall(
  api: MemoryApi,
  request: RecallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RecallResponse | { error: string }> {
  const outcome = await postJSON(api, RECALL_PATH, request, RECALL_TIMEOUT_MS, fetchImpl);
  if (!outcome.ok) return { error: outcome.error };
  const body = outcome.body as Partial<RecallResponse> | null;
  if (typeof body?.note !== "string") return { error: "recall response has no note" };
  return {
    note: body.note,
    episode_ids: Array.isArray(body.episode_ids) ? body.episode_ids : [],
    available_episode_ids: Array.isArray(body.available_episode_ids)
      ? body.available_episode_ids
      : [],
    latency_ms: typeof body.latency_ms === "number" ? body.latency_ms : 0,
    cost_usd: typeof body.cost_usd === "number" ? body.cost_usd : null,
  };
}
