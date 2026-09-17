/** Per-session incognito opt-out detection for the ship step, following the convention the open
 * /dosu-incognito PR (#224) introduces: the slash command's expansion carries a marker token that
 * the harness records in the transcript, so the transcript itself is the switch — no session-id
 * mapping, no extra state. Once #224 lands, its `src/sync/incognito.ts` is the shared home for
 * this check; keep the tokens in lockstep and dedupe then. */

import { readFileSync } from "node:fs";
import { readSessionTurns } from "../sessions/read";
import type { AgentSession } from "../sessions/scan";

/** The token the slash command body carries; versioned so the shape can evolve. */
export const INCOGNITO_MARKER = "dosu:incognito:v1";

/** Claude Code records a slash command as `<command-name>/name</command-name>` before (or
 * instead of) the expanded body, so the command name itself is a second, equivalent marker. */
const COMMAND_NAME_MARKER = "/dosu-incognito</command-name>";

export function textHasIncognitoMarker(text: string): boolean {
  return text.includes(INCOGNITO_MARKER) || text.includes(COMMAND_NAME_MARKER);
}

/** Whether a scanned session opted out. File-backed harnesses scan the raw transcript; opencode
 * (SQLite) falls back to the parsed turns. Never throws; unreadable reads as not incognito. */
export function isIncognitoSession(session: AgentSession): boolean {
  if (session.harness === "opencode") {
    return readSessionTurns(session).some((turn) => textHasIncognitoMarker(turn.text));
  }
  try {
    return textHasIncognitoMarker(readFileSync(session.path, "utf8"));
  } catch {
    return false;
  }
}
