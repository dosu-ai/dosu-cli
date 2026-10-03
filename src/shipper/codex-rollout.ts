/** Codex rollouts, adjusted around what @letta-ai/trajectory's codex adapter does with them.
 *
 * When a subagent finishes, Codex tells its parent by injecting a user message that starts with
 * `<subagent_notification>` and carries the subagent's final answer. The adapter keeps it as a
 * user record, which passes the report off as something the user said. It is input the parent
 * received and acted on next, so it ships in place as an `observation` record (the subagent's
 * own work ships separately, linked by `parent_session_id`), the way Claude Code's
 * `<task-notification>` does. */

import type { NormalizedRecord } from "@letta-ai/trajectory";

const SUBAGENT_REPORT_PREFIX = "<subagent_notification>";

/** The normalized records with each subagent report turned into an observation. */
export function subagentReportsAsObservations(records: NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) =>
    record.role === "user" && record.content.trimStart().startsWith(SUBAGENT_REPORT_PREFIX)
      ? { role: "observation", content: record.content, timestamp: record.timestamp }
      : record,
  );
}
