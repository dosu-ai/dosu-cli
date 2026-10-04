/** `dosu memory sync --session <id>`: upload what an agent session added to its transcript since
 * the last run. One chunk per run: new lines → events, a diff snapshot, secrets redacted,
 * then POST. The chunk is saved before it is sent and the cursor only moves once the backend has
 * it, so a failed or killed run resends the identical chunk next time. */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { logger } from "../debug/logger";
import { redactSecrets } from "../sessions/redact";
import { lockAt } from "../sync/lock";
import {
  type ApiOutcome,
  type ChunkRequest,
  flushSession,
  type MemoryApi,
  type MemoryEvent,
  memoryApiFromConfig,
  postChunk,
} from "./api";
import { diffSnapshot } from "./git";
import {
  type MemoryAgent,
  type Outbox,
  readSessionState,
  type SessionState,
  sessionLockPath,
  writeSessionState,
} from "./state";
import {
  type Conversion,
  convertCodexTranscriptLines,
  convertCursorEventLines,
  convertTranscriptLines,
} from "./transcript";

type SyncStatus =
  | "uploaded"
  | "nothing-new"
  | "no-state"
  | "no-repo"
  | "not-configured"
  | "busy"
  | "failed";

export interface SyncResult {
  status: SyncStatus;
  /** Chunks the backend accepted in this run (a resent chunk counts). */
  chunks: number;
  flushed: boolean;
  error?: string;
}

export interface SyncDeps {
  api?: MemoryApi | null;
  fetchImpl?: typeof fetch;
  snapshot?: (dir: string, base: string | null) => string | null;
  configDir?: string;
  /** How long to wait for a concurrent sync of the same session. */
  lockWaitMs?: number;
  /** Delays between POST attempts. */
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const SOURCE_BY_AGENT: Record<MemoryAgent, ChunkRequest["source"]> = {
  "claude-code": "claude_code",
  codex: "codex",
  cursor: "cursor",
};

const LOCK_WAIT_MS = 90_000;
const LOCK_POLL_MS = 250;
const RETRY_DELAYS_MS = [1_000, 3_000];
/** Rejections that resending the same chunk can never fix; the chunk is dropped. */
const PERMANENT_REJECTIONS = new Set([400, 413, 422]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Complete lines appended after `byteOffset`; a partly written last line waits for next time. */
function readNewLines(path: string, byteOffset: number): { lines: string[]; bytes: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= byteOffset) return { lines: [], bytes: 0 };
    const buffer = Buffer.alloc(size - byteOffset);
    const read = readSync(fd, buffer, 0, buffer.length, byteOffset);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1;
    if (end === 0) return { lines: [], bytes: 0 };
    const lines = buffer.subarray(0, end).toString("utf-8").split("\n");
    lines.pop();
    return { lines, bytes: end };
  } finally {
    closeSync(fd);
  }
}

function redactString(text: string, counter: { n: number }): string {
  const result = redactSecrets(text);
  counter.n += result.count;
  return result.text;
}

function redactEvent(event: MemoryEvent, counter: { n: number }): MemoryEvent {
  switch (event.type) {
    case "user_prompt":
    case "assistant_text":
      return { ...event, text: redactString(event.text, counter) };
    case "command":
      return {
        ...event,
        command: redactString(event.command, counter),
        error_line: event.error_line === null ? null : redactString(event.error_line, counter),
      };
    case "file_edit":
      return { ...event, path: redactString(event.path, counter) };
  }
}

function convertLines(state: SessionState, lines: string[]): Conversion {
  if (state.agent === "codex") {
    return { events: convertCodexTranscriptLines(lines, state.cwd), pending: state.pending_tools };
  }
  if (state.agent === "cursor") {
    return { events: convertCursorEventLines(lines), pending: state.pending_tools };
  }
  return convertTranscriptLines(lines, state.pending_tools, state.cwd);
}

/** The next chunk from new transcript lines, and the cursor after them; null without new lines.
 * Lines that yield no events only advance the cursor (`chunk` is null). */
function buildChunk(
  state: SessionState,
  repo: string,
  snapshot: (dir: string, base: string | null) => string | null,
): { chunk: ChunkRequest | null; next: Outbox["next"] } | null {
  if (state.transcript_path === null) return null;
  const { lines, bytes } = readNewLines(state.transcript_path, state.byte_offset);
  if (lines.length === 0) return null;
  const { events, pending } = convertLines(state, lines);
  const next = {
    byte_offset: state.byte_offset + bytes,
    line_offset: state.line_offset + lines.length,
    pending_tools: pending,
  };
  if (events.length === 0) return { next, chunk: null };

  const counter = { n: 0 };
  const diff = snapshot(state.cwd, state.start_head);
  const chunk: ChunkRequest = {
    repo,
    source: SOURCE_BY_AGENT[state.agent],
    seq: state.next_seq,
    first_line: state.line_offset + 1,
    last_line: next.line_offset,
    events: events.map((event) => redactEvent(event, counter)),
    diff: diff === null ? null : redactString(diff, counter),
  };
  if (counter.n > 0) {
    logger.info("memory", `redacted ${counter.n} secrets from chunk ${chunk.seq}`);
  }
  return { chunk, next };
}

async function sendWithRetry(
  api: MemoryApi,
  sessionId: string,
  chunk: ChunkRequest,
  deps: SyncDeps,
): Promise<ApiOutcome> {
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  let outcome = await postChunk(api, sessionId, chunk, deps.fetchImpl);
  for (const delay of delays) {
    if (outcome.ok || (outcome.status !== null && PERMANENT_REJECTIONS.has(outcome.status))) break;
    await sleep(delay);
    outcome = await postChunk(api, sessionId, chunk, deps.fetchImpl);
  }
  return outcome;
}

/** Send the saved chunk; on success (or a permanent rejection) adopt its cursor. */
async function deliverOutbox(
  state: SessionState,
  api: MemoryApi,
  deps: SyncDeps,
): Promise<{ delivered: boolean; error?: string }> {
  const outbox = state.outbox as Outbox;
  const outcome = await sendWithRetry(api, state.session_id, outbox.chunk, deps);
  if (!outcome.ok) {
    const permanent = outcome.status !== null && PERMANENT_REJECTIONS.has(outcome.status);
    if (!permanent) return { delivered: false, error: outcome.error };
    logger.warn(
      "memory",
      `dropping chunk ${outbox.chunk.seq}: backend rejected it (${outcome.error})`,
    );
  }
  Object.assign(state, outbox.next, { next_seq: outbox.chunk.seq + 1, outbox: null });
  writeSessionState(state, deps.configDir);
  return { delivered: outcome.ok };
}

async function acquire(path: string, deps: SyncDeps): Promise<ReturnType<typeof lockAt> | null> {
  const lock = lockAt(path);
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + (deps.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (lock.acquire()) return lock;
    if (Date.now() >= deadline) return null;
    await sleep(LOCK_POLL_MS);
  }
}

export async function syncSession(
  sessionId: string,
  options: { flush?: boolean } = {},
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const result: SyncResult = { status: "nothing-new", chunks: 0, flushed: false };
  const initial = readSessionState(sessionId, deps.configDir);
  if (!initial) return { ...result, status: "no-state" };
  if (!initial.repo) return { ...result, status: "no-repo" };
  const repo = initial.repo;
  const api = deps.api === undefined ? memoryApiFromConfig() : deps.api;
  if (!api) return { ...result, status: "not-configured" };

  const lock = await acquire(sessionLockPath(sessionId, deps.configDir), deps);
  if (!lock) return { ...result, status: "busy" };
  try {
    // Re-read under the lock: a concurrent run may have moved the cursor.
    const state = readSessionState(sessionId, deps.configDir);
    if (!state) return { ...result, status: "no-state" };
    if (state.outbox) {
      const sent = await deliverOutbox(state, api, deps);
      if (sent.error) return { ...result, status: "failed", error: sent.error };
      if (sent.delivered) result.chunks += 1;
    }

    const built = buildChunk(state, repo, deps.snapshot ?? diffSnapshot);
    if (built?.chunk) {
      state.outbox = { chunk: built.chunk, next: built.next };
      writeSessionState(state, deps.configDir);
      const sent = await deliverOutbox(state, api, deps);
      if (sent.error) return { ...result, status: "failed", error: sent.error };
      if (sent.delivered) result.chunks += 1;
    } else if (built) {
      Object.assign(state, built.next);
      writeSessionState(state, deps.configDir);
    }
    if (result.chunks > 0) result.status = "uploaded";

    // A session the backend never got a batch of has no episode to flush (it would answer 404).
    if (options.flush && state.next_seq > 0) {
      const flushed = await flushSession(api, sessionId, deps.fetchImpl);
      result.flushed = flushed.ok;
      if (!flushed.ok) return { ...result, status: "failed", error: `flush: ${flushed.error}` };
    }
    return result;
  } catch (err) {
    return { ...result, status: "failed", error: err instanceof Error ? err.message : String(err) };
  } finally {
    lock.release();
  }
}
