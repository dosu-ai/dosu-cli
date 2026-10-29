/** A sessiondb server's API, as the CLI uses it with an owner token: who the token is, which
 * bucket the owner linked, and reading back what shipped (`dosu get`, `dosu export`,
 * `dosu changes`, `dosu redact`). Shipping itself is shipper/target.ts. The shapes mirror the
 * server's docs/server.md; only the fields the CLI reads are typed. */

import { VERSION } from "../version/version";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

/** `<code>: <message>` from the server's error envelope, else the HTTP status. */
export async function serverError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) {
      return body.error.code ? `${body.error.code}: ${body.error.message}` : body.error.message;
    }
  } catch {
    // not JSON
  }
  return `HTTP ${response.status}`;
}

/** The bucket the server writes, as `GET /v1/me` describes it (never its keys). */
export interface LinkedStorage {
  /** `s3://bucket/prefix`, `r2://bucket/prefix` or `file:///path`. */
  url: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}

export interface Me {
  /** The name sessions are filed under in the bucket (`owners/<owner>/`). */
  owner: string;
  storage: LinkedStorage;
}

/** `sessionstorage/metadata/1`, as the layout documents it. */
export interface SessionMetadata {
  owner: string;
  agent: string;
  session_id: string;
  archive_id: string;
  status: "active" | "redacted";
  project?: string;
  branch?: string;
  parent_session_id?: string;
  created_at: string;
  updated_at: string;
  head?: string;
  traces: { content_hash: string; continuation?: { from_record: number } }[];
  raw: unknown[];
}

interface TraceEvent {
  role: string;
  tool_name?: string;
  text: string;
}

export interface Trace {
  events: TraceEvent[];
  [key: string]: unknown;
}

export interface ChangeEntry {
  at: string;
  kind: "published" | "redacted";
  session_id: string;
  content_hash?: string;
  continuation?: { from_record: number };
}

export interface ChangesPage {
  entries: { key: string; entry: ChangeEntry }[];
  cursor?: string;
  truncated: boolean;
}

export class SessiondbClient {
  private readonly url: string;
  private readonly fetchImpl: Fetch;

  constructor(
    url: string,
    private readonly token: string,
    fetchImpl?: Fetch,
  ) {
    this.url = url.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, options: { notFound?: T } = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "User-Agent": `dosu-cli/${VERSION}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404 && "notFound" in options) return options.notFound as T;
    if (!response.ok) {
      const body = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { error?: { code?: string } };
      throw new ServerError(
        response.status,
        body.error?.code ?? "http_error",
        await serverError(response),
      );
    }
    return (await response.json()) as T;
  }

  me(): Promise<Me> {
    return this.call("GET", "/v1/me");
  }

  session(agent: string, sessionId: string): Promise<SessionMetadata | null> {
    return this.call(
      "GET",
      `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`,
      { notFound: null },
    );
  }

  /** The session's current trace; null when the session is unknown or has none (redacted). */
  async trace(agent: string, sessionId: string): Promise<Trace | null> {
    try {
      return await this.call(
        "GET",
        `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}/trace`,
        { notFound: null },
      );
    } catch (err) {
      if (err instanceof ServerError && err.status === 410) return null;
      throw err;
    }
  }

  changes(query: { since?: string; after?: string; limit?: number }): Promise<ChangesPage> {
    const params = new URLSearchParams();
    if (query.since) params.set("since", query.since);
    if (query.after) params.set("after", query.after);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.call("GET", `/v1/changes${qs ? `?${qs}` : ""}`);
  }

  /** Tombstone a session; null when the server has no such session. */
  redact(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    return this.call(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`,
      { notFound: null },
    );
  }
}
