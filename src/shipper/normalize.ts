/** Session → redacted Letta trajectory-v1 records, the wire format of the Dosu memory ingest
 * API. Normalization is @letta-ai/trajectory's job; this module only picks the source, reads the
 * raw log, and redacts. Redaction runs on the normalized records — every string that ships passes
 * through redactSecrets — rather than on the raw log, where the entropy pass would corrupt
 * high-entropy tool-call ids and break the records' internal linkage. */

import { readFileSync } from "node:fs";
import type { NormalizedRecord, TranscriptTrajectorySource } from "@letta-ai/trajectory";
import { logger } from "../debug/logger";
import { redactSecrets } from "../sessions/redact";
import type { AgentSession } from "../sessions/scan";

/** Harness → trajectory source. opencode is absent: its adapter wants the exported
 * `{ info, messages }` session JSON, which the scanner's sqlite rows do not provide yet. */
const TRAJECTORY_SOURCES: Partial<Record<AgentSession["harness"], TranscriptTrajectorySource>> = {
  claude: "claude-code",
  cursor: "cursor",
  codex: "codex",
};

/** Keys whose string values are structural identity, not text: redacting them would break the
 * tool_call ↔ tool_result linkage or the record framing itself. Everything else is redacted. */
const STRUCTURAL_KEYS = new Set(["id", "tool_call_id", "role", "timestamp", "source", "name"]);

function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : redactSecrets(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

/** Apply redactSecrets to every non-structural string in the records — content, tool args, and
 * meta fields alike. Exported for the sentinel tests that pin the ship path's redaction. */
export function redactRecords(records: readonly NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) => redactValue(record) as NormalizedRecord);
}

/** Normalize one session to redacted trajectory-v1 records; null when the session cannot ship
 * (unsupported harness, unreadable or empty log, or a transcript the adapter rejects). */
export async function normalizeSessionRecords(
  session: AgentSession,
): Promise<NormalizedRecord[] | null> {
  const source = TRAJECTORY_SOURCES[session.harness];
  if (!source) return null;
  let transcript: string;
  try {
    transcript = readFileSync(session.path, "utf8");
  } catch {
    return null;
  }
  if (transcript.trim() === "") return null;
  try {
    // Dynamic so ship-free CLI paths never pay for the normalizer.
    const { normalizeTranscript } = await import("@letta-ai/trajectory");
    const { records } = normalizeTranscript({ source, transcript });
    return redactRecords(records);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug("sync", `normalization failed for ${session.harness}/${session.id}: ${message}`);
    return null;
  }
}
