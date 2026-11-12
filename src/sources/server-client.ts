/** A sessiondb server's API, as the CLI uses it with an owner token: who the token is and which
 * bucket the server writes (`me()`, for joining a server store and `dosu sources status`), and
 * removing a session (`dosu redact`). Shipping itself is shipper/target.ts. Both are
 * `@dosu/sessiondb`'s HTTP backend with the CLI's timeout and User-Agent. */

import {
  connect,
  type Fetch,
  type Identity,
  ServerError,
  type SessionDB,
  type StorageView,
  StoreError,
} from "@dosu/sessiondb";
import { CliUsageError } from "../cli/errors";
import type { ServerTarget } from "../config/schema";
import { VERSION } from "../version/version";
import { bucketOfStorage } from "./bucket";

export type { Fetch };

/** The bucket the server writes, as `me()` describes it (never its keys). */
export type LinkedStorage = StorageView;

/** Who a token is: the name sessions are filed under (`owners/<owner>/`) and where. */
type Me = Identity;

/** The server behind a target, for the short calls (setup's check, a redaction). */
export function serverClient(target: { url: string; token: string }, fetchImpl?: Fetch): SessionDB {
  return connect({
    server: target.url,
    token: target.token,
    fetch: fetchImpl,
    timeoutMs: 30_000,
    userAgent: `dosu-cli/${VERSION}`,
  });
}

/** What a failed call comes to in a message: `<code>: <message>` from the server's error
 * envelope, `HTTP <status>` when it gave none, or why the server could not be reached. */
export function describeServerError(err: unknown): string {
  if (err instanceof ServerError) {
    return err.code === "unknown" ? err.message : `${err.code}: ${err.message}`;
  }
  if (err instanceof StoreError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The server was never reached: DNS, a refused connection, the timeout. (A `StoreError` with
 * no cause is the server saying its own bucket is down, a 502 it did answer.) */
export function isUnreachable(err: unknown): boolean {
  return err instanceof StoreError && err.cause !== undefined;
}

/** The 401 a wrong token gets. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ServerError && err.status === 401;
}

const URL_RE = /^https?:\/\/[^\s/]+(?::\d+)?(?:\/[^\s]*)?$/;

/** Hosts a token may reach over plain http: the bearer token rides on every request. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An `https://` URL, or `http://` to this machine, without a trailing slash. */
export function normalizeServerUrl(value: string): string | undefined {
  const url = value.trim().replace(/\/+$/, "");
  if (!URL_RE.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) return undefined;
  return url;
}

/** The bucket a server writes (`GET /v1/me`): how a server target's connection is found. */
export async function bucketOfTarget(
  target: ServerTarget,
  fetchImpl?: Fetch,
): Promise<{
  url: string;
  scheme: "s3" | "r2";
  bucket: string;
  prefix: string;
  region?: string;
  account_id?: string;
  endpoint?: string;
}> {
  let storage: Me["storage"];
  try {
    ({ storage } = await serverClient(target, fetchImpl).me());
  } catch (err) {
    if (isUnreachable(err)) throw new CliUsageError(describeServerError(err));
    throw new CliUsageError(`${target.url} answered ${describeServerError(err)}`);
  }
  const parsed = bucketOfStorage(storage);
  if (!parsed) {
    throw new CliUsageError(`${storage.url} is not a bucket Dosu can read (s3:// or r2://)`);
  }
  return {
    url: storage.url,
    scheme: parsed.provider === "r2" ? "r2" : "s3",
    bucket: parsed.bucket,
    prefix: parsed.prefix,
    ...(storage.region ? { region: storage.region } : {}),
    ...(storage.account_id ? { account_id: storage.account_id } : {}),
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
  };
}
