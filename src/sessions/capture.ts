/** Session facts an agent hook captured while the session ran, for agents whose transcripts do not
 * record them (Cursor records neither its branch nor its working directory). One small file per
 * session, never dropped like the project-dir cache: a lost branch means the session is never
 * studied. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { currentBranchOfDir } from "./repo";

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
    logger.debug("sync", `could not record ${key}: ${err instanceof Error ? err.message : err}`);
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

/** Hook-side capture before a detached sync: reads the hook payload and records what it can.
 * Never throws; a failed capture only means the reflog has to answer later. */
export async function captureHookSession(stream?: HookStdin): Promise<void> {
  try {
    const payload = await readHookStdin(stream);
    if (payload !== null) captureCursorStop(payload);
  } catch (err) {
    logger.debug("sync", `hook capture failed: ${err instanceof Error ? err.message : err}`);
  }
}
