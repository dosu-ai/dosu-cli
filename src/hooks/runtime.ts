/**
 * Resolve how installed hook commands invoke the Dosu CLI.
 *
 * Hook commands are persisted into agent configs and executed on the agent's
 * hot path every turn, so they must exec directly — never `npx` (per-turn
 * registry resolution is slow and network-dependent). Two shapes:
 *
 *  - `dosu` on PATH (global npm / brew / curl install): use it bare. Fastest,
 *    and auto-follows upgrades with no pinned path to drift.
 *  - No `dosu` on PATH (the `npx @dosu/cli` onboarding case): the running
 *    npm bundle is a single self-contained JS file, so materialize a copy
 *    into the config dir and point the hooks at `node "<copy>"`. Node is
 *    guaranteed present — the user just ran the CLI through it.
 *
 * Re-running `dosu hooks install` refreshes the materialized copy, so it
 * follows whatever version the user last installed hooks with.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";

/** True when the `dosu` binary is resolvable on PATH. */
export function dosuOnPath(): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(cmd, ["dosu"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Where the self-contained bundle is materialized for PATH-less installs. */
export function materializedRuntimePath(): string {
  return join(getConfigDir(), "bin", "dosu.js");
}

/**
 * The entry script of the current process, when it is a runnable JS bundle
 * (the npm distribution). Dev runs from TS source and the compiled binary
 * don't qualify — they return null and the caller keeps today's behavior.
 */
function currentBundlePath(): string | null {
  const entry = process.argv[1];
  if (!entry || !/\.(c|m)?js$/.test(entry) || !existsSync(entry)) return null;
  return entry;
}

/**
 * The command prefix hook installers should persist (`<prefix> hooks <event>`).
 * Falls back to bare `dosu` when there's nothing materializable — matching the
 * pre-existing behavior rather than failing the install.
 */
export function resolveHookCommandPrefix(): string {
  if (dosuOnPath()) return "dosu";
  const bundle = currentBundlePath();
  if (!bundle) {
    logger.warn("hooks", "dosu not on PATH and no bundle to materialize; using bare 'dosu'");
    return "dosu";
  }
  const target = materializedRuntimePath();
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(bundle, target);
  } catch (err) {
    logger.warn(
      "hooks",
      `failed to materialize runtime: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "dosu";
  }
  logger.info("hooks", `materialized hook runtime at ${target}`);
  // Quoted — the config dir can contain spaces (e.g. Windows user profiles).
  return `node "${target}"`;
}
