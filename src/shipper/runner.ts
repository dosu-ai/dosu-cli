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
import type { ShipSessionResult } from "../sync/sync";
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
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all ledger bookkeeping. */
export function createShipStep(
  options: ShipStepOptions,
): (sessions: AgentSession[]) => Promise<ShipSessionResult[]> {
  const backendUrl = (options.backendUrl ?? getBackendURL()).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const normalize = options.normalize ?? normalizeSessionRecords;

  async function shipOne(
    session: AgentSession,
    resolveProject: (session: AgentSession) => ProjectKey | null,
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
    if (isTrivialTrajectory(records)) return { session, outcome: "trivial" };
    // The project key of the session's working directory (sessions/project.ts), the same one
    // prompt-time memory sends. Branch is omitted: the trajectory meta record carries
    // git_branch when the harness logged one.
    const project = resolveProject(session)?.project ?? "unknown";
    const body = JSON.stringify({
      records,
      metadata: {
        deployment_id: options.deploymentId,
        project,
        // Servers that predate `project` require `repo`; same key.
        repo: project,
        agent: trajectorySourceOf(session.harness) ?? session.harness,
        session_id: session.id,
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

  return async (sessions) => {
    const resolver = options.resolveProject ? undefined : createProjectDirResolver();
    const resolveProject =
      options.resolveProject ?? ((session) => resolver?.resolveProject(session) ?? null);
    const results: ShipSessionResult[] = [];
    for (const session of sessions) {
      const result = await shipOne(session, resolveProject);
      results.push(result);
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
