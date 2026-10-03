/** What an agent hook's payload tells the sync. Session facts captured while the session ran, for
 * agents whose transcripts do not record them (Cursor records neither its branch nor its working
 * directory): one small file per session, never dropped like the project-dir cache, since a lost
 * branch means the session is never studied. And which session just ended, when the hook is a
 * definitive end event, so the sync ships it now instead of waiting out the quiet period. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { currentBranchOfDir } from "./repo";
import { SESSION_HARNESSES, type SessionHarness } from "./scan";

const CAPTURE_DIRNAME = "session-captures";

/** Bounds on reading a hook's stdin payload, so a hook that never closes stdin cannot stall. */
const HOOK_STDIN_TIMEOUT_MS = 500;
const HOOK_STDIN_MAX_BYTES = 1024 * 1024;

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface CapturedSession {
  /** Working directory the hook reported. */
  dir?: string;
  /** Branch checked out in `dir` at the latest captured turn. */
  branch?: string;
  /** When the capture was last updated. */
  at: string;
}

function capturePath(configDir: string, key: string): string | null {
  const [harness, id, ...rest] = key.split("/");
  if (rest.length > 0 || !SAFE_SEGMENT.test(harness ?? "") || !SAFE_SEGMENT.test(id ?? "")) {
    return null;
  }
  return join(configDir, CAPTURE_DIRNAME, harness, `${id}.json`);
}

/** The capture for a `harness/id` session key; null when none was recorded. */
export function readCapturedSession(
  key: string,
  configDir: string = getConfigDir(),
): CapturedSession | null {
  const path = capturePath(configDir, key);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      ...(typeof raw.dir === "string" ? { dir: raw.dir } : {}),
      ...(typeof raw.branch === "string" ? { branch: raw.branch } : {}),
      at: typeof raw.at === "string" ? raw.at : "",
    };
  } catch {
    return null;
  }
}

/** Merge a turn's capture into the session's record. A turn on a detached HEAD (mid-rebase)
 * keeps the branch an earlier turn captured. */
export function recordCapturedSession(
  key: string,
  update: { dir?: string; branch?: string | null },
  configDir: string = getConfigDir(),
  now: Date = new Date(),
): boolean {
  const path = capturePath(configDir, key);
  if (!path) return false;
  const previous = readCapturedSession(key, configDir);
  const dir = update.dir ?? previous?.dir;
  const branch = update.branch ?? previous?.branch;
  const record: CapturedSession = {
    ...(dir ? { dir } : {}),
    ...(branch ? { branch } : {}),
    at: now.toISOString(),
  };
  try {
    const parent = join(path, "..");
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    logger.debug("sync", `could not record ${key}: ${(err as Error).message}`);
    return false;
  }
}

export interface CaptureDeps {
  currentBranch?: (dir: string) => string | null;
  configDir?: string;
  now?: Date;
}

/** Record the branch from a Cursor `stop` hook payload; other agents' payloads are ignored.
 * `stop` fires every turn, so the latest turn's branch wins. */
export function captureCursorStop(payload: unknown, deps: CaptureDeps = {}): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const hook = payload as Record<string, unknown>;
  if (hook.cursor_version === undefined) return false;

  // The scanner keys Cursor sessions by the transcript's filename stem.
  const id =
    typeof hook.transcript_path === "string" && hook.transcript_path.endsWith(".jsonl")
      ? basename(hook.transcript_path, ".jsonl")
      : hook.conversation_id;
  if (typeof id !== "string") return false;
  const roots = hook.workspace_roots;
  const dir = Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : undefined;
  if (!dir?.startsWith("/")) return false;

  const branch = (deps.currentBranch ?? currentBranchOfDir)(dir);
  return recordCapturedSession(`cursor/${id}`, { dir, branch }, deps.configDir, deps.now);
}

type HookStdin = NodeJS.ReadableStream & { isTTY?: boolean; destroy?: () => void };

/** A hook's JSON stdin payload; null on a TTY, bad JSON, or past the size or time bound. */
export function readHookStdin(
  stream: HookStdin = process.stdin,
  timeoutMs: number = HOOK_STDIN_TIMEOUT_MS,
  maxBytes: number = HOOK_STDIN_MAX_BYTES,
): Promise<unknown> {
  if (stream.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.pause();
      stream.destroy?.();
      resolve(value);
    };
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return finish(null);
      chunks.push(buf);
    });
    stream.on("end", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        finish(null);
      }
    });
    stream.on("error", () => finish(null));
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** A session a hook reported as ended, for `knowledge sync --ended`/`--ended-path`. */
export interface EndedSession {
  /** With `id`, the scanner's key for the session. */
  harness?: SessionHarness;
  id?: string;
  /** Its transcript: matches the scanned session at that path, and finds one outside the
   * scanned roots when harness and id are known too. */
  path?: string;
}

type HookPayload = Record<string, unknown>;

/** Claude Code `SessionEnd`: `{session_id, transcript_path, hook_event_name, reason, cwd}`. */
function claudeSessionEnd(hook: HookPayload): EndedSession | null {
  if (hook.hook_event_name !== "SessionEnd") return null;
  const id = hook.session_id;
  const path = hook.transcript_path;
  if (typeof id !== "string" || !SAFE_SEGMENT.test(id) || typeof path !== "string") return null;
  // Claude Code names the transcript after the session; another agent's SessionEnd (Codex names
  // a rollout file) is not this one.
  if (basename(path) !== `${id}.jsonl`) return null;
  return { harness: "claude", id, path };
}

/** Codex `SessionEnd` (0.160+): `{session_id, transcript_path, cwd, hook_event_name, reason}`.
 * The scanner names a Codex session by its rollout file, `rollout-<time>-<session id>.jsonl`. */
function codexSessionEnd(hook: HookPayload): EndedSession | null {
  if (hook.hook_event_name !== "SessionEnd") return null;
  const uuid = hook.session_id;
  const path = hook.transcript_path;
  if (typeof uuid !== "string" || !SAFE_SEGMENT.test(uuid) || typeof path !== "string") return null;
  const id = basename(path, ".jsonl");
  if (!id.startsWith("rollout-") || !id.endsWith(`-${uuid}`) || !SAFE_SEGMENT.test(id)) return null;
  return { harness: "codex", id, path };
}

/** OpenCode, from Dosu's plugin (src/hooks/opencode.ts): `{agent: "opencode", hook_event_name:
 * "opencode.session.end", session_id}`, sent for each session that ran in an opencode process as
 * the process shuts down. Its sessions live in a shared DB, so there is no transcript path. */
function opencodeSessionEnd(hook: HookPayload): EndedSession | null {
  if (hook.agent !== "opencode" || hook.hook_event_name !== "opencode.session.end") return null;
  const id = hook.session_id;
  if (typeof id !== "string" || !SAFE_SEGMENT.test(id)) return null;
  return { harness: "opencode", id };
}

/** One reader per agent for its definitive end-of-session event. Per-turn events (Cursor
 * `stop`, Codex `Stop` before 0.160, OpenCode's `session.idle`) never count: they fire while the
 * session goes on. */
const END_EVENT_READERS: ReadonlyArray<(hook: HookPayload) => EndedSession | null> = [
  claudeSessionEnd,
  codexSessionEnd,
  opencodeSessionEnd,
];

/** The session a hook payload says just ended; null when the payload is not an end event. */
export function endedSessionOf(payload: unknown): EndedSession | null {
  if (typeof payload !== "object" || payload === null) return null;
  for (const read of END_EVENT_READERS) {
    const ended = read(payload as HookPayload);
    if (ended) return ended;
  }
  return null;
}

/** The `knowledge sync` flags that hand an ended session to the detached run: one value per
 * session, `--ended <harness>:<id>[=<transcript>]`, so a session's transcript can never be
 * paired with another's; a session known only by its transcript is `--ended-path <transcript>`. */
export function endedSessionArgs(ended: EndedSession): string[] {
  if (ended.harness && ended.id) {
    return ["--ended", `${ended.harness}:${ended.id}${ended.path ? `=${ended.path}` : ""}`];
  }
  return ended.path ? ["--ended-path", ended.path] : [];
}

/** `--ended <harness>:<id>[=<transcript>]`: ids are SAFE_SEGMENT, so the first `=` ends one. */
const ENDED_VALUE = /^([a-z]+):([A-Za-z0-9_-]+)(?:=(\/.*))?$/s;

/** `--ended` and `--ended-path` values back into sessions, each value its own session. Malformed
 * values are dropped: a hook-triggered run never fails loudly. */
export function parseEndedSessionArgs(
  ids: readonly string[],
  paths: readonly string[],
): EndedSession[] {
  const ended: EndedSession[] = [];
  for (const value of ids) {
    const [, harness, id, path] = ENDED_VALUE.exec(value) ?? [];
    if (!SESSION_HARNESSES.includes(harness as SessionHarness)) continue;
    ended.push({ harness: harness as SessionHarness, id, ...(path ? { path } : {}) });
  }
  for (const path of paths) if (path.startsWith("/")) ended.push({ path });
  return ended;
}

/** Hook-side capture before a detached sync: reads the hook payload, records what it can, and
 * returns the session that just ended, if the hook says one did. Never throws; a failed capture
 * only means the reflog has to answer later and the session waits out the quiet period. */
export async function captureHookSession(stream?: HookStdin): Promise<EndedSession | null> {
  try {
    const payload = await readHookStdin(stream);
    if (payload === null) return null;
    captureCursorStop(payload);
    return endedSessionOf(payload);
  } catch (err) {
    logger.debug("sync", `hook capture failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
