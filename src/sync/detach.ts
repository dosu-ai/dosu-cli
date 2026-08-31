/**
 * Detached re-spawn for hook-triggered syncs.
 *
 * Agent hooks run `dosu knowledge sync --quiet --detach`; that invocation
 * re-spawns `dosu knowledge sync --quiet` fully detached and exits
 * immediately, so the user's agent never waits on the pipeline — the scan is
 * cheap today, but the future mining step (a gateway-routed agent run) won't be.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { logger } from "../debug/logger";

export interface SelfInvocation {
  command: string;
  baseArgs: string[];
}

/**
 * How to re-invoke this CLI. Two shapes exist:
 * - Compiled binary (`bun build --compile`): argv[1] is a virtual `/$bunfs`
 *   path that must not be passed as an argument — execPath alone is the CLI.
 * - Script runtime (node bundle, `bun run dev`): execPath is the runtime and
 *   argv[1] is the real entry script.
 */
export function selfInvocation(
  execPath: string = process.execPath,
  argv1: string | undefined = process.argv[1],
): SelfInvocation {
  if (!argv1 || argv1.startsWith("/$bunfs")) {
    return { command: execPath, baseArgs: [] };
  }
  return { command: execPath, baseArgs: [argv1] };
}

export type SpawnDetached = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => Pick<ChildProcess, "unref">;

/** Spawns `dosu <args>` detached from this process. Never throws. */
export function spawnDetachedSelf(
  args: string[],
  spawnImpl: SpawnDetached = spawn,
  invocation: SelfInvocation = selfInvocation(),
): boolean {
  try {
    const child = spawnImpl(invocation.command, [...invocation.baseArgs, ...args], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch (err) {
    logger.debug("sync", `detached spawn failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
