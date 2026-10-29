/** Reading a session's native log is per machine (Claude's JSONL on disk, OpenCode's database
 * export); everything after that — normalizing, redacting, judging — is the server's. */

import { readFileSync } from "node:fs";
import { opencodeTranscript } from "../sessions/opencode";
import type { AgentSession } from "../sessions/scan";

/** How a harness's native log is shaped, which decides how the server redacts its raw copy. */
export function transcriptFormat(harness: string): "jsonl" | "json" {
  return harness === "opencode" || harness === "gemini" ? "json" : "jsonl";
}

/** The raw transcript, verbatim; null when unreadable. */
export function readTranscript(session: AgentSession): string | null {
  if (session.harness === "opencode") return opencodeTranscript(session, {});
  try {
    return readFileSync(session.path, "utf8");
  } catch {
    return null;
  }
}
