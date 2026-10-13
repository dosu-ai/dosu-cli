/** Gemini CLI transcripts. Gemini CLI records each session under its global runtime dir,
 * `~/.gemini/tmp/<project slug>/chats/session-<yyyy-mm-ddThh-mm>-<id prefix>.jsonl` (the home
 * is GEMINI_CLI_HOME when set), a subagent's beside its parent's in `chats/<parent session
 * id>/<session id>.jsonl`, and the project's directory in `tmp/<project slug>/.project_root`.
 * Since 0.63 the transcript is an append-only JSONL log: a metadata line (`sessionId`,
 * `projectHash`, `startTime`, ...), then one record per message (re-appended whole, under the
 * same id, each time it changes: a tool call's result lands that way), `{$set: {...}}` metadata
 * updates (whose `messages` is a checkpoint that replaces the history), `{$rewindTo: id}` (drops
 * that message and every later one) and `{$patch: {...}}` edits. Older releases wrote the whole
 * session as one JSON document, `session-*.json`; @letta-ai/trajectory's gemini-cli adapter reads
 * that document, so the log is folded back into one here, the way Gemini CLI itself loads it. */

import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The directory of a project's session logs, under its slug dir. */
export const GEMINI_CHATS_DIR = "chats";

/** The marker Gemini CLI writes in a project's slug dir, holding the project's directory. */
export const GEMINI_PROJECT_ROOT_FILE = ".project_root";

/** How much of a transcript holds its metadata line. */
const GEMINI_HEADER_BYTES = 16 * 1024;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Gemini CLI's home: GEMINI_CLI_HOME, else the user's. */
export function geminiHome(home: string, env: NodeJS.ProcessEnv): string {
  return env.GEMINI_CLI_HOME || home;
}

/** Where Gemini CLI keeps every project's sessions: `<home>/.gemini/tmp`. */
export function geminiTempDir(home: string, env: NodeJS.ProcessEnv): string {
  return join(geminiHome(home, env), ".gemini", "tmp");
}

/** Whether a file name is a Gemini CLI transcript: the current log or the legacy document, never
 * the `.tmp-<pid>` or `.unreadable-<time>` files Gemini CLI leaves beside them. */
export function isGeminiTranscriptName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".json");
}

/** A transcript's file stem, the scanner's id for the session. */
export function geminiSessionIdOfPath(path: string): string {
  const name = basename(path);
  return name.slice(0, name.length - (name.endsWith(".jsonl") ? ".jsonl" : ".json").length);
}

/** The `chats` dir a transcript lives in or under: `chats/<file>` for a session, `chats/<parent
 * id>/<file>` for a subagent's. Null for a path laid out some other way. */
export function geminiChatsDirOf(path: string): string | null {
  const dir = dirname(path);
  if (basename(dir) === GEMINI_CHATS_DIR) return dir;
  const parent = dirname(dir);
  return basename(parent) === GEMINI_CHATS_DIR ? parent : null;
}

/** The session a subagent's transcript belongs to, as its directory names it (the parent's
 * session id, which its metadata line carries); undefined for a session's own transcript. */
export function geminiParentIdOfPath(path: string): string | undefined {
  const dir = dirname(path);
  return basename(dir) !== GEMINI_CHATS_DIR && basename(dirname(dir)) === GEMINI_CHATS_DIR
    ? basename(dir)
    : undefined;
}

/** Where the transcript's project keeps its slug dir's root marker, when the layout is Gemini
 * CLI's; null otherwise. */
export function geminiProjectRootFileOf(path: string): string | null {
  const chats = geminiChatsDirOf(path);
  return chats ? join(dirname(chats), GEMINI_PROJECT_ROOT_FILE) : null;
}

/** The project directory recorded beside a transcript's `chats` dir; null when the marker is
 * missing (a dir from before 0.63 that was never migrated) or unreadable. */
export function geminiProjectDirOf(path: string): string | null {
  const marker = geminiProjectRootFileOf(path);
  if (!marker) return null;
  try {
    const dir = readFileSync(marker, "utf-8").trim();
    return dir.startsWith("/") ? dir : null;
  } catch {
    return null;
  }
}

/** The session id a transcript's metadata line carries (what a subagent's directory and the
 * hook payload name the session by); null when unreadable or not a Gemini CLI transcript. */
export function readGeminiSessionId(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(GEMINI_HEADER_BYTES);
    const text = buf.subarray(0, readSync(fd, buf, 0, GEMINI_HEADER_BYTES, 0)).toString("utf-8");
    // The log's first line, or the legacy document's opening: both start with the metadata.
    const match = /"sessionId"\s*:\s*"([^"\\]{1,200})"/.exec(text.split("\n", 1)[0] ?? "");
    return match?.[1] ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface GeminiDocument extends Json {
  messages: Json[];
}

function messageId(record: unknown): string | null {
  return isRecord(record) && typeof record.id === "string" ? record.id : null;
}

/** Fold Gemini CLI's JSONL log into the whole-session document it stands for, as Gemini CLI's own
 * loader does; the legacy document (one JSON object, possibly pretty-printed) comes back as is. */
export function geminiDocumentOf(text: string): GeminiDocument | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  let metadata: Json = {};
  const messages = new Map<string, Json>();
  let sawMetadata = false;

  const putAll = (records: unknown) => {
    for (const record of Array.isArray(records) ? records : []) {
      const id = messageId(record);
      if (id) messages.set(id, record as Json);
    }
  };
  const patch = (update: unknown) => {
    const id = messageId(update);
    if (!id) return;
    const existing = messages.get(id);
    if (!existing) return;
    const { id: _, toolCalls, ...rest } = update as Json;
    const merged: Json = { ...existing, ...rest };
    if (Array.isArray(toolCalls) && Array.isArray(existing.toolCalls)) {
      const calls = (existing.toolCalls as unknown[]).map((call) =>
        isRecord(call) ? { ...call } : call,
      );
      for (const callPatch of toolCalls) {
        if (!isRecord(callPatch) || typeof callPatch.id !== "string") continue;
        const call = calls.find((c) => isRecord(c) && c.id === callPatch.id);
        if (isRecord(call)) Object.assign(call, callPatch);
      }
      merged.toolCalls = calls;
    }
    messages.set(id, merged);
  };

  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A line cut short by a crash, or one still being written: skipped, as Gemini CLI does.
      continue;
    }
    if (!isRecord(record)) continue;
    if (typeof record.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const at = ids.indexOf(record.$rewindTo);
      for (const id of at === -1 ? ids : ids.slice(at)) messages.delete(id);
    } else if (isRecord(record.$patch)) {
      const edit = record.$patch;
      if (typeof edit.id === "string") patch(edit);
      for (const update of Array.isArray(edit.updates) ? edit.updates : []) patch(update);
      for (const id of Array.isArray(edit.removeIds) ? edit.removeIds : []) {
        if (typeof id === "string") messages.delete(id);
      }
      if (Array.isArray(edit.orderIds)) {
        const ordered = edit.orderIds.filter(
          (id): id is string => typeof id === "string" && messages.has(id),
        );
        const rest = [...messages].filter(([id]) => !ordered.includes(id));
        const moved = ordered.map((id) => [id, messages.get(id) as Json] as const);
        messages.clear();
        for (const [id, message] of [...rest, ...moved]) messages.set(id, message);
      }
    } else if (isRecord(record.$set)) {
      const { messages: checkpoint, ...rest } = record.$set;
      if (Array.isArray(checkpoint)) {
        messages.clear();
        putAll(checkpoint);
      }
      metadata = { ...metadata, ...rest };
    } else if (typeof record.sessionId === "string" && typeof record.projectHash === "string") {
      // The metadata line, or the whole legacy document on one line.
      const { messages: legacy, ...rest } = record;
      metadata = { ...metadata, ...rest };
      putAll(legacy);
      sawMetadata = true;
    } else if (typeof record.id === "string") {
      messages.set(record.id, record);
    }
  }
  if (!sawMetadata && messages.size === 0) {
    // Not a log: a pretty-printed legacy document, which parses whole or not at all.
    try {
      const document = JSON.parse(trimmed) as unknown;
      if (!isRecord(document) || !Array.isArray(document.messages)) return null;
      return document as GeminiDocument;
    } catch {
      return null;
    }
  }
  return { ...metadata, messages: [...messages.values()] };
}

/** The transcript as the gemini-cli trajectory adapter reads it: the whole-session JSON document.
 * Null when the file is unreadable or not a Gemini CLI transcript. */
export function geminiTranscript(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (text.trim() === "") return "";
  const document = geminiDocumentOf(text);
  return document ? JSON.stringify(document) : null;
}

/** The text of a message's `content` (a string, a part, or parts; text parts only). */
export function geminiContentText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}
