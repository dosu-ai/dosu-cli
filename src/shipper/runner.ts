/** Transcript shipper — the sync pipeline's `ship` step. Per session: honor the incognito
 * opt-out, normalize the raw log to redacted trajectory-v1 records, judge whether they are worth
 * learning from, and POST them to the Dosu memory ingest API. Fire-and-forget: the accepted task is never polled; the task id and the
 * shareable session_url are returned for the sync ledger and the report to surface. */

import type { NormalizedRecord } from "@letta-ai/trajectory";
import { getBackendURL } from "../config/constants";
import { recordedBranch } from "../sessions/branch";
import type { ProjectKey } from "../sessions/project";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "../sync/incognito";
import type { ShipSessionResult, SyncDeps } from "../sync/sync";
import { copiedPrefix, planShipment, prefixSha256, type ShippedPrefix } from "./continuation";
import { normalizeSessionRecords, trajectorySourceOf } from "./normalize";
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
  resolveBranch?: (session: AgentSession) => string | null;
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all ledger bookkeeping and says, per
 * session, what earlier runs already shipped of it. */
export function createShipStep(options: ShipStepOptions): NonNullable<SyncDeps["ship"]> {
  const backendUrl = (options.backendUrl ?? getBackendURL()).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const normalize = options.normalize ?? normalizeSessionRecords;

  async function shipOne(
    session: AgentSession,
    shipped: ShippedPrefix | undefined,
    resolve: Required<Pick<ShipStepOptions, "resolveProject" | "resolveBranch">>,
  ): Promise<ShipSessionResult> {
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
    if (!plan.continuation && session.forkOf) {
      // A fork's copy of its parent's history is the parent's to ship: send what it added.
      const { id, path } = session.forkOf;
      const parentRecords = await normalize({ harness: session.harness, id, path, updated: "" });
      plan = planShipment(records, copiedPrefix(records, parentRecords));
    }
    if (isTrivialTrajectory(plan.fresh)) return { session, outcome: "trivial" };
    // The project key of the session's working directory (sessions/project.ts), the same one
    // prompt-time memory sends.
    const project = resolve.resolveProject(session)?.project ?? "unknown";
    // The branch the transcript recorded (Claude Code, Codex), which the server would read off
    // the meta record anyway; else the one the session's prompts were served under or its
    // checkout was on then (OpenCode, pi, Cursor).
    const meta = records[0];
    const branch =
      (meta?.role === "meta" ? recordedBranch(meta.git_branch) : null) ??
      resolve.resolveBranch(session);
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

  return async (sessions, shippedOf = () => undefined) => {
    const resolver =
      options.resolveProject && options.resolveBranch ? undefined : createProjectDirResolver();
    const resolve = {
      resolveProject:
        options.resolveProject ?? ((session) => resolver?.resolveProject(session) ?? null),
      resolveBranch:
        options.resolveBranch ?? ((session) => resolver?.resolveBranch(session) ?? null),
    };
    const results: ShipSessionResult[] = [];
    for (const session of sessions) {
      const result = await shipOne(session, shippedOf(session), resolve);
      results.push(result);
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
