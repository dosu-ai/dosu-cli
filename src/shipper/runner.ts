/** Transcript shipper — the sync pipeline's `ship` step. Per session: honor the incognito
 * opt-out, normalize the raw log to redacted trajectory-v1 records, judge whether they are worth
 * learning from, and hand them to the target (Dosu's ingest API, or a bucket / folder written
 * in-process), with the session's token usage when its journal records any. The target's answer
 * becomes the session's outcome for the sync ledger. */

import {
  isTrivialTrajectory,
  type NormalizedRecord,
  planShipment,
  prefixSha256,
  type ShippedPrefix,
} from "@dosu/sessionstorage";
import { getBackendURL } from "../config/constants";
import type { ProjectKey } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "../sync/incognito";
import type { ShipHold, ShipSessionResult, SyncDeps } from "../sync/sync";
import {
  normalizeSessionRecords,
  readTranscript,
  trajectorySourceOf,
  transcriptFormat,
} from "./normalize";
import { forkCopy, sessionStartOf } from "./session-start";
import { createDosuTarget, type Target } from "./target";
import { readSessionUsage, type SessionUsage } from "./usage";

interface ShipStepDeps {
  /** Injectable boundaries, for tests. */
  isIncognito?: (session: AgentSession) => boolean;
  normalize?: (session: AgentSession) => Promise<NormalizedRecord[] | null>;
  readUsage?: (session: AgentSession) => SessionUsage | null;
  resolveProject?: (session: AgentSession) => ProjectKey | null;
  /** `at`: when the session's own records began (ISO), the time to ask the reflog about. */
  resolveBranch?: (session: AgentSession, at?: string) => string | null;
}

/** Either a ready-made target, or the Dosu target's ingredients (the login's API key and
 * deployment). */
export type ShipStepOptions = ShipStepDeps &
  (
    | { target: Target }
    | {
        apiKey: string;
        deploymentId: string;
        /** Defaults to getBackendURL(). */
        backendUrl?: string;
        fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
      }
  );

function targetOf(options: ShipStepOptions): Target {
  if ("target" in options) return options.target;
  return createDosuTarget({
    apiKey: options.apiKey,
    deploymentId: options.deploymentId,
    backendUrl: options.backendUrl ?? getBackendURL(),
    fetchImpl: options.fetchImpl,
  });
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all ledger bookkeeping and says, per
 * session, what earlier runs already shipped of it, and whether the user's switches still let it
 * go (ShipHold). */
export function createShipStep(options: ShipStepOptions): NonNullable<SyncDeps["ship"]> {
  const target = targetOf(options);
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const normalize = options.normalize ?? normalizeSessionRecords;
  const readUsage = options.readUsage ?? readSessionUsage;

  /** One session's result, or null when shipping was turned off before it was sent. */
  async function shipOne(
    session: AgentSession,
    shipped: ShippedPrefix | undefined,
    resolve: Required<Pick<ShipStepDeps, "resolveProject" | "resolveBranch">>,
    hold: ShipHold,
  ): Promise<ShipSessionResult | null> {
    const held = hold(session);
    if (held === "stop") return null;
    if (held === "agent") return { session, outcome: "incognito", byAgent: true };
    if (isIncognito(session)) return { session, outcome: "incognito" };
    if (!trajectorySourceOf(session.harness)) {
      return {
        session,
        outcome: "unsupported",
        message: `no normalizer for ${session.harness} sessions yet`,
      };
    }
    const records = await normalize(session);
    if (!records) {
      return { session, outcome: "unsupported", message: "transcript could not be normalized" };
    }
    // A resumed session sends only its new tail, and only when that tail is worth learning from.
    let plan = planShipment(records, shipped);
    // A fork's copy of its parent's history is the parent's to ship: send what it added.
    const copied = await forkCopy(session, records, normalize);
    if (!plan.continuation && session.forkOf) plan = planShipment(records, copied);
    if (isTrivialTrajectory(plan.fresh)) return { session, outcome: "trivial" };
    // The project key of the session's working directory (sessions/project.ts), the same one
    // prompt-time memory sends.
    const project = resolve.resolveProject(session)?.project ?? "unknown";
    // The branch the transcript recorded (Claude Code, Codex), which the server would read off
    // the meta record anyway; else the one the session's prompts were served under or its
    // checkout was on at its first prompt (OpenCode, pi, Cursor), the tail of a resumed session
    // included. A fork's first prompt is its own.
    const start = sessionStartOf(records, copied);
    const branch = start.recorded ?? resolve.resolveBranch(session, start.firstPromptAt);
    const parentSessionId = session.parentId ?? session.forkOf?.id;
    // Token usage rides next to the records (the normalizer drops it); omitted when the harness
    // logs none, which reads the same as a CLI that predates usage. It covers the whole journal,
    // a resumed session's tail included: request ids are stable, so the server dedupes the overlap.
    const usage = readUsage(session);
    // Normalizing a long session takes a while: the switch is read once more right before sending.
    const late = hold(session);
    if (late === "stop") return null;
    if (late === "agent") return { session, outcome: "incognito", byAgent: true };
    const sent = await target.send({
      records: plan.records,
      metadata: {
        project,
        agent: trajectorySourceOf(session.harness) ?? session.harness,
        session_id: session.id,
        ...(branch ? { branch } : {}),
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
        ...(plan.continuation ? { continuation: plan.continuation } : {}),
      },
      ...(usage ? { usage } : {}),
      transcript: () => {
        const text = readTranscript(session);
        return text === null ? null : { text, format: transcriptFormat(session.harness) };
      },
    });
    if (sent.status === "shipped") {
      return {
        session,
        outcome: "shipped",
        taskId: sent.taskId ?? "unknown",
        ...(sent.sessionUrl ? { sessionUrl: sent.sessionUrl } : {}),
        project,
        // Everything up to here has now shipped, whether this upload was all of it or a tail.
        records: records.length,
        prefixSha256: prefixSha256(records, records.length),
      };
    }
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
      if (!result) break;
      results.push(result);
      settled(result);
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
