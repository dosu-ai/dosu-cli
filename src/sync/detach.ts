/** Detached re-spawn for hook-triggered syncs so the user's agent never waits on the pipeline. */

import { type ChildProcess, spawn } from "node:child_process";
import { logger } from "../debug/logger";

export interface SelfInvocation {
  command: string;
  baseArgs: string[];
}

/** How to re-invoke this CLI: a compiled binary must not pass argv[1] (a virtual /$bunfs path);
 * a script runtime passes execPath plus the real entry script. */
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
