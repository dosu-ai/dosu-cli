/** Session → redacted Letta trajectory-v1 records, the wire format of every target. Reading the
 * raw log is this module's job (it is per machine: Claude's JSONL on disk, OpenCode's database
 * export); normalizing it, the per-harness fixups and redaction are `@dosu/sessionstorage`'s. */

import { readFileSync } from "node:fs";
import {
  type NormalizedRecord,
  NormalizeError,
  normalizeTranscript,
  trajectorySourceOf,
} from "@dosu/sessionstorage";
import { logger } from "../debug/logger";
import { opencodeTranscript } from "../sessions/opencode";
import type { AgentSession } from "../sessions/scan";

export { trajectorySourceOf };

export interface NormalizeOptions {
  /** Whether opencode's binary is asked for the session's export (default) before its DB rows
   * are read: a process start a waiting prompt can do without. */
  opencodeBinary?: boolean;
}

/** The raw transcript the adapter reads; null when unreadable. */
function readTranscript(session: AgentSession, options: NormalizeOptions = {}): string | null {
  if (session.harness === "opencode") {
    return opencodeTranscript(session, { binary: options.opencodeBinary });
  }
  try {
    return readFileSync(session.path, "utf8");
  } catch {
    return null;
  }
}

/** Normalize one session to redacted trajectory-v1 records: none for a log with no
 * conversation in it, null when the session cannot be normalized (unsupported harness,
 * unreadable log, or a transcript the adapter cannot parse). */
export async function normalizeSessionRecords(
  session: AgentSession,
  options: NormalizeOptions = {},
): Promise<NormalizedRecord[] | null> {
  const source = trajectorySourceOf(session.harness);
  if (!source) return null;
  const transcript = readTranscript(session, options);
  if (transcript === null) return null;
  try {
    const { records } = await normalizeTranscript({ source, transcript });
    return records;
  } catch (err) {
    const message =
      err instanceof NormalizeError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    logger.debug("sync", `normalization failed for ${session.harness}/${session.id}: ${message}`);
    return null;
  }
}
