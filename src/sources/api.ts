/** The backend's `/v1/memory/sources` API: a bucket target registered as a source Dosu pulls
 * sessions from. `dosu sources connect|status|sync|disconnect` and the post-sync nudge in
 * `dosu sync` are its only callers. Authenticated like ingest: the login's API key. */

import { CliUsageError } from "../cli/errors";
import { type Config, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";

type SourceKind = "s3" | "r2";

export interface ConnectSourceRequest {
  deployment_id: string;
  kind: SourceKind;
  bucket: string;
  prefix: string;
  owner: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  name?: string;
  lag_seconds?: number;
}

interface SourceChange {
  key: string;
  kind: "published" | "renormalized" | "tombstone";
  outcome: string;
  detail: string | null;
  trace_id: string | null;
  entry_at: string;
  processed_at: string;
}

export interface SourceStatus {
  id: string;
  name: string;
  org: string;
  deployment_id: string;
  kind: SourceKind;
  bucket: string;
  prefix: string;
  owner: string;
  url: string;
  region: string | null;
  account_id: string | null;
  endpoint: string | null;
  lag_seconds: number;
  enabled: boolean;
  cursor: string | null;
  cursor_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  error_count: number;
  last_sync_processed: number;
  last_sync_remaining: number;
  created_at: string;
  layout_created_by?: string | null;
  recent?: SourceChange[];
}

interface SyncQueued {
  id: string;
  status: "queued";
  workflow_id: string;
}

export interface SourcesApi {
  deploymentId: string;
  connect(body: Omit<ConnectSourceRequest, "deployment_id">): Promise<SourceStatus>;
  list(): Promise<SourceStatus[]>;
  get(id: string): Promise<SourceStatus>;
  sync(id: string): Promise<SyncQueued>;
  disconnect(id: string): Promise<void>;
}

/** Thrown for a non-2xx answer; `status` lets callers tell "gone" from "down". */
export class SourcesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SourcesApiError";
  }
}

/** The client for this install's login, or undefined when it cannot call Dosu: OSS mode, no API
 * key or deployment, or no absolute backend URL. */
export function sourcesApi(cfg: Config): SourcesApi | undefined {
  const account = cfg.active_account?.target;
  const backendUrl = getBackendURL();
  if (
    cfg.mode === MODE_OSS ||
    !account?.api_key ||
    !account.deployment_id ||
    !isAbsoluteHttpUrl(backendUrl)
  ) {
    return undefined;
  }
  const base = `${backendUrl.replace(/\/$/, "")}/v1/memory/sources`;
  const apiKey = account.api_key;
  const deploymentId = account.deployment_id;

  async function call<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "X-Dosu-API-Key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new SourcesApiError(response.status, await errorDetail(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    deploymentId,
    connect: (body) => call("POST", "", { deployment_id: deploymentId, ...body }),
    list: async () =>
      (await call<{ sources: SourceStatus[] }>("GET", `?deployment_id=${deploymentId}`)).sources,
    get: (id) => call("GET", `/${encodeURIComponent(id)}`),
    sync: (id) => call("POST", `/${encodeURIComponent(id)}/sync`),
    disconnect: (id) => call("DELETE", `/${encodeURIComponent(id)}`),
  };
}

/** The client, or the usage error that says why there is none. */
export function requireSourcesApi(cfg: Config): SourcesApi {
  const api = sourcesApi(cfg);
  if (!api) {
    throw new CliUsageError(
      "not logged in to Dosu: run 'dosu setup' (a source is a bucket Dosu reads for you, so it needs your login)",
    );
  }
  return api;
}

/** FastAPI's `{"detail": ...}` when it is a string, else the status line. */
async function errorDetail(response: Response): Promise<string> {
  let detail: string | undefined;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    else if (Array.isArray(body.detail)) {
      detail = body.detail
        .map((d) => (typeof d === "object" && d && "msg" in d ? String(d.msg) : String(d)))
        .join("; ");
    }
  } catch {
    // Not JSON; the status is all there is.
  }
  return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}
