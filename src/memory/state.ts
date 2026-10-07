/** Per-session local state for agent memory: what SessionStart learned, how far the transcript
 * has been uploaded, and the note injected on the first prompt. One JSON file per agent session
 * under the CLI config dir (so `DOSU_DEV` installs stay isolated). Stage two of a
 * two-stage recall has files of its own: the detached poller writes it while syncs rewrite the
 * session state, and neither may overwrite the other. The first prompt hands the poller its
 * request in one more file, which the poller deletes on reading. Cursor sessions also keep an
 * event log, which their hooks append to and syncs read in place of a transcript. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import type { ChunkRequest, MemoryEvent, RecallRequest } from "./api";

/** The coding agents whose hooks feed agent memory. */
export const MEMORY_AGENTS = ["claude-code", "codex", "cursor"] as const;
export type MemoryAgent = (typeof MEMORY_AGENTS)[number];

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const FULL_RECALL_REQUEST_SUFFIX = ".full-recall.request.json";
/** A poller reads its request within a second of starting; one still there after this is from a
 * poller that died first. */
const STALE_REQUEST_MS = 5 * 60_000;

/** A tool call seen in the transcript whose result has not been read yet. */
export interface PendingTool {
  name: string;
  /** Bash: the command, already cleaned by `prepareRecordedCommand`. */
  command?: string;
  /** Edit / Write / MultiEdit: the file path. */
  path?: string;
}

/** Read position in the transcript: bytes for seeking, lines for chunk numbering. */
interface TranscriptCursor {
  byte_offset: number;
  line_offset: number;
  pending_tools: Record<string, PendingTool>;
}

/** A chunk saved before it is sent, so a retry resends exactly the same seq and content. */
export interface Outbox {
  chunk: ChunkRequest;
  /** Cursor to adopt once the backend has the chunk. */
  next: TranscriptCursor;
}

/** `single`: one recall on the first prompt, waited for in full (phase 1). `two_stage`: a quick
 * note on the first prompt, the task-specific note injected later. */
export type RecallMode = "single" | "two_stage";

export interface SessionState extends TranscriptCursor {
  session_id: string;
  /** Which converter reads the transcript. */
  agent: MemoryAgent;
  /** Null when the agent keeps none (an ephemeral Codex session): nothing to upload. A Cursor
   * session's event log. */
  transcript_path: string | null;
  cwd: string;
  /** `owner/name` from the origin remote; null disables memory for the session. */
  repo: string | null;
  /** HEAD when the session started; diff snapshots are taken against it. */
  start_head: string | null;
  started_at: string;
  next_seq: number;
  /** `next_seq` when the backend last accepted a flush: the batches below it are in a flushed
   * episode. */
  flushed_seq: number | null;
  outbox: Outbox | null;
  /** Fixed when the state is created, so a resumed session keeps its mode. */
  recall_mode: RecallMode;
  recall_attempted: boolean;
  /** The note injected on the first prompt (stage one in two-stage mode), re-injected after
   * compaction. */
  note: string | null;
}

/** Stage two of a two-stage recall. Written by the poller as `pending` once the job has started,
 * then once more with the outcome. */
export interface FullRecallState {
  session_id: string;
  job_id: string;
  status: "pending" | "done" | "failed";
  /** Set once `done`; null when the writer had nothing to say. */
  note: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

export function memoryDir(configDir: string = getConfigDir()): string {
  return join(configDir, "agent-memory");
}

function statePath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.json`);
}

function fullRecallPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.full-recall.json`);
}

function fullRecallRequestPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}${FULL_RECALL_REQUEST_SUFFIX}`);
}

function fullRecallInjectedPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.full-recall.injected`);
}

function fullRecallStartedPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.full-recall.started`);
}

function noteInjectedPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.note.injected`);
}

function exitWatchPath(sessionId: string, pid: number, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.exit-watch.${pid}`);
}

export function eventLogPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.events.jsonl`);
}

export function sessionLockPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.lock`);
}

function readJSON<T extends { session_id: string }>(path: string, sessionId: string): T | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed?.session_id === sessionId ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function ensureMemoryDir(configDir?: string): void {
  const dir = memoryDir(configDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Atomic replace (temp file + rename), owner-only permissions. */
function writeJSON(sessionId: string, path: string, value: unknown, configDir?: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error("unsafe session id");
  ensureMemoryDir(configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

export function readSessionState(sessionId: string, configDir?: string): SessionState | null {
  if (!isSafeSessionId(sessionId)) return null;
  return readJSON<SessionState>(statePath(sessionId, configDir), sessionId);
}

export function writeSessionState(state: SessionState, configDir?: string): void {
  writeJSON(state.session_id, statePath(state.session_id, configDir), state, configDir);
}

export function readFullRecallState(sessionId: string, configDir?: string): FullRecallState | null {
  if (!isSafeSessionId(sessionId)) return null;
  return readJSON<FullRecallState>(fullRecallPath(sessionId, configDir), sessionId);
}

export function writeFullRecallState(state: FullRecallState, configDir?: string): void {
  writeJSON(state.session_id, fullRecallPath(state.session_id, configDir), state, configDir);
}

/** The first prompt's recall request, for the poller to start stage two with. */
export function writeFullRecallRequest(request: RecallRequest, configDir?: string): void {
  const sessionId = request.session_id;
  writeJSON(sessionId, fullRecallRequestPath(sessionId, configDir), request, configDir);
}

/** Read and delete the request, so the prompt stays on disk only until the poller has it. */
export function takeFullRecallRequest(sessionId: string, configDir?: string): RecallRequest | null {
  if (!isSafeSessionId(sessionId)) return null;
  const path = fullRecallRequestPath(sessionId, configDir);
  const request = readJSON<RecallRequest>(path, sessionId);
  rmSync(path, { force: true });
  return request;
}

/** Delete every session's request that no poller read in time, so no prompt stays on disk. */
export function removeStaleFullRecallRequests(configDir?: string, now: Date = new Date()): void {
  const dir = memoryDir(configDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(FULL_RECALL_REQUEST_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      if (now.getTime() - statSync(path).mtimeMs > STALE_REQUEST_MS) rmSync(path, { force: true });
    } catch {
      // Taken by its poller in the meantime.
    }
  }
}

/** Whether stage two has been handed to the agent. */
export function fullRecallInjected(sessionId: string, configDir?: string): boolean {
  return isSafeSessionId(sessionId) && existsSync(fullRecallInjectedPath(sessionId, configDir));
}

/** One line per event, appended as it happens; a sync uploads the lines added since the last. */
export function appendSessionEvent(
  sessionId: string,
  event: MemoryEvent,
  configDir?: string,
): void {
  if (!isSafeSessionId(sessionId)) throw new Error("unsafe session id");
  ensureMemoryDir(configDir);
  appendFileSync(eventLogPath(sessionId, configDir), `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** An exclusive create of a marker file: of several hooks racing, exactly one wins. */
function claimMarker(path: string, sessionId: string, configDir?: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    ensureMemoryDir(configDir);
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Take the session's single stage-two injection (parallel tool calls fire their hooks
 * concurrently). */
export function claimFullRecallInjection(sessionId: string, configDir?: string): boolean {
  return claimMarker(fullRecallInjectedPath(sessionId, configDir), sessionId, configDir);
}

/** Take the session's single start of stage two, for Codex's background prompt hook, which runs on
 * every prompt and alongside the prompt hook that would otherwise tell it which prompt came
 * first. */
export function claimFullRecallStart(sessionId: string, configDir?: string): boolean {
  return claimMarker(fullRecallStartedPath(sessionId, configDir), sessionId, configDir);
}

/** Take the session's single hand-over of stage one, for Cursor, which hands it over before a
 * tool call when its prompt hook does not. */
export function claimNoteInjection(sessionId: string, configDir?: string): boolean {
  return claimMarker(noteInjectedPath(sessionId, configDir), sessionId, configDir);
}

/** Take the session's single exit watcher for one Claude Code process, whose Stop hook fires after
 * every turn. A resumed session runs in a new process and gets a watcher of its own. */
export function claimExitWatch(sessionId: string, pid: number, configDir?: string): boolean {
  return claimMarker(exitWatchPath(sessionId, pid, configDir), sessionId, configDir);
}

/** Cursor's preCompact: what was handed over may be gone after the compaction, so both notes
 * count as not handed over again, and the tool calls that follow hand them over as before. */
export function forgetHandOvers(sessionId: string, configDir?: string): void {
  if (!isSafeSessionId(sessionId)) return;
  rmSync(noteInjectedPath(sessionId, configDir), { force: true });
  rmSync(fullRecallInjectedPath(sessionId, configDir), { force: true });
}

export function newSessionState(fields: {
  session_id: string;
  agent: MemoryAgent;
  transcript_path: string | null;
  cwd: string;
  repo: string | null;
  start_head: string | null;
  recall_mode: RecallMode;
  now?: Date;
}): SessionState {
  const { now = new Date(), ...rest } = fields;
  return {
    ...rest,
    started_at: now.toISOString(),
    byte_offset: 0,
    line_offset: 0,
    pending_tools: {},
    next_seq: 0,
    flushed_seq: null,
    outbox: null,
    recall_attempted: false,
    note: null,
  };
}
