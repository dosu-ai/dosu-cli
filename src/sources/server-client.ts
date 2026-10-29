/** A sessiondb server's API, as the CLI uses it with an owner token: who the token is and which
 * bucket the server writes (`GET /v1/me`, for setup), and removing a session (`dosu redact`).
 * Shipping itself is shipper/target.ts. The shapes mirror the server's docs/server.md; only the
 * fields the CLI reads are typed. */

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

  /** Tombstone a session; null when the server has no such session. */
  redact(agent: string, sessionId: string): Promise<{ removed: number } | null> {
    return this.call(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`,
      { notFound: null },
    );
  }
}
