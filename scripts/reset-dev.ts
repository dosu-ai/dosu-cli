/** Wipes dev-mode state (`~/.config/dosu-cli-dev/`) so local testing starts from scratch. The
 * real install's `~/.config/dosu-cli/` is deliberately never touched. */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same resolution as src/config getConfigDir(), pinned to the dev dir. */
export function devConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "dosu-cli-dev");
}

/** Remove the dev config dir; returns true when there was one to remove. */
export function resetDevState(dir: string): boolean {
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

if (import.meta.main) {
  const dir = devConfigDir();
  if (resetDevState(dir)) {
    console.log(`Removed ${dir}`);
    console.log("Dev state cleared. Run 'bun run dev' and go through Setup to start fresh.");
  } else {
    console.log(`Nothing to clear — ${dir} does not exist.`);
  }
}
