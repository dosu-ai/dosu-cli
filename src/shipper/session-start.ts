/** What a session's records say about the branch it began on, read the same way by the ship step
 * and by a prompt hook that cannot tell from its payload whether the session began before it, so
 * a session's prompts and its upload agree: the branch its transcript recorded as it began
 * (Claude Code's earliest `gitBranch`, Codex's `session_meta`, as the meta record's
 * `git_branch`), and when its own first prompt was, past any history a fork copied: the moment
 * to ask the reflog about when it recorded none. */

import type { NormalizedRecord } from "@letta-ai/trajectory";
import { recordedBranch } from "../sessions/branch";
import type { SessionStart } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { copiedPrefix, type ShippedPrefix } from "./continuation";
import { normalizeSessionRecords } from "./normalize";

type Normalize = (session: AgentSession) => Promise<NormalizedRecord[] | null>;

/** The prefix a fork copied from the session it was made from; undefined for any other session,
 * or when nothing is shared. */
export async function forkCopy(
  session: AgentSession,
  records: readonly NormalizedRecord[],
  normalize: Normalize,
): Promise<ShippedPrefix | undefined> {
  if (!session.forkOf) return undefined;
  const { id, path } = session.forkOf;
  return copiedPrefix(
    records,
    await normalize({ harness: session.harness, id, path, updated: "" }),
  );
}

/** The start of a session whose records are at hand; `copied` is what a fork copied. */
export function sessionStartOf(
  records: readonly NormalizedRecord[],
  copied?: ShippedPrefix,
): SessionStart {
  const first = records[0];
  const meta = first?.role === "meta" ? first : undefined;
  const own = records.slice(copied?.records ?? 0);
  return {
    recorded: recordedBranch(meta?.git_branch),
    firstPromptAt: own.find((record) => record.role === "user")?.timestamp,
  };
}

/** The start of a session read from its transcript, as a prompt hook sees it (opencode's DB read
 * directly, without starting its binary); null when the transcript cannot be normalized. */
export async function readSessionStart(session: AgentSession): Promise<SessionStart | null> {
  const normalize: Normalize = (s) => normalizeSessionRecords(s, { opencodeBinary: false });
  const records = await normalize(session);
  if (!records) return null;
  return sessionStartOf(records, await forkCopy(session, records, normalize));
}
