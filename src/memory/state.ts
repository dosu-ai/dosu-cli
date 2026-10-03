/** Per-session local state for agent memory: what SessionStart learned, how far the transcript
 * has been uploaded, and the note injected on the first prompt. One JSON file per Claude Code
 * session under the CLI config dir (so `DOSU_DEV` installs stay isolated). Stage two of a
 * two-stage recall has files of its own: the detached poller writes it while syncs rewrite the
 * session state, and neither may overwrite the other. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import type { ChunkRequest } from "./api";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

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
  transcript_path: string;
  cwd: string;
  /** `owner/name` from the origin remote; null disables memory for the session. */
  repo: string | null;
  /** HEAD when the session started; diff snapshots are taken against it. */
  start_head: string | null;
  started_at: string;
  next_seq: number;
  outbox: Outbox | null;
  /** Fixed when the state is created, so a resumed session keeps its mode. */
  recall_mode: RecallMode;
  recall_attempted: boolean;
  /** The note injected on the first prompt (stage one in two-stage mode), re-injected after
   * compaction. */
  note: string | null;
}

/** Stage two of a two-stage recall. Written by the first prompt as `pending`, then once more by
 * the poller with the outcome. */
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

function fullRecallInjectedPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.full-recall.injected`);
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

/** Atomic replace (temp file + rename), owner-only permissions. */
function writeJSON(sessionId: string, path: string, value: unknown, configDir?: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error("unsafe session id");
  const dir = memoryDir(configDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/** Whether stage two has been handed to the agent. */
export function fullRecallInjected(sessionId: string, configDir?: string): boolean {
  return isSafeSessionId(sessionId) && existsSync(fullRecallInjectedPath(sessionId, configDir));
}

/** Take the session's single stage-two injection: an exclusive create of a marker file, so of
 * several hooks racing (parallel tool calls fire PostToolUse concurrently) exactly one wins. */
export function claimFullRecallInjection(sessionId: string, configDir?: string): boolean {
  if (!isSafeSessionId(sessionId)) return false;
  try {
    writeFileSync(fullRecallInjectedPath(sessionId, configDir), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function newSessionState(fields: {
  session_id: string;
  transcript_path: string;
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
    outbox: null,
    recall_attempted: false,
    note: null,
  };
}
