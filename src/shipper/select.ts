/** Which target a run ships to: `--target <name>`, else the config's `default_target`, else
 * the only one configured. The hook command carries no `--target`, so the default is what
 * background syncs use. */

import type { SessionDB } from "@dosu/sessiondb";
import type { Config } from "../config/config";
import type { BucketTarget, SessionTarget } from "../config/schema";
import { isBucketTarget, selectTarget as selectConfigured } from "../config/targets";
import {
  type BucketTargetOptions,
  bucketClient,
  createBucketTarget,
  createServerTarget,
  type Target,
} from "./target";

export interface TargetSelection {
  /** `--target`: a configured name. */
  target?: string;
}

function bucketOptionsOf(target: BucketTarget): BucketTargetOptions {
  return {
    name: target.name,
    url: target.url,
    owner: target.owner,
    region: target.region,
    accountId: target.account_id,
    endpoint: target.endpoint,
    credentials: {
      accessKeyId: target.access_key_id,
      secretAccessKey: target.secret_access_key,
      ...(target.session_token ? { sessionToken: target.session_token } : {}),
    },
  };
}

/** The SDK's client over a configured bucket target (for `redact`). */
export function bucketClientOf(target: BucketTarget): SessionDB {
  return bucketClient(bucketOptionsOf(target));
}

/** The ship step's target for a configured one: a server, or a bucket written from here. */
export function shipTargetOf(target: SessionTarget): Target {
  if (isBucketTarget(target)) return createBucketTarget(bucketOptionsOf(target));
  return createServerTarget({ name: target.name, url: target.url, token: target.token });
}

/** Resolve the run's target; undefined when none is configured. Throws for a `--target` that
 * does not resolve. */
export function selectTarget(cfg: Config, selection: TargetSelection = {}): Target | undefined {
  const configured = selectConfigured(cfg, selection.target);
  return configured ? shipTargetOf(configured) : undefined;
}
