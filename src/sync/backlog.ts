/** Shared scan of the pending local-session backlog: what's queued to ship and what's still
 * open (inside the quiet period). Used by the Activity TUI and `dosu knowledge sessions`. */

import { sessionLineage } from "../sessions/lineage";
import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, type SessionHarness, scanAgentSessions } from "../sessions/scan";
import { VERSION } from "../version/version";
import { isIncognitoSession, partitionIncognitoSessions } from "./incognito";
import {
  filterSessionsByRepo,
  gateSessions,
  isAgentIncognito,
  isUnanswered,
  loadSyncState,
  type SyncState,
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
  /** Gated sessions the user opted out of, with `/dosu-incognito` or by putting their agent in
   * incognito; never shipped. Optional so callers that only fake `queued`/`open` keep compiling. */
  incognito?: AgentSession[];
  /** Pending subagents' transcripts. Each ships with the session it worked for, so the lists
   * above name only sessions. */
  subagents?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every session in the sync's own scan window, plus the transcripts outside the scanned roots
 * that the sync remembers and would ship too; back to `from` instead when that is longer ago. */
export function scanWindowSessions(
  state: Pick<SyncState, "outside_sessions">,
  now: Date = new Date(),
  from?: Date,
  onUnreadable?: (harness: SessionHarness, path: string) => void,
): AgentSession[] {
  const window = now.getTime() - SCAN_WINDOW_DAYS * DAY_MS;
  const since = new Date(Math.min(window, from?.getTime() ?? window));
  return withOutsideSessions(
    scanAgentSessions({ since, onUnreadable }),
    [],
    state.outside_sessions ?? {},
    since,
  ).sessions;
}

/** The sessions `dosu knowledge incognito off` seals from (scanWindowSessions back to `from`),
 * which must not take a place it could not read for one with no sessions in it: throws, naming
 * it, when it is one of `harnesses`' (the agents leaving incognito), so nothing is saved. */
export function sessionsToSeal(
  state: Pick<SyncState, "outside_sessions">,
  from: Date,
  harnesses: ReadonlySet<string>,
  now: Date = new Date(),
): AgentSession[] {
  const unreadable: string[] = [];
  const sessions = scanWindowSessions(state, now, from, (harness, path) => {
    if (harnesses.has(harness)) unreadable.push(path);
  });
  if (unreadable.length > 0) throw new Error(`could not read ${unreadable[0]}`);
  return sessions;
}

/** The pending backlog within the sync's own scan window, oldest first; a failed scan reads as
 * empty. */
export function listSessionBacklog(now: Date = new Date()): SessionBacklog {
  try {
    const state = loadSyncState();
    const scanned = scanWindowSessions(state, now);
    const resolver = createProjectDirResolver();
    const filter = studyRepoFilter(state, () => scanned, resolver);
    // The same ledger rules the sync applies, so the queue lists exactly what it would ship.
    const gate = gateSessions(scanned, state.sessions, { cliVersion: VERSION, now });
    // An incognito agent's sessions, and their subagents, are set aside as the sync sets them
    // aside: never queued, never waited for, never counted.
    const lineage = sessionLineage(scanned);
    const agentOff = (session: AgentSession) => isAgentIncognito(state, session, lineage);
    // One pending only for another CLI version's answer the sync leaves be (isUnanswered).
    const ready = filterSessionsByRepo(
      gate.ready.filter(
        (session) =>
          !agentOff(session) || isUnanswered(session, state.sessions[sessionKey(session)]),
      ),
      filter,
      resolver.resolveRepo,
    );
    const open = filterSessionsByRepo(
      gate.open.filter((session) => !agentOff(session)),
      filter,
      resolver.resolveRepo,
    );
    resolver.flush();
    // Only pending sessions are read for the marker: settled ones already have their answer.
    const { kept, skipped } = partitionIncognitoSessions(
      withoutSubagents(ready),
      (session) => agentOff(session) || isIncognitoSession(session),
    );
    return {
      queued: kept.reverse(),
      open: withoutSubagents(open).reverse(),
      incognito: skipped.reverse(),
      subagents: [...ready, ...open].filter((s) => s.parentId && !agentOff(s)).length,
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
  const scanned = scanWindowSessions(state, now);
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
