/** The targets in `config.json` (sessiondb servers, and buckets this machine writes), and the
 * one a command names: `--target team` (a configured name) or nothing (`default_target`, else
 * the only one configured). */

import type { BucketTarget, Config, SessionTarget } from "./schema";

export function configuredTargets(cfg: Config): SessionTarget[] {
  return cfg.targets ?? [];
}

export function isBucketTarget(target: SessionTarget): target is BucketTarget {
  return target.kind === "bucket";
}

/** A target named on the command line. Throws a message fit for the terminal when it is not
 * configured. */
function resolveTarget(cfg: Config, name: string): SessionTarget {
  const configured = configuredTargets(cfg).find((target) => target.name === name);
  if (configured) return configured;
  const names = configuredTargets(cfg).map((target) => target.name);
  throw new Error(
    `unknown target '${name}'${
      names.length > 0 ? ` (configured: ${names.join(", ")})` : " (no target configured)"
    }; run 'dosu setup' or 'dosu sources setup'`,
  );
}

/** The target a command works against without `--target`: the config's default, else the only
 * one configured; undefined when there is none. Throws when several are configured and none is
 * the default. */
function defaultTarget(cfg: Config): SessionTarget | undefined {
  if (cfg.default_target !== undefined) return resolveTarget(cfg, cfg.default_target);
  const targets = configuredTargets(cfg);
  if (targets.length <= 1) return targets[0];
  throw new Error(
    `several targets are configured (${targets.map((t) => t.name).join(", ")}): pass --target <name> or set default_target`,
  );
}

/** `--target <name>`, else the default. */
export function selectTarget(cfg: Config, name?: string): SessionTarget | undefined {
  return name === undefined ? defaultTarget(cfg) : resolveTarget(cfg, name);
}
