/** One-time incognito-command backfill. `dosu setup` and `dosu knowledge hooks enable` install
 * each agent's incognito command (`/dosu-incognito`; `$dosu-incognito` in Codex) next to its
 * hooks, but users who enabled the hooks before the command existed only upgrade, and `dosu
 * upgrade` does not re-run setup on older binaries. Without the command their sessions ship with
 * no way to keep one out. The first command on a version that has this check installs the
 * command for every agent whose hooks are enabled, then records a marker; from then on setup,
 * `hooks enable` and `dosu knowledge incognito on|off` keep it present. Fail-open: errors are
 * logged and the marker is left unwritten so the next invocation retries. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { allHookAgents } from "../hooks/agents";
import { getIncognitoAgent } from "../incognito/agents";

const MARKER_FILENAME = "incognito-backfill.json";

function markerPath(): string {
  return join(getConfigDir(), MARKER_FILENAME);
}

function writeMarker(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(markerPath(), JSON.stringify({ done: true }), { mode: 0o600 });
}

function displayNotice(added: string[]): void {
  console.error(
    `\n${pc.green(`✓ Dosu: added the incognito command to ${added.join(", ")}`)}\n` +
      `${pc.dim("  Run it in a session to keep that session out of Dosu memory.")}\n`,
  );
}

/** Called synchronously from the preAction hook. With `notify: false` the install still runs
 * but prints nothing (the TUI owns the screen). */
export function checkForIncognitoBackfill(options: { notify?: boolean } = {}): void {
  const notify = options.notify ?? true;
  try {
    if (existsSync(markerPath())) return;

    const added: string[] = [];
    let failed = false;
    for (const hook of allHookAgents()) {
      const agent = getIncognitoAgent(hook.id());
      if (!agent || !hook.isEnabled() || agent.isEnabled()) continue;
      try {
        agent.enable();
        added.push(`${agent.name()} (${agent.invocation()})`);
      } catch (err) {
        failed = true;
        logger.warn("incognito-backfill", `Install failed for ${agent.id()}: ${err}`);
      }
    }

    if (!failed) writeMarker();
    if (added.length > 0) {
      logger.info("incognito-backfill", `Installed the incognito command for ${added.join(", ")}`);
      if (notify) displayNotice(added);
    }
  } catch (err) {
    logger.error("incognito-backfill", `Incognito backfill failed: ${err}`);
  }
}
