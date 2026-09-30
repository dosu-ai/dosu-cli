/** Shared scan of the gated local-session backlog: what's queued to ship and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { partitionIncognitoSessions } from "./incognito";
import { SCAN_WINDOW_DAYS } from "./sync";
import { filterSessionsByProject, gateSessions, loadSyncState } from "./watermark";

export interface SessionBacklog {
  /** Gated (quiet, not yet shipped) sessions, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
  /** Gated sessions the user opted out of with `/dosu-incognito`; never shipped. Optional so
   * callers that only fake `queued`/`open` keep compiling. */
  incognito?: AgentSession[];
}

/** The gated backlog within the sync's own scan window, oldest first; a failed scan reads as
 * empty. */
export function listSessionBacklog(now: Date = new Date()): SessionBacklog {
  try {
    const state = loadSyncState();
    const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    let sessions = scanAgentSessions({ since });
    if (state.project_filter?.length) {
      const resolver = createProjectDirResolver();
      sessions = filterSessionsByProject(sessions, state.project_filter, resolver.resolve);
      resolver.flush();
    }
    const gate = gateSessions(sessions, state.watermark);
    // Only the gated backlog is read for the marker: everything behind the watermark is settled.
    const { kept, skipped } = partitionIncognitoSessions(gate.ready);
    return { queued: kept.reverse(), open: gate.open.reverse(), incognito: skipped.reverse() };
  } catch {
    return { queued: [], open: [], incognito: [] };
  }
}
