/** A sessiondb server as a read-only `Store`: `get`, `stat` and `list` proxy to the server's
 * `/v1/objects` API under the owner's prefix, so the library's readers (`getSession`, `getTrace`,
 * `readChanges`, `listSessions`) work against a server target unchanged. Writes go through the
 * server's `/v1/sessions`, where normalization and redaction happen, so `put` and `delete`
 * refuse here. */

import type { ListOptions, ListResult, ObjectStat, PutOptions, Store } from "@dosu/sessionstorage";
import { StoreError } from "@dosu/sessionstorage";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteStoreOptions {
  /** `https://host`, without a trailing slash. */
  url: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The server's `{ error: { code, message } }`, or the status line. */
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

export class RemoteStore implements Store {
  readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: RemoteStoreOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call(method: "GET" | "HEAD", path: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new StoreError(
        `cannot reach ${this.url}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }

  private objectPath(key: string): string {
    return `/v1/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.call("GET", this.objectPath(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new StoreError(`get ${key}: ${await serverError(response)}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const response = await this.call("HEAD", this.objectPath(key));
    if (response.status === 404) return null;
    if (!response.ok) throw new StoreError(`stat ${key}: HTTP ${response.status}`);
    const etag = response.headers.get("etag");
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      ...(etag ? { etag } : {}),
    };
  }

  async list(prefix: string, options: ListOptions = {}): Promise<ListResult> {
    const query = new URLSearchParams({ prefix });
    if (options.startAfter) query.set("after", options.startAfter);
    if (options.limit) query.set("limit", String(options.limit));
    const response = await this.call("GET", `/v1/objects?${query}`);
    if (!response.ok) throw new StoreError(`list ${prefix}: ${await serverError(response)}`);
    return (await response.json()) as ListResult;
  }

  put(key: string, _body: Uint8Array, _options?: PutOptions): Promise<void> {
    return Promise.reject(
      new StoreError(`a sessiondb server target is written through its API, not directly (${key})`),
    );
  }

  delete(key: string): Promise<void> {
    return Promise.reject(
      new StoreError(`a sessiondb server target is written through its API, not directly (${key})`),
    );
  }
}
