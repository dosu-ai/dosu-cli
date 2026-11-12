/** A bucket as Dosu is told about it. A bucket is always the org's: an org admin sets it as the
 * org's session store with Dosu's READ-ONLY key (`dosu sources store setup`, or step 1 of
 * `dosu setup`), after Dosu has looked at what is there (`POST /detect`); members write their own
 * folder of it with a write key of their own. Whatever lands under the prefix reaches the org's
 * memory, so a key that can write the bucket is a key that can add to it; server-side redaction
 * still applies to all of it. */

import { CliUsageError } from "../cli/errors";
import { type DetectRequest, isSourceAgent, SOURCE_AGENTS, type SourceAgent } from "./api";
import type { KeyPair } from "./prompts";
import type { LinkedStorage } from "./server-client";

export type BucketProvider = "s3" | "r2" | "compatible";

/** Where a bucket is. */
export interface BucketLocation {
  url: string;
  provider: BucketProvider;
  bucket: string;
  prefix: string;
  region?: string;
  accountId?: string;
  endpoint?: string;
}

/** `r2://bucket/prefix` → its parts; a plain `s3://` with an endpoint is S3-compatible.
 * `file://` is not a bucket (Dosu cannot read a folder on a server). */
export function bucketOfStorage(
  storage: LinkedStorage,
): { provider: BucketProvider; bucket: string; prefix: string } | undefined {
  const m = /^(s3|r2):\/\/([^/]+)(?:\/(.*))?$/.exec(storage.url);
  if (!m) return undefined;
  const provider: BucketProvider = m[1] === "r2" ? "r2" : storage.endpoint ? "compatible" : "s3";
  return { provider, bucket: m[2] as string, prefix: (m[3] ?? "").replace(/^\/+|\/+$/g, "") };
}

/** What the admin reads before giving Dosu a key: read-only is enough, and why a write key to
 * the same bucket matters. */
export const READ_KEY_NOTE =
  "Dosu needs its own read-only key to the org's bucket (GetObject + ListBucket).";

/** `POST /detect`'s body for `location`. */
export function detectBody(location: BucketLocation, read: KeyPair): DetectRequest {
  const { provider, bucket, prefix, region, accountId, endpoint } = location;
  return {
    kind: provider === "r2" ? "r2" : "s3",
    bucket,
    prefix,
    ...(region ? { region } : {}),
    ...(accountId ? { account_id: accountId } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...read,
  };
}

/** An `--agent` value, checked. */
export function parseAgent(value: string | undefined): SourceAgent | undefined {
  if (value === undefined) return undefined;
  if (!isSourceAgent(value)) {
    throw new CliUsageError(`--agent must be one of ${SOURCE_AGENTS.join(", ")}, got '${value}'`);
  }
  return value;
}
