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

/** `POST /hosted`: the login set up on Dosu's own sessiondb. The server to ship to, a token it
 * accepts as `owner` until `expires_at`, and the source Dosu reads the result through. */
export interface HostedSource {
  server_url: string;
  token: string;
  owner: string;
  expires_at: string;
  source: SourceStatus;
}

export interface SourcesApi {
  deploymentId: string;
  /** The Dosu this client talks to, for messages that say which one failed. */
  backendUrl: string;
  connect(body: Omit<ConnectSourceRequest, "deployment_id">): Promise<SourceStatus>;
  /** Set this login up on Dosu's sessiondb; idempotent, and a fresh token each time. 404 on a
   * Dosu that hosts none. */
  hosted(): Promise<HostedSource>;
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

/** Per-request cap. `dosu sync` renews a hosted token and nudges a source from a detached run that
 * holds the sync lock, so a backend that never answers must not hold it with them. */
const REQUEST_TIMEOUT_MS = 30_000;

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Call = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

interface Caller {
  deploymentId: string;
  backendUrl: string;
  call: Call;
}

/** A caller for one `/v1/memory/<resource>` collection with this install's login, or undefined
 * when it cannot call Dosu: OSS mode, no API key or deployment, or no absolute backend URL. */
function backendCaller(cfg: Config, resource: "sources" | "imports" | "store"): Caller | undefined {
  const account = cfg.active_account?.target;
  const backendUrl = getBackendURL().replace(/\/$/, "");
  if (
    cfg.mode === MODE_OSS ||
    !account?.api_key ||
    !account.deployment_id ||
    !isAbsoluteHttpUrl(backendUrl)
  ) {
    return undefined;
  }
  const base = `${backendUrl}/v1/memory/${resource}`;
  const apiKey = account.api_key;

  const call: Call = async <T>(method: Method, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        "X-Dosu-API-Key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new SourcesApiError(response.status, await errorDetail(response));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
  return { deploymentId: account.deployment_id, backendUrl, call };
}

/** The client for this install's login, or undefined when it cannot call Dosu: OSS mode, no API
 * key or deployment, or no absolute backend URL. */
export function sourcesApi(cfg: Config): SourcesApi | undefined {
  const caller = backendCaller(cfg, "sources");
  if (!caller) return undefined;
  const { deploymentId, backendUrl, call } = caller;
  return {
    deploymentId,
    backendUrl,
    connect: (body) => call("POST", "", { deployment_id: deploymentId, ...body }),
    hosted: () => call("POST", "/hosted", { deployment_id: deploymentId }),
    list: async () =>
      (
        await call<{ sources: SourceStatus[] }>(
          "GET",
          `?deployment_id=${encodeURIComponent(deploymentId)}`,
        )
      ).sources,
    get: (id) => call("GET", `/${encodeURIComponent(id)}`),
    sync: (id) => call("POST", `/${encodeURIComponent(id)}/sync`),
    disconnect: (id) => call("DELETE", `/${encodeURIComponent(id)}`),
  };
}

// --- the org's session store ---------------------------------------------------
// `/v1/memory/store`: where the org keeps its members' sessions, set once by an org admin with
// Dosu's read key to it. A member enrolls for their own folder and never holds that key.

/** `hosted`: Dosu's sessiondb. `server`: the org's own sessiondb server. `bucket`: members write
 * the bucket directly, redacting on their machine. */
export type StoreKind = "hosted" | "server" | "bucket";

interface StoreMember {
  user_id: string;
  owner: string;
  source_id: string;
  enabled: boolean;
  last_synced_at: string | null;
  last_error: string | null;
}

/** The org's store as a member sees it: where, and what enrolling will ask for. Never a key. */
export interface SessionStore {
  kind: StoreKind;
  /** False: the org set none and gets Dosu's hosted sessiondb. */
  configured: boolean;
  server_url: string | null;
  /** The bucket sessions land in, `s3://bucket/prefix`. */
  url: string | null;
  bucket_kind: SourceKind | null;
  bucket: string | null;
  prefix: string;
  region: string | null;
  account_id: string | null;
  endpoint: string | null;
  /** Dosu mints each member's token, so enrolling asks for nothing. */
  issues_tokens: boolean;
  updated_at: string | null;
  /** The caller's own enrollment. */
  owner: string | null;
  source_id: string | null;
  /** Who has enrolled; only for org admins. */
  members: StoreMember[] | null;
}

export interface SetStoreRequest {
  kind: StoreKind;
  server_url?: string;
  bucket_kind?: SourceKind;
  bucket?: string;
  prefix?: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
  /** Dosu's read-only key to the bucket. */
  access_key_id?: string;
  secret_access_key?: string;
  session_token?: string;
  /** The server's `SESSIONDB_TOKEN_SECRET`, so Dosu mints member tokens. Omitted, a server
   * store keeps the one it has for the same server URL. */
  token_secret?: string;
  /** Forget the token secret: members' tokens are the admin's to issue again. */
  clear_token_secret?: boolean;
}

/** What enrolling gives this member: where to ship or write, a token when Dosu minted one, and
 * the source Dosu reads their folder through. */
export interface Enrollment {
  kind: StoreKind;
  owner: string;
  server_url: string | null;
  token: string | null;
  expires_at: string | null;
  url: string | null;
  bucket_kind: SourceKind | null;
  bucket: string | null;
  prefix: string;
  region: string | null;
  account_id: string | null;
  endpoint: string | null;
  source: SourceStatus;
}

export interface StoreApi {
  deploymentId: string;
  backendUrl: string;
  /** 404 when the org has none and this Dosu hosts none, or on a Dosu without stores. */
  get(): Promise<SessionStore>;
  /** Org admins only (403 otherwise). */
  set(body: SetStoreRequest): Promise<SessionStore>;
  /** Idempotent; another `owner` moves this member to that folder. */
  enroll(owner?: string): Promise<Enrollment>;
}

/** The store client for this install's login, under the same conditions as `sourcesApi`. */
export function storeApi(cfg: Config): StoreApi | undefined {
  const caller = backendCaller(cfg, "store");
  if (!caller) return undefined;
  const { deploymentId, backendUrl, call } = caller;
  return {
    deploymentId,
    backendUrl,
    get: () => call("GET", `?deployment_id=${encodeURIComponent(deploymentId)}`),
    set: (body) => call("PUT", "", { deployment_id: deploymentId, ...body }),
    enroll: (owner) =>
      call("POST", "/enroll", { deployment_id: deploymentId, ...(owner ? { owner } : {}) }),
  };
}

export function requireStoreApi(cfg: Config): StoreApi {
  const api = storeApi(cfg);
  if (!api) {
    throw new CliUsageError(
      "not logged in to Dosu: run 'dosu setup' (the org's session store is kept by Dosu)",
    );
  }
  return api;
}

// --- imports -----------------------------------------------------------------
// `/v1/memory/imports`: a bucket of raw session files (an agent's own logs, a Datadog
// Trajectory capture) that Dosu imports into its own sessiondb store and reads from there.
// Org-level: the sessions are the org's, under whoever connected the import.

/** The file formats the sessiondb SDK reads; the backend refuses any other. */
export const IMPORT_AGENTS = [
  "claude-code",
  "cursor",
  "codex",
  "opencode",
  "pi",
  "gemini-cli",
  "datadog-trajectory",
] as const;
export type ImportAgent = (typeof IMPORT_AGENTS)[number];

export interface ConnectImportRequest {
  deployment_id: string;
  agent: ImportAgent;
  kind: SourceKind;
  bucket: string;
  prefix: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
  name?: string;
  shards?: number;
  lookback_days?: number;
}

interface ImportedFile {
  key: string;
  session_id: string;
  size: number;
  shipped_bytes: number;
  outcome: "stored" | "duplicate" | "trivial" | "rejected" | "failed";
  detail: string | null;
  content_hash: string | null;
  imported_at: string;
}

export interface ImportStatus {
  id: string;
  name: string;
  org: string;
  deployment_id: string;
  source_id: string;
  agent: ImportAgent;
  kind: SourceKind;
  bucket: string;
  prefix: string;
  url: string;
  region: string | null;
  account_id: string | null;
  endpoint: string | null;
  shards: number;
  dated_prefix: string | null;
  lookback_days: number;
  enabled: boolean;
  last_imported_at: string | null;
  last_error: string | null;
  error_count: number;
  last_run_listed: number;
  last_run_imported: number;
  last_run_remaining: number;
  created_at: string;
  files: number;
  sessions: number;
  files_found?: number | null;
  recent?: ImportedFile[];
}

interface ImportQueued {
  id: string;
  status: "queued";
  workflow_ids: string[];
}

export interface ImportsApi {
  deploymentId: string;
  backendUrl: string;
  connect(body: Omit<ConnectImportRequest, "deployment_id">): Promise<ImportStatus>;
  list(): Promise<ImportStatus[]>;
  get(id: string): Promise<ImportStatus>;
  sync(id: string): Promise<ImportQueued>;
  disconnect(id: string): Promise<void>;
}

/** The imports client for this install's login, under the same conditions as `sourcesApi`. */
function importsApi(cfg: Config): ImportsApi | undefined {
  const caller = backendCaller(cfg, "imports");
  if (!caller) return undefined;
  const { deploymentId, backendUrl, call } = caller;
  return {
    deploymentId,
    backendUrl,
    connect: (body) => call("POST", "", { deployment_id: deploymentId, ...body }),
    list: async () =>
      (
        await call<{ imports: ImportStatus[] }>(
          "GET",
          `?deployment_id=${encodeURIComponent(deploymentId)}`,
        )
      ).imports,
    get: (id) => call("GET", `/${encodeURIComponent(id)}`),
    sync: (id) => call("POST", `/${encodeURIComponent(id)}/sync`),
    disconnect: (id) => call("DELETE", `/${encodeURIComponent(id)}`),
  };
}

export function requireImportsApi(cfg: Config): ImportsApi {
  const api = importsApi(cfg);
  if (!api) {
    throw new CliUsageError(
      "not logged in to Dosu: run 'dosu setup' (an import is a bucket Dosu reads for you, so it needs your login)",
    );
  }
  return api;
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
