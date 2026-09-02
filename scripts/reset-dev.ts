/**
 * Wipes the CLI's dev-mode state so local testing can start from scratch:
 *
 *   bun run reset:dev
 *
 * Deletes `~/.config/dosu-cli-dev/` — the config dir every `DOSU_DEV=true`
 * invocation uses (`bun run dev` sets it via .env.development). That removes
 * the dev credentials, the knowledge-sync watermark (so every local session
 * counts as unmined again), the sync lock, the debug log, and update caches.
 * The next `bun run dev` → Setup rebuilds everything, and the next sync
 * re-mines the full session history.
 *
 * The real install's state (`~/.config/dosu-cli/`) is deliberately never
 * touched — that dir belongs to the released `dosu` and its signed-in
 * account. Backend data (topics, notes) lives server-side and is not
 * affected; clear that in the web app or database.
 */

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
