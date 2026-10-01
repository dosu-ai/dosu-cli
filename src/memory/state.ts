/** Per-session local state for agent memory: what SessionStart learned, how far the transcript
 * has been uploaded, and the note injected on the first prompt. One JSON file per Claude Code
 * session under the CLI config dir (so `DOSU_DEV` installs stay isolated). */

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
  recall_attempted: boolean;
  /** The note injected on the first prompt, re-injected after compaction. */
  note: string | null;
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

export function sessionLockPath(sessionId: string, configDir?: string): string {
  return join(memoryDir(configDir), `${sessionId}.lock`);
}

export function readSessionState(sessionId: string, configDir?: string): SessionState | null {
  if (!isSafeSessionId(sessionId)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath(sessionId, configDir), "utf-8"));
    return parsed?.session_id === sessionId ? (parsed as SessionState) : null;
  } catch {
    return null;
  }
}

/** Atomic replace (temp file + rename), owner-only permissions. */
export function writeSessionState(state: SessionState, configDir?: string): void {
  if (!isSafeSessionId(state.session_id)) throw new Error("unsafe session id");
  const dir = memoryDir(configDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = statePath(state.session_id, configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

export function newSessionState(fields: {
  session_id: string;
  transcript_path: string;
  cwd: string;
  repo: string | null;
  start_head: string | null;
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
