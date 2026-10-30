/** A sessiondb server's API, as the CLI uses it with an owner token: who the token is and which
 * bucket the server writes (`me()`, for setup), and removing a session (`dosu redact`). Shipping
 * itself is shipper/target.ts. Both are `@dosu-ai/sessiondb`'s HTTP backend with the CLI's
 * timeout and User-Agent. */

import {
  connect,
  type Fetch,
  type Identity,
  ServerError,
  type SessionDB,
  type StorageView,
  StoreError,
} from "@dosu-ai/sessiondb";
import { VERSION } from "../version/version";

export type { Fetch };

/** The bucket the server writes, as `me()` describes it (never its keys). */
export type LinkedStorage = StorageView;

/** Who a token is: the name sessions are filed under (`owners/<owner>/`) and where. */
export type Me = Identity;

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
