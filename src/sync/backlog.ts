/** Shared scan of the pending local-session backlog: what's queued to ship and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { VERSION } from "../version/version";
import { partitionIncognitoSessions } from "./incognito";
import { filterSessionsByRepo, gateSessions, loadSyncState, studyRepoFilter } from "./state";
import { SCAN_WINDOW_DAYS, withOutsideSessions } from "./sync";

export interface SessionBacklog {
  /** Pending sessions past the quiet period, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
  /** Gated sessions the user opted out of with `/dosu-incognito`; never shipped. Optional so
   * callers that only fake `queued`/`open` keep compiling. */
  incognito?: AgentSession[];
}

/** The pending backlog within the sync's own scan window, oldest first; a failed scan reads as
 * empty. */
export function listSessionBacklog(now: Date = new Date()): SessionBacklog {
  try {
    const state = loadSyncState();
    const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // Plus the transcripts outside the scanned roots that the sync remembers and would ship too.
    const { sessions: scanned } = withOutsideSessions(
      scanAgentSessions({ since }),
      [],
      state.outside_sessions ?? {},
      since,
    );
    const resolver = createProjectDirResolver();
    const filter = studyRepoFilter(state, () => scanned, resolver);
    // The same ledger rules the sync applies, so the queue lists exactly what it would ship.
    const gate = gateSessions(scanned, state.sessions, { cliVersion: VERSION, now });
    const ready = filterSessionsByRepo(gate.ready, filter, resolver.resolveRepo);
    const open = filterSessionsByRepo(gate.open, filter, resolver.resolveRepo);
    resolver.flush();
    // Only pending sessions are read for the marker: settled ones already have their answer.
    const { kept, skipped } = partitionIncognitoSessions(ready);
    return { queued: kept.reverse(), open: open.reverse(), incognito: skipped.reverse() };
  } catch {
    return { queued: [], open: [], incognito: [] };
  }
}
