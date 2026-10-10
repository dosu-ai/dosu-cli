/** Shared scan of the gated local-session backlog: what's queued to mine and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { isIncognitoSession, partitionIncognitoSessions } from "./incognito";
import {
  filterSessionsByRepo,
  gateSessions,
  isAgentIncognito,
  loadSyncState,
  studyRepoFilter,
} from "./watermark";

export interface SessionBacklog {
  /** Gated (quiet, not yet studied) sessions, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
  /** Gated sessions the user opted out of, with `/dosu-incognito` or by putting their agent in
   * incognito; never studied. Optional so
   * callers that only fake `queued`/`open` keep compiling. */
  incognito?: AgentSession[];
}

/** Full-history scan of the gated backlog, oldest first; a failed scan reads as empty. */
export function listSessionBacklog(): SessionBacklog {
  try {
    const state = loadSyncState();
    const scanned = scanAgentSessions({});
    const resolver = createProjectDirResolver();
    const filter = studyRepoFilter(state, () => scanned, resolver);
    const sessions = filterSessionsByRepo(scanned, filter, resolver.resolveRepo);
    resolver.flush();
    const gate = gateSessions(sessions, state.watermark);
    // Only the gated backlog is read for the marker: everything behind the watermark is settled.
    const { kept, skipped } = partitionIncognitoSessions(
      gate.ready,
      (session) => isAgentIncognito(state, session) || isIncognitoSession(session),
    );
    return { queued: kept.reverse(), open: gate.open.reverse(), incognito: skipped.reverse() };
  } catch {
    return { queued: [], open: [], incognito: [] };
  }
}
