/** Which target a run ships to. Named: `--target dosu`, a configured bucket target's name, or an
 * ad-hoc `s3://` / `r2://` / `file://` URL (with `--owner`). Unnamed: the config's
 * `default_target`, else the Dosu login when it can ship, else the first bucket target. The
 * hook command carries no `--target`, so the default is what background syncs use. */

import { type Config, MODE_OSS } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import type { BucketTarget } from "../config/schema";
import {
  configuredTargets,
  isServerTarget,
  openStore,
  resolveBucketTarget,
} from "../config/targets";
import { createDosuTarget, createServerTarget, createStoreTarget, type Target } from "./target";

/** A configured bucket, folder or server target as the shipper's `Target`. */
function bucketTarget(bucket: BucketTarget): Target {
  if (isServerTarget(bucket)) {
    if (!bucket.token) {
      throw new Error(`target ${bucket.name} (${bucket.url}) has no token; run 'dosu setup'`);
    }
    return createServerTarget({ name: bucket.name, url: bucket.url, token: bucket.token });
  }
  return createStoreTarget({ name: bucket.name, store: openStore(bucket), owner: bucket.owner });
}

export interface TargetSelection {
  /** `--target`: a name or URL. */
  target?: string;
  /** `--owner`, for an ad-hoc URL. */
  owner?: string;
}

/** The Dosu target when the install can ship to it: logged in, cloud mode, with an API key and
 * deployment, against an absolute backend URL. */
function dosuTarget(cfg: Config): Target | undefined {
  if (cfg.mode === MODE_OSS) return undefined;
  const target = cfg.active_account?.target;
  if (!target?.api_key || !target.deployment_id) return undefined;
  const backendUrl = getBackendURL();
  if (!isAbsoluteHttpUrl(backendUrl)) return undefined;
  return createDosuTarget({
    apiKey: target.api_key,
    deploymentId: target.deployment_id,
    backendUrl,
  });
}

/** Resolve the run's target; undefined when nothing can take sessions (not logged in and no
 * bucket target configured). Throws for a `--target` that does not resolve. */
export function selectTarget(cfg: Config, selection: TargetSelection = {}): Target | undefined {
  const named = selection.target ?? cfg.default_target;
  if (named === "dosu") {
    const dosu = dosuTarget(cfg);
    if (!dosu && selection.target) {
      throw new Error("the Dosu target cannot ship: run 'dosu setup' to log in and pick an MCP");
    }
    return dosu;
  }
  if (named !== undefined) {
    return bucketTarget(resolveBucketTarget(cfg, named, { owner: selection.owner }));
  }
  const dosu = dosuTarget(cfg);
  if (dosu) return dosu;
  const [first] = configuredTargets(cfg);
  if (!first) return undefined;
  return bucketTarget(first);
}
