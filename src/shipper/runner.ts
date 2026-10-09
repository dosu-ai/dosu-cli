/** Transcript shipper — the sync pipeline's `ship` step. Per session: honor the incognito
 * opt-out, normalize the raw log to redacted trajectory-v1 records, judge whether they are worth
 * learning from, and POST them to the Dosu memory ingest API. Fire-and-forget: the accepted task is never polled; the task id and the
 * shareable session_url are returned for the sync ledger and the report to surface. */

import type { NormalizedRecord } from "@letta-ai/trajectory";
import { getBackendURL } from "../config/constants";
import type { ProjectKey } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "../sync/incognito";
import type { ShipHold, ShipSessionResult, SyncDeps } from "../sync/sync";
import { planShipment, prefixSha256, type ShippedPrefix } from "./continuation";
import { normalizeSessionRecords, trajectorySourceOf } from "./normalize";
import { forkCopy, sessionStartOf } from "./session-start";
import { isTrivialTrajectory } from "./worthiness";

/** Statuses where re-sending identical records cannot succeed (bad/oversized/unparseable
 * payload): the session is settled as rejected instead of failing every run behind a poison
 * pill. Everything else non-202 — auth, rate limit, 5xx, a not-yet-deployed endpoint — is a
 * failure that backs off and retries. */
const REJECTED_STATUSES = new Set([400, 413, 422]);

/** Per-request cap; ship runs are already detached from the hook, so patience is cheap. */
const REQUEST_TIMEOUT_MS = 60_000;

interface IngestAccepted {
  task_id?: string;
  session_url?: string | null;
}

export interface ShipStepOptions {
  apiKey: string;
  deploymentId: string;
  /** Defaults to getBackendURL(). */
  backendUrl?: string;
  /** Injectable boundaries, for tests. Narrower than `typeof fetch` on purpose: the step only
   * needs the call signature, and Bun's fetch type carries extras like `preconnect`. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  isIncognito?: (session: AgentSession) => boolean;
  normalize?: (session: AgentSession) => Promise<NormalizedRecord[] | null>;
  resolveProject?: (session: AgentSession) => ProjectKey | null;
  /** `at`: when the session's own records began (ISO), the time to ask the reflog about. */
  resolveBranch?: (session: AgentSession, at?: string) => string | null;
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all ledger bookkeeping and says, per
 * session, what earlier runs already shipped of it, and whether the user's switches still let it
 * go (ShipHold). */
export function createShipStep(options: ShipStepOptions): NonNullable<SyncDeps["ship"]> {
  const backendUrl = (options.backendUrl ?? getBackendURL()).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const normalize = options.normalize ?? normalizeSessionRecords;

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
    const body = JSON.stringify({
      records: plan.records,
      metadata: {
        deployment_id: options.deploymentId,
        project,
        // Servers that predate `project` require `repo`; same key.
        repo: project,
        agent: trajectorySourceOf(session.harness) ?? session.harness,
        session_id: session.id,
        ...(branch ? { branch } : {}),
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
        ...(plan.continuation ? { continuation: plan.continuation } : {}),
      },
    });
    // Normalizing a long session takes a while: the switch is read once more right before sending.
    const late = hold(session);
    if (late === "stop") return null;
    if (late === "agent") return { session, outcome: "incognito", byAgent: true };
    try {
      const response = await fetchImpl(`${backendUrl}/v1/memory/ingest/async`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dosu-API-Key": options.apiKey,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 202) {
        const accepted = (await response.json().catch(() => ({}))) as IngestAccepted;
        return {
          session,
          outcome: "shipped",
          taskId: accepted.task_id ?? "unknown",
          ...(typeof accepted.session_url === "string" ? { sessionUrl: accepted.session_url } : {}),
          project,
          // Everything up to here has now shipped, whether this upload was all of it or a tail.
          records: records.length,
          prefixSha256: prefixSha256(records, records.length),
        };
      }
      if (REJECTED_STATUSES.has(response.status)) {
        return {
          session,
          outcome: "rejected",
          httpStatus: response.status,
          message: `ingest rejected: HTTP ${response.status}`,
        };
      }
      return { session, outcome: "failed", message: `ingest failed: HTTP ${response.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { session, outcome: "failed", message };
    }
  }

  return async (sessions, shippedOf = () => undefined, hold = () => null) => {
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
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
