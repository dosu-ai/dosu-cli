/** OpenCode keeps sessions in a sqlite DB, not a transcript file. The trajectory adapter reads the
 * whole-session document `opencode export <id>` prints, `{ info, messages: [{ info, parts }] }`;
 * this module produces it. The opencode binary, when one is on PATH, is asked first: it reads its
 * own storage whatever shape that takes next (1.18 already carries a second, unused message
 * table). Otherwise the document is rebuilt from the session, message, and part rows, which
 * normalizes to the same records. */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { logger } from "../debug/logger";
import { type AgentSession, querySqlite } from "./scan";

/** Metadata key on the text part the Dosu plugin adds to a user message: the memory digest pushed
 * at prompt time. Left out of what ships, so memory never comes back as something the user said
 * (Claude Code's transcript keeps its hook context in records the adapter drops, too). */
const DOSU_MEMORY_PART_FLAG = "dosu_memory";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A long session exports in well under a second; the cap only bounds a wedged binary. */
const EXPORT_TIMEOUT_MS = 60_000;
const EXPORT_MAX_BYTES = 512 * 1024 * 1024;

type Json = Record<string, unknown>;

interface OpencodeDocument {
  info: Json;
  messages: { info: Json; parts: Json[] }[];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: unknown): Json | null {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** `opencode export --pure <id>`: `--pure` skips external plugins, Dosu's own among them, so an
 * export never loads the plugin that triggered it. Run from the temp dir, where no project config
 * applies. Null when no binary answers with this session's document. */
function exportWithBinary(id: string): OpencodeDocument | null {
  const result = spawnSync("opencode", ["export", "--pure", id], {
    cwd: tmpdir(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: EXPORT_TIMEOUT_MS,
    maxBuffer: EXPORT_MAX_BYTES,
  });
  if (result.error || result.status !== 0) return null;
  const doc = parseObject(result.stdout);
  if (!doc || !isObject(doc.info) || doc.info.id !== id || !Array.isArray(doc.messages)) {
    return null;
  }
  return doc as unknown as OpencodeDocument;
}

/** The export document rebuilt from the DB rows: message and part columns hold ids and links, the
 * `data` JSON the rest; messages in creation order, parts by id, as opencode reads them. */
function documentFromDb(dbPath: string, id: string): OpencodeDocument | null {
  const [session] =
    querySqlite(
      dbPath,
      "SELECT id, parent_id, directory, title, version, time_created, time_updated " +
        `FROM session WHERE id = '${id}'`,
    ) ?? [];
  if (!session) return null;
  const messages = querySqlite(
    dbPath,
    `SELECT id, data FROM message WHERE session_id = '${id}' ORDER BY time_created, id`,
  );
  const parts = querySqlite(
    dbPath,
    `SELECT id, message_id, data FROM part WHERE session_id = '${id}' ORDER BY message_id, id`,
  );
  if (!messages || !parts) return null;

  const partsOf = new Map<unknown, Json[]>();
  for (const row of parts) {
    const data = parseObject(row.data);
    if (!data) continue;
    const list = partsOf.get(row.message_id) ?? [];
    list.push({ ...data, id: row.id, sessionID: id, messageID: row.message_id });
    partsOf.set(row.message_id, list);
  }
  return {
    info: {
      id,
      directory: session.directory,
      title: session.title,
      version: session.version,
      ...(typeof session.parent_id === "string" ? { parentID: session.parent_id } : {}),
      time: { created: session.time_created, updated: session.time_updated },
    },
    messages: messages.flatMap((row) => {
      const data = parseObject(row.data);
      return data
        ? [{ info: { ...data, id: row.id, sessionID: id }, parts: partsOf.get(row.id) ?? [] }]
        : [];
    }),
  };
}

function isDosuMemory(part: unknown): boolean {
  return isObject(part) && isObject(part.metadata) && part.metadata[DOSU_MEMORY_PART_FLAG] === true;
}

/** The session's export document as JSON, without the memory Dosu pushed into it; null when
 * neither the binary nor the DB has the session. */
export function opencodeTranscript(session: AgentSession): string | null {
  if (!SAFE_ID.test(session.id)) return null;
  let doc = exportWithBinary(session.id);
  if (!doc) {
    logger.debug("sync", `opencode export unavailable for ${session.id}; reading the DB`);
    doc = documentFromDb(session.path, session.id);
  }
  if (!doc) return null;
  return JSON.stringify({
    ...doc,
    messages: doc.messages.map((message) => ({
      ...message,
      parts: Array.isArray(message.parts) ? message.parts.filter((p) => !isDosuMemory(p)) : [],
    })),
  });
}
