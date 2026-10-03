/** Shared scan of the pending local-session backlog: what's queued to ship and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
import { VERSION } from "../version/version";
import { partitionIncognitoSessions } from "./incognito";
import {
  filterSessionsByRepo,
  gateSessions,
  loadSyncState,
  sessionKey,
  skipBacklog,
  studyRepoFilter,
  unsettledSessions,
  withoutSubagents,
} from "./state";
import { SCAN_WINDOW_DAYS, withOutsideSessions } from "./sync";

export interface SessionBacklog {
  /** Pending sessions past the quiet period, oldest first. */
  queued: AgentSession[];
  /** Sessions still inside the quiet period — queued once they go silent. */
  open: AgentSession[];
  /** Gated sessions the user opted out of with `/dosu-incognito`; never shipped. Optional so
   * callers that only fake `queued`/`open` keep compiling. */
  incognito?: AgentSession[];
  /** Pending subagents' transcripts. Each ships with the session it worked for, so the lists
   * above name only sessions. */
  subagents?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The pending backlog within the sync's own scan window, oldest first; a failed scan reads as
 * empty. */
export function listSessionBacklog(now: Date = new Date()): SessionBacklog {
  try {
    const state = loadSyncState();
    const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * DAY_MS);
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
    const { kept, skipped } = partitionIncognitoSessions(withoutSubagents(ready));
    return {
      queued: kept.reverse(),
      open: withoutSubagents(open).reverse(),
      incognito: skipped.reverse(),
      subagents: [...ready, ...open].filter((s) => s.parentId).length,
    };
  } catch {
    return { queued: [], open: [], incognito: [] };
  }
}

/** What `skipSessionBacklog` passed over: sessions, and the subagents' transcripts with them. */
export interface SkippedBacklog {
  sessions: number;
  subagents: number;
}

/** Settle as skipped by the user every session in the scan window and the repo scope that the
 * ledger has never settled and that was last active before `before`, as declining setup's
 * backfill offer does: none of them ships, while anything that finishes or changes from here on
 * still does. A subagent counts as active when its session was, so the two are decided together.
 * Ships nothing, and works with shipping switched off, so a provisioning script can set the
 * starting point before turning shipping on. Sessions outside the scope are left unsettled, for
 * a later, wider scope to decide. */
export function skipSessionBacklog(before: Date, now: Date = new Date()): SkippedBacklog {
  const state = loadSyncState();
  const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * DAY_MS);
  const { sessions: scanned } = withOutsideSessions(
    scanAgentSessions({ since }),
    [],
    state.outside_sessions ?? {},
    since,
  );
  const resolver = createProjectDirResolver();
  const filter = studyRepoFilter(state, () => scanned, resolver);
  const unsettled = filterSessionsByRepo(
    unsettledSessions(scanned, state),
    filter,
    resolver.resolveRepo,
  );
  resolver.flush();
  const updatedOf = new Map(scanned.map((s) => [sessionKey(s), Date.parse(s.updated)]));
  const skipped = unsettled.filter((session) => {
    const updated = Date.parse(session.updated);
    const parent = session.parentId && updatedOf.get(`${session.harness}/${session.parentId}`);
    const active = parent && parent > updated ? parent : updated;
    return active < before.getTime();
  });
  skipBacklog(skipped, VERSION, now);
  const subagents = skipped.filter((s) => s.parentId).length;
  return { sessions: skipped.length - subagents, subagents };
}
