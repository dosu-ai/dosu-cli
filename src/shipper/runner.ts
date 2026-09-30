/** Transcript shipper — the sync pipeline's `ship` step. Per session: honor the incognito
 * opt-out, normalize the raw log to redacted trajectory-v1 records, and POST them to the Dosu
 * memory ingest API. Fire-and-forget: the accepted task is never polled; the task id and the
 * shareable session_url are returned for the ship watermark state and the report to surface. */

import type { NormalizedRecord } from "@letta-ai/trajectory";
import { getBackendURL } from "../config/constants";
import { createProjectDirResolver } from "../sessions/project-dir";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "../sync/incognito";
import type { ShipSessionResult } from "../sync/sync";
import { normalizeSessionRecords } from "./normalize";

/** Statuses where re-sending identical records cannot succeed (bad/oversized/unparseable
 * payload): skip past the session instead of wedging the watermark behind a poison pill.
 * Everything else non-202 — auth, rate limit, 5xx, a not-yet-deployed endpoint — is a failure
 * that backs off and retries. */
const SKIP_STATUSES = new Set([400, 413, 422]);

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
  resolveProjectDir?: (session: AgentSession) => string | null;
}

/** Build the sync pipeline's ship step. Processes oldest-first and stops after the first
 * failure, per the SyncDeps contract; the pipeline owns all watermark bookkeeping. */
export function createShipStep(
  options: ShipStepOptions,
): (sessions: AgentSession[]) => Promise<ShipSessionResult[]> {
  const backendUrl = (options.backendUrl ?? getBackendURL()).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const isIncognito = options.isIncognito ?? isIncognitoSession;
  const normalize = options.normalize ?? normalizeSessionRecords;

  async function shipOne(
    session: AgentSession,
    resolveDir: (session: AgentSession) => string | null,
  ): Promise<ShipSessionResult> {
    if (isIncognito(session)) return { session, outcome: "incognito" };
    const records = await normalize(session);
    if (!records) return { session, outcome: "skipped", message: "no shippable transcript" };
    // The CLI derives no git context of its own; repo is the session's working directory (the
    // scanner's project mapping) and branch is omitted — the trajectory meta record still
    // carries git_branch server-side when the harness logged one.
    const repo = resolveDir(session) ?? session.project ?? "unknown";
    const body = JSON.stringify({
      records,
      metadata: {
        deployment_id: options.deploymentId,
        repo,
        agent: session.harness,
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
        };
      }
      if (SKIP_STATUSES.has(response.status)) {
        return { session, outcome: "skipped", message: `ingest rejected: HTTP ${response.status}` };
      }
      return { session, outcome: "failed", message: `ingest failed: HTTP ${response.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { session, outcome: "failed", message };
    }
  }

  return async (sessions) => {
    const resolver = options.resolveProjectDir ? undefined : createProjectDirResolver();
    const resolveDir =
      options.resolveProjectDir ?? ((session) => resolver?.resolve(session) ?? null);
    const results: ShipSessionResult[] = [];
    for (const session of sessions) {
      const result = await shipOne(session, resolveDir);
      results.push(result);
      if (result.outcome === "failed") break;
    }
    resolver?.flush();
    return results;
  };
}
