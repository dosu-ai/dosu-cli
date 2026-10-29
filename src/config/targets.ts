/** The sessiondb servers in `config.json`, and the one a command names: `--target team` (a
 * configured name) or nothing (`default_target`, else the only one configured). */

import type { Config, ServerTarget } from "./schema";

export function configuredTargets(cfg: Config): ServerTarget[] {
  return cfg.targets ?? [];
}

/** A target named on the command line. Throws a message fit for the terminal when it is not
 * configured. */
function resolveTarget(cfg: Config, name: string): ServerTarget {
  const configured = configuredTargets(cfg).find((target) => target.name === name);
  if (configured) return configured;
  const names = configuredTargets(cfg).map((target) => target.name);
  throw new Error(
    `unknown target '${name}'${
      names.length > 0 ? ` (configured: ${names.join(", ")})` : " (no server configured)"
    }; run 'dosu setup' or 'dosu sources setup --server <url> --token <token>'`,
  );
}

/** The target a command works against without `--target`: the config's default, else the only
 * one configured; undefined when there is none. Throws when several are configured and none is
 * the default. */
function defaultTarget(cfg: Config): ServerTarget | undefined {
  if (cfg.default_target !== undefined) return resolveTarget(cfg, cfg.default_target);
  const targets = configuredTargets(cfg);
  if (targets.length <= 1) return targets[0];
  throw new Error(
    `several servers are configured (${targets.map((t) => t.name).join(", ")}): pass --target <name> or set default_target`,
  );
}

/** `--target <name>`, else the default. */
export function selectTarget(cfg: Config, name?: string): ServerTarget | undefined {
  return name === undefined ? defaultTarget(cfg) : resolveTarget(cfg, name);
}
