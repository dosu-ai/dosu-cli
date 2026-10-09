/** Where a session comes from, read off the transcripts on disk: the session it is a subagent of
 * (`parentId`) and the one it was forked or branched from (`forkOf`), for whichever harness
 * records them. The scan reports subagents and pi's forks; a Codex fork (`forked_from_id` in its
 * `session_meta`) and a Claude Code branch (`forkedFrom` on the records it copied) are read here,
 * on demand, so the scan stays a listing. Used where a session's lineage decides whether it is off
 * the record: by the sync, which has a scan, and by the prompt hook, the MCP proxy and the status
 * line, which have only the one session. */

import { basename } from "node:path";
import { codexOrigin, codexRolloutNear } from "./codex-lineage";
import { opencodeLineage } from "./opencode";
import { type AgentSession, claudeForkOf, parentSessionOf, sessionAtPath } from "./scan";

/** A session's links up its lineage. */
export type SessionLinks = Pick<AgentSession, "parentId" | "forkOf">;

function keyOf(session: Pick<AgentSession, "harness" | "id">): string {
  return `${session.harness}/${session.id}`;
}

/** The links a session already carries (the scan's, or sessionAtPath's), and the ones its
 * transcript adds, with the sessions they lead to where those can be found (to read their links in
 * turn). */
function originsOf(session: AgentSession): { links: SessionLinks; next: AgentSession[] } {
  const links: SessionLinks = {
    ...(session.parentId ? { parentId: session.parentId } : {}),
    ...(session.forkOf ? { forkOf: session.forkOf } : {}),
  };
  const next: AgentSession[] = [];
  switch (session.harness) {
    case "claude": {
      if (session.parentId) {
        const parent = parentSessionOf(session);
        if (parent) next.push(parent);
        break;
      }
      links.forkOf ??= claudeForkOf(session.path);
      const source = links.forkOf && sessionAtPath("claude", links.forkOf.id, links.forkOf.path);
      if (source) next.push(source);
      break;
    }
    case "codex": {
      const origin = codexOrigin(session.path);
      if (!origin) break;
      // Named as the scan names it: the rollout's stem, or the bare thread once that is gone.
      const rollout = codexRolloutNear(origin.thread, session.path);
      const id = rollout ? basename(rollout, ".jsonl") : origin.thread;
      if (origin.subagent) links.parentId ??= id;
      else if (rollout) links.forkOf ??= { id, path: rollout };
      const source = rollout && sessionAtPath("codex", id, rollout);
      if (source) next.push(source);
      break;
    }
    case "pi": {
      const source = links.forkOf && sessionAtPath("pi", links.forkOf.id, links.forkOf.path);
      if (source) next.push(source);
      break;
    }
    case "opencode": {
      if (!session.parentId) break;
      // The chain up from here, each with the parent its row names.
      const [, ...ancestors] = opencodeLineage(session);
      ancestors.forEach((ancestor, i) => {
        const parentId = ancestors[i + 1]?.id;
        next.push(parentId ? { ...ancestor, parentId } : ancestor);
      });
      break;
    }
    case "cursor":
      break;
  }
  return { links, next };
}

/** isAgentIncognito's `lineageOf` for `sessions` (a scan, or the one session a hook or call names)
 * and every session up their lineage: a session's links, by key, read from its transcript when
 * first asked for and kept for the rest of the lookup. Undefined for a session it was never led
 * to. */
export function sessionLineage(
  sessions: readonly AgentSession[],
): (key: string) => SessionLinks | undefined {
  const known = new Map(sessions.map((s) => [keyOf(s), s]));
  const read = new Map<string, SessionLinks>();
  return (key) => {
    const cached = read.get(key);
    if (cached) return cached;
    const session = known.get(key);
    if (!session) return undefined;
    const { links, next } = originsOf(session);
    for (const origin of next) if (!known.has(keyOf(origin))) known.set(keyOf(origin), origin);
    read.set(key, links);
    return links;
  };
}
