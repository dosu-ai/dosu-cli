/** Makes this test process look like a given Dosu install to the code that writes MCP entries,
 * which runs whichever install is doing the writing. Process state is the boundary here: a
 * compiled binary is `process.execPath` itself, and the npm package is its bin script, run by
 * node, in `process.argv[1]`. */

import { join } from "node:path";

const original = { execPath: process.execPath, argv1: process.argv[1] };

/** The runtime running the tests, before any stub: a real node (or bun) to run scripts with. */
export const testRuntime = original.execPath;

export interface RunningInstall {
  /** The runtime: the compiled Dosu binary, or node for the npm package. */
  execPath: string;
  /** The npm package's bin script as invoked; absent for a compiled binary. */
  script?: string;
}

export function stubRunningInstall({ execPath, script }: RunningInstall): void {
  Object.defineProperty(process, "execPath", {
    value: execPath,
    configurable: true,
    writable: true,
  });
  // A compiled binary's argv[1] is its virtual bundle path.
  process.argv[1] = script ?? "/$bunfs/root/dosu";
}

/** A one-off `npx @dosu/cli ...`: the package's script in npx's cache under `home`. */
export function stubRunningFromNpx(home: string): void {
  stubRunningInstall({
    execPath: original.execPath,
    script: join(home, ".npm", "_npx", "0123abcd", "node_modules", ".bin", "dosu"),
  });
}

export function restoreRunningInstall(): void {
  Object.defineProperty(process, "execPath", {
    value: original.execPath,
    configurable: true,
    writable: true,
  });
  process.argv[1] = original.argv1;
}
