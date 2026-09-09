/** Shared scan of the gated local-session backlog: what's queued to mine and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { filterSessionsByProject, gateSessions, loadSyncState } from "./watermark";

export interface SessionBacklog {
  /** Gated (quiet, not yet mined) sessions, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
}

/** Full-history scan of the gated backlog, oldest first; a failed scan reads as empty. */
export function listSessionBacklog(): SessionBacklog {
  try {
    const state = loadSyncState();
    let sessions = scanAgentSessions({});
    if (state.project_filter?.length) {
      const resolver = createProjectDirResolver();
      sessions = filterSessionsByProject(sessions, state.project_filter, resolver.resolve);
      resolver.flush();
    }
    const gate = gateSessions(sessions, state.watermark);
    return { queued: gate.ready.reverse(), open: gate.open.reverse() };
  } catch {
    return { queued: [], open: [] };
  }
}
