/** Transcript shipper — the sync pipeline's `ship` step. Per session: honor the incognito
 * opt-out, read the raw log, and hand it to the sessiondb server with what this machine knows
 * that the log does not (the project, a fallback branch, the session's lineage, what shipped
 * before). The server normalizes, redacts, and judges; its answer becomes the session's outcome
 * for the sync ledger. */

import type { ProjectKey } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { peekSessionStart, trajectorySourceOf } from "../sessions/start";
import { isIncognitoSession } from "../sync/incognito";
import type { ShipHold, ShipSessionResult, SyncDeps } from "../sync/sync";
import type { ShippedPrefix, Target } from "./target";
import { readTranscript, transcriptFormat } from "./transcript";

export interface ShipStepOptions {
  target: Target;
  /** Injectable boundaries, for tests. */
  isIncognito?: (session: AgentSession) => boolean;
  readTranscript?: (session: AgentSession) => string | null;
  resolveProject?: (session: AgentSession) => ProjectKey | null;
  /** `at`: when the session's own prompts began (ISO), the time to ask the reflog about. */
  resolveBranch?: (session: AgentSession, at?: string) => string | null;
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all ledger bookkeeping and says, per
 * session, what earlier runs already shipped of it, and whether the user's switches still let it
 * go (ShipHold). */
export function createShipStep(options: ShipStepOptions): NonNullable<SyncDeps["ship"]> {
  const { target } = options;
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const read = options.readTranscript ?? readTranscript;

  /** One session's result, or null when shipping was turned off before it was sent. */
  async function shipOne(
    session: AgentSession,
    shipped: ShippedPrefix | undefined,
    resolve: Required<Pick<ShipStepOptions, "resolveProject" | "resolveBranch">>,
    hold: ShipHold,
  ): Promise<ShipSessionResult | null> {
    const held = hold(session);
    if (held === "stop") return null;
    if (held === "agent") return { session, outcome: "incognito", byAgent: true };
    if (isIncognito(session)) return { session, outcome: "incognito" };
    const agent = trajectorySourceOf(session.harness);
    if (!agent) {
      return {
        session,
        outcome: "unsupported",
        message: `no normalizer for ${session.harness} sessions yet`,
      };
    }
    const transcript = read(session);
    if (transcript === null) {
      return { session, outcome: "unsupported", message: "transcript could not be read" };
    }
    // The project key of the session's working directory (sessions/project.ts), the same one
    // prompt-time memory sends.
    const project = resolve.resolveProject(session)?.project ?? "unknown";
    // The branch the session's prompts were served under or its checkout was on at its first
    // prompt; the server prefers what the transcript recorded itself (Claude Code, Codex).
    const start = peekSessionStart(session);
    const branch = start?.recorded ?? resolve.resolveBranch(session, start?.firstPromptAt);
    const parentSessionId = session.parentId ?? session.forkOf?.id;
    // Reading a long log takes a moment: the switch is read once more right before sending.
    const late = hold(session);
    if (late === "stop") return null;
    if (late === "agent") return { session, outcome: "incognito", byAgent: true };
    const sent = await target.send({
      agent,
      session_id: session.id,
      transcript,
      format: transcriptFormat(session.harness),
      project,
      ...(branch ? { branch } : {}),
      ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
      ...(session.forkOf ? { fork_of: session.forkOf.id } : {}),
      ...(shipped ? { shipped } : {}),
    });
    if (sent.status === "shipped") {
      return {
        session,
        outcome: "shipped",
        taskId: sent.taskId,
        project,
        // Everything up to here has now shipped, whether this upload was all of it or a tail.
        records: sent.shipped.records,
        prefixSha256: sent.shipped.prefix_sha256,
      };
    }
    if (sent.status === "trivial") return { session, outcome: "trivial" };
    if (sent.status === "rejected") {
      return {
        session,
        outcome: "rejected",
        ...(sent.httpStatus !== undefined ? { httpStatus: sent.httpStatus } : {}),
        message: sent.message,
      };
    }
    return { session, outcome: "failed", message: sent.message };
  }

  return async (sessions, shippedOf = () => undefined, hold = () => null, settled = () => {}) => {
    const resolver =
      options.resolveProject && options.resolveBranch ? undefined : createProjectDirResolver();
    const resolve = {
      resolveProject:
        options.resolveProject ?? ((session) => resolver?.resolveProject(session) ?? null),
      resolveBranch:
        options.resolveBranch ?? ((session, at) => resolver?.resolveBranch(session, at) ?? null),
    };
    const results: ShipSessionResult[] = [];
    for (const session of sessions) {
      const result = await shipOne(session, shippedOf(session), resolve, hold);
      // Shipping was turned off: the rest of the batch waits, pending, for it to be on again.
      if (result === null) break;
      results.push(result);
      settled(result);
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
