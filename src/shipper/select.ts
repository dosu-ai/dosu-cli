/** Which server a run ships to: `--target <name>`, else the config's `default_target`, else
 * the only one configured. The hook command carries no `--target`, so the default is what
 * background syncs use. */

import type { Config } from "../config/config";
import { selectTarget as selectConfigured } from "../config/targets";
import { createServerTarget, type Target } from "./target";

export interface TargetSelection {
  /** `--target`: a configured name. */
  target?: string;
}

/** Resolve the run's target; undefined when no server is configured. Throws for a `--target`
 * that does not resolve. */
export function selectTarget(cfg: Config, selection: TargetSelection = {}): Target | undefined {
  const server = selectConfigured(cfg, selection.target);
  if (!server) return undefined;
  return createServerTarget({ name: server.name, url: server.url, token: server.token });
}
