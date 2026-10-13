/** pi transcripts: one JSONL file per session, opening with a `type: "session"` header that names
 * the session, its working directory and, for a fork or clone, the transcript it was copied from.
 * The header, not the file name, is the session's identity: `pi --session <path>` keeps whatever
 * name the caller chose. */

import { closeSync, openSync, readSync } from "node:fs";

/** The session ids pi accepts (its own assertValidSessionId): `--session-id` lets the caller pick
 * one, dots included. */
export const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** How much of a pi transcript holds its header line. */
const PI_HEADER_BYTES = 16 * 1024;

export interface PiHeader {
  /** The session's id, when the header carries one pi would accept. */
  id?: string;
  /** For a fork or clone (`/fork`, `/clone`, `--fork`): the transcript it was copied from. */
  parentSession?: string;
}

/** The header pi writes as a transcript's first line; null when unreadable. */
export function readPiHeader(path: string): PiHeader | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(PI_HEADER_BYTES);
    const text = buf.subarray(0, readSync(fd, buf, 0, PI_HEADER_BYTES, 0)).toString("utf-8");
    const header = JSON.parse(text.split("\n", 1)[0] ?? "") as Record<string, unknown> | null;
    if (header?.type !== "session") return null;
    const { id, parentSession } = header;
    return {
      ...(typeof id === "string" && PI_SESSION_ID_PATTERN.test(id) ? { id } : {}),
      ...(typeof parentSession === "string" && parentSession.endsWith(".jsonl")
        ? { parentSession }
        : {}),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
