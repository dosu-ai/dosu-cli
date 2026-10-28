/** Where a session's records go once the ship step has them: the Dosu memory ingest API
 * (`POST /v1/memory/ingest/async` with the login's API key) or a `@dosu/sessionstorage` store
 * (an S3 / R2 bucket or a local folder) written in-process. Both take the same redacted
 * trajectory-v1 records and the same metadata, and answer with the same three outcomes. */

import {
  type IngestMetadata,
  IngestRejected,
  ingest,
  type NormalizedRecord,
  type Store,
} from "@dosu/sessionstorage";
import { VERSION } from "../version/version";
import type { SessionUsage } from "./usage";

/** What one session's upload came to. `rejected` is settled (the same records can never
 * succeed); `failed` stops the batch, backs off, and is retried later. */
type TargetResult =
  | { status: "shipped"; taskId?: string; sessionUrl?: string }
  | { status: "rejected"; httpStatus?: number; message: string }
  | { status: "failed"; message: string };

interface TargetSend {
  records: NormalizedRecord[];
  metadata: IngestMetadata;
  /** The session's token usage, when its journal records any; the Dosu target ships it next to
   * the records, a store keeps only what the layout defines. */
  usage?: SessionUsage;
}

export interface Target {
  /** `dosu`, or the bucket target's configured name. */
  name: string;
  kind: "dosu" | "store";
  /** For messages: the backend URL or the store URL. */
  url: string;
  send(input: TargetSend): Promise<TargetResult>;
}

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

export interface DosuTargetOptions {
  apiKey: string;
  deploymentId: string;
  /** Without a trailing slash. */
  backendUrl: string;
  /** Injectable boundary, for tests. Narrower than `typeof fetch` on purpose: the target only
   * needs the call signature, and Bun's fetch type carries extras like `preconnect`. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** The Dosu target: fire-and-forget against the async ingest endpoint; the accepted task is
 * never polled, and the task id and shareable session_url come back for the ledger. */
export function createDosuTarget(options: DosuTargetOptions): Target {
  const backendUrl = options.backendUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "dosu",
    kind: "dosu",
    url: backendUrl,
    async send({ records, metadata, usage }) {
      const body = JSON.stringify({
        records,
        metadata: {
          deployment_id: options.deploymentId,
          project: metadata.project,
          // Servers that predate `project` require `repo`; same key.
          repo: metadata.project,
          agent: metadata.agent,
          session_id: metadata.session_id,
          ...(metadata.branch ? { branch: metadata.branch } : {}),
          ...(metadata.parent_session_id ? { parent_session_id: metadata.parent_session_id } : {}),
          ...(metadata.continuation ? { continuation: metadata.continuation } : {}),
        },
        ...(usage ? { usage } : {}),
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
            status: "shipped",
            taskId: accepted.task_id ?? "unknown",
            ...(typeof accepted.session_url === "string"
              ? { sessionUrl: accepted.session_url }
              : {}),
          };
        }
        if (REJECTED_STATUSES.has(response.status)) {
          return {
            status: "rejected",
            httpStatus: response.status,
            message: `ingest rejected: HTTP ${response.status}`,
          };
        }
        return { status: "failed", message: `ingest failed: HTTP ${response.status}` };
      } catch (err) {
        return { status: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface StoreTargetOptions {
  name: string;
  store: Store & { url: string };
  owner: string;
}

/** A bucket or folder target: the library's `ingest()` in-process. A duplicate (the same
 * records already stored) counts as shipped; the library's refusals settle as rejected, and
 * anything else (network, credentials, a bucket that is gone) is a failure to retry. */
export function createStoreTarget(options: StoreTargetOptions): Target {
  return {
    name: options.name,
    kind: "store",
    url: options.store.url,
    async send({ records, metadata }) {
      try {
        const result = await ingest({
          store: options.store,
          owner: options.owner,
          records,
          metadata,
          client: `dosu-cli/${VERSION}`,
        });
        return { status: "shipped", taskId: `${result.status}:${result.content_hash}` };
      } catch (err) {
        if (err instanceof IngestRejected) {
          return { status: "rejected", message: `${err.code}: ${err.message}` };
        }
        return { status: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
