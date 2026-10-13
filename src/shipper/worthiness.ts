/** Whether a session is worth shipping, judged on what would actually ship: its normalized,
 * redacted trajectory. Size rather than turn counts, so a terse agent run whose substance is
 * tool traffic counts as much as a chatty one. */

import type { NormalizedRecord } from "@letta-ai/trajectory";

/** Less content than this, across everything but the meta record, is a greeting rather than an
 * investigation. */
export const MIN_SESSION_CHARS = 2000;

/** Trivial when the records hold no user record, nothing answering it (no assistant or tool
 * record), or under MIN_SESSION_CHARS characters of text, tool arguments, and tool results. */
export function isTrivialTrajectory(records: readonly NormalizedRecord[]): boolean {
  let asked = false;
  let answered = false;
  let chars = 0;
  for (const record of records) {
    if (record.role === "meta") continue;
    if (record.role === "user") asked = true;
    if (record.role === "assistant" || record.role === "tool") answered = true;
    if (typeof record.content === "string") chars += record.content.length;
    if ("tool_calls" in record) {
      for (const call of record.tool_calls) chars += call.args.length;
    }
  }
  return !asked || !answered || chars < MIN_SESSION_CHARS;
}
