/** Client for the agent-memory backend (`/v1/agent-memory/*`, dosu backend
 * `public_api/agent_memory/router.py`). Every request and response shape the CLI relies on lives
 * in this file. Auth is the MCP entry's `X-Dosu-API-Key`; the backend resolves the org from it. */

import { loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";

/** One compact event rebuilt from an agent's transcript line. `ts` is that line's client
 * timestamp. `file_edit` is context only: the backend must not append it to the episode's steps,
 * which hold shell commands alone (as in the frozen memwriter). */
export type MemoryEvent =
  | { type: "user_prompt"; ts: string; text: string }
  | { type: "assistant_text"; ts: string; text: string }
  | { type: "command"; ts: string; command: string; rc: number; error_line: string | null }
  | { type: "file_edit"; ts: string; tool: string; path: string };

/** `POST /v1/agent-memory/sessions/{session_id}/events` (backend `SessionBatch`).
 * `(org, session_id, seq)` is unique server-side; a resent chunk carries the same seq and content.
 * `source` is the agent (backend `AgentMemorySessionSource`).
 * Lines are 1-based and inclusive. `diff` is the latest snapshot against the session's starting
 * commit: `""` means no changes, `null` means git could not produce one (keep the previous). */
export interface ChunkRequest {
  repo: string;
  source: "claude_code" | "codex";
  seq: number;
  first_line: number;
  last_line: number;
  events: MemoryEvent[];
  diff: string | null;
}

/** The body of every recall call on a session's first prompt: `POST /v1/agent-memory/recall`
 * (single-stage) and both halves of a two-stage recall, `/recall/quick` and `/recall/full`. */
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

/** `POST /v1/agent-memory/recall/quick` (backend `QuickRecallResponse`): stage one of a two-stage
 * recall, the playbook note, without a model call. `recall_id` is the backend's recall_log row,
 * kept for the local log. The backend also sends `RecallResponse`'s episode lists and cost. */
export interface QuickRecallResponse {
  note: string;
  latency_ms: number;
  recall_id: string | null;
}

/** `POST /v1/agent-memory/recall/full` answers 202 with a pending job (backend `FullRecallJob`):
 * stage two, the note written for this task, by a background worker. The request may also carry
 * `quick_recall_id` to link the two recall_log rows; the CLI starts both stages at once and has no
 * id yet, so the rows pair by session instead. */
export interface FullRecallJob {
  job_id: string;
}

/** `GET /v1/agent-memory/recall/full/{job_id}` (backend `FullRecallJob`). `done` and `failed` are
 * final; `note` is null on the wire until `done` (read here as ""), and "" when done means
 * nothing to say. `latency_ms` runs from the start request to the job's end. A job unfinished at
 * the backend's deadline (120 s after the request) fails, and one whose worker died is failed 30 s
 * after that. Other org's or unknown jobs are 404. */
export interface FullRecallStatus {
  status: "pending" | "done" | "failed";
  note: string;
  error: string | null;
  latency_ms: number | null;
}

const FULL_RECALL_STATUSES = new Set(["pending", "done", "failed"]);

/** The writer's "no note" answer; never injected. */
const NO_NOTE = "NONE";

/** The note to inject, or null when the backend had nothing to say. */
export function usableNote(note: string): string | null {
  const trimmed = note.trim();
  return trimmed && trimmed !== NO_NOTE ? trimmed : null;
}

const RECALL_PATH = "/v1/agent-memory/recall";
const QUICK_RECALL_PATH = "/v1/agent-memory/recall/quick";
const FULL_RECALL_PATH = "/v1/agent-memory/recall/full";

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

/** `sent` is false only when the connection failed, so the backend never saw the request. */
export type ApiOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status: number | null; error: string; sent: boolean };

/** A failed call; `permanent` when asking again cannot help (a 4xx answer). */
export interface ApiError {
  error: string;
  permanent: boolean;
}

const CHUNK_TIMEOUT_MS = 30_000;
const FLUSH_TIMEOUT_MS = 30_000;
/** Below the UserPromptSubmit hook's 120 s timeout so a slow recall still exits cleanly. */
const RECALL_TIMEOUT_MS = 110_000;
/** The first prompt waits at most this long for stage one; `DOSU_MEMORY_QUICK_TIMEOUT_MS`
 * overrides it. */
const QUICK_RECALL_TIMEOUT_MS = 2_500;
/** Each call of the detached poller: stage two's start request and every status poll. */
const FULL_RECALL_TIMEOUT_MS = 10_000;

function quickRecallTimeoutMs(): number {
  const value = process.env.DOSU_MEMORY_QUICK_TIMEOUT_MS?.trim();
  if (!value) return QUICK_RECALL_TIMEOUT_MS;
  const ms = Number(value);
  if (Number.isInteger(ms) && ms > 0) return ms;
  logger.warn(
    "memory",
    `DOSU_MEMORY_QUICK_TIMEOUT_MS is not a positive whole number; using ${QUICK_RECALL_TIMEOUT_MS}`,
  );
  return QUICK_RECALL_TIMEOUT_MS;
}

/** Error codes for a connection that never opened (refused, or the host name did not resolve):
 * Bun sets them on the error, Node on its `cause`. Everything else may come after the request
 * went out: a timeout cannot tell connecting from waiting for the answer, and a reset can follow
 * the request. */
const CONNECT_FAILURES = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  return String(err.code);
}

function neverSent(err: unknown): boolean {
  const cause = err instanceof Error ? err.cause : undefined;
  return [errorCode(err), errorCode(cause)].some((code) => code && CONNECT_FAILURES.has(code));
}

async function requestJSON(
  api: MemoryApi,
  path: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ApiOutcome> {
  try {
    const resp = await fetchImpl(`${api.backendURL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-Dosu-API-Key": api.apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}`, sent: true };
    }
    const text = await resp.text();
    return { ok: true, body: text ? JSON.parse(text) : null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error, sent: !neverSent(err) };
  }
}

export function postChunk(
  api: MemoryApi,
  sessionId: string,
  chunk: ChunkRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return requestJSON(api, sessionPath(sessionId, "events"), chunk, CHUNK_TIMEOUT_MS, fetchImpl);
}

/** Process the session's episode now instead of after the quiet period. The backend answers 404
 * for a session it has no batch of. */
export function flushSession(
  api: MemoryApi,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiOutcome> {
  return requestJSON(api, sessionPath(sessionId, "flush"), {}, FLUSH_TIMEOUT_MS, fetchImpl);
}

export async function recall(
  api: MemoryApi,
  request: RecallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RecallResponse | { error: string }> {
  const outcome = await requestJSON(api, RECALL_PATH, request, RECALL_TIMEOUT_MS, fetchImpl);
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

function apiError(outcome: Extract<ApiOutcome, { ok: false }>): ApiError {
  const permanent = outcome.status !== null && outcome.status >= 400 && outcome.status < 500;
  return { error: outcome.error, permanent };
}

export async function recallQuick(
  api: MemoryApi,
  request: RecallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<QuickRecallResponse | ApiError> {
  const outcome = await requestJSON(
    api,
    QUICK_RECALL_PATH,
    request,
    quickRecallTimeoutMs(),
    fetchImpl,
  );
  if (!outcome.ok) return apiError(outcome);
  const body = outcome.body as Partial<QuickRecallResponse> | null;
  if (typeof body?.note !== "string") {
    return { error: "quick recall response has no note", permanent: true };
  }
  return {
    note: body.note,
    latency_ms: typeof body.latency_ms === "number" ? body.latency_ms : 0,
    recall_id: typeof body.recall_id === "string" ? body.recall_id : null,
  };
}

/** Only a request that never went out is worth sending again: the backend starts a new job for
 * every one it receives, so an error is permanent once the request may have arrived (a timeout, a
 * dropped connection, any HTTP status). */
export async function startFullRecall(
  api: MemoryApi,
  request: RecallRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<FullRecallJob | ApiError> {
  const outcome = await requestJSON(
    api,
    FULL_RECALL_PATH,
    request,
    FULL_RECALL_TIMEOUT_MS,
    fetchImpl,
  );
  if (!outcome.ok) return { error: outcome.error, permanent: outcome.sent };
  const body = outcome.body as Partial<FullRecallJob> | null;
  if (typeof body?.job_id !== "string" || body.job_id === "") {
    return { error: "full recall response has no job_id", permanent: true };
  }
  return { job_id: body.job_id };
}

export async function fullRecallStatus(
  api: MemoryApi,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FullRecallStatus | ApiError> {
  const path = `${FULL_RECALL_PATH}/${encodeURIComponent(jobId)}`;
  const outcome = await requestJSON(api, path, undefined, FULL_RECALL_TIMEOUT_MS, fetchImpl);
  if (!outcome.ok) return apiError(outcome);
  const body = outcome.body as Record<string, unknown> | null;
  const status = body?.status;
  if (typeof status !== "string" || !FULL_RECALL_STATUSES.has(status)) {
    return { error: `full recall job has an unknown status: ${String(status)}`, permanent: true };
  }
  if (status === "done" && typeof body?.note !== "string") {
    return { error: "finished full recall has no note", permanent: true };
  }
  return {
    status: status as FullRecallStatus["status"],
    note: typeof body?.note === "string" ? body.note : "",
    error: typeof body?.error === "string" ? body.error : null,
    latency_ms: typeof body?.latency_ms === "number" ? body.latency_ms : null,
  };
}
