/** Client for the agent-memory backend (`/v1/agent-memory/*`). Every request and response shape
 * the CLI relies on lives in this file, so aligning with the backend is a one-file change. Auth
 * matches the MCP server: the deployment's `X-Dosu-API-Key` plus its deployment id, from which the
 * backend resolves the org. */

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

/** `POST /v1/agent-memory/chunks`. `(org, session_id, seq)` is unique server-side; a resent
 * chunk carries the same seq and content. Lines are 1-based and inclusive. `diff` is the latest
 * snapshot against the session's starting commit: `""` means no changes, `null` means git could
 * not produce one (keep the previous snapshot). */
export interface ChunkRequest {
  repo: string;
  session_id: string;
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

/** An empty `note` means nothing to inject. */
export interface RecallResponse {
  note: string;
  episode_ids: string[];
  latency_ms: number;
  cost_usd?: number;
}

const CHUNKS_PATH = "/v1/agent-memory/chunks";
const RECALL_PATH = "/v1/agent-memory/recall";

function flushPath(sessionId: string): string {
  return `/v1/agent-memory/sessions/${encodeURIComponent(sessionId)}/flush`;
}

export interface MemoryApi {
  backendURL: string;
  apiKey: string;
  deploymentID: string;
}

/** Credentials from the CLI config; null when logged out, in OSS mode, or without an API key. */
export function memoryApiFromConfig(): MemoryApi | null {
  try {
    const cfg = loadConfig();
    if (cfg.mode === "oss") return null;
    const target = cfg.active_account?.target;
    const backendURL = getBackendURL().replace(/\/$/, "");
    if (!target?.api_key || !target.deployment_id || !backendURL) return null;
    return { backendURL, apiKey: target.api_key, deploymentID: target.deployment_id };
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
        "X-Deployment-ID": api.deploymentID,
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
  chunk: ChunkRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return postJSON(api, CHUNKS_PATH, chunk, CHUNK_TIMEOUT_MS, fetchImpl);
}

/** Mark the session's episode ready for processing now instead of after the quiet period. */
export function flushSession(
  api: MemoryApi,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return postJSON(api, flushPath(sessionId), {}, FLUSH_TIMEOUT_MS, fetchImpl);
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
    latency_ms: typeof body.latency_ms === "number" ? body.latency_ms : 0,
    ...(typeof body.cost_usd === "number" ? { cost_usd: body.cost_usd } : {}),
  };
}
