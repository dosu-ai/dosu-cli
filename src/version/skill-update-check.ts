/** Post-upgrade skill refresh. The agent skills are embedded in the binary, so a CLI upgrade is
 * the only way their content changes; the first command on a new version rewrites the skills that
 * an earlier version installed, for the same agents, so what agents read never lags the CLI they
 * drive. Skipped when skills were never installed through this CLI. Fail-open: errors are logged
 * and the next invocation retries. Mirrors `mcp-refresh-check.ts`. */

import pc from "picocolors";
import { installBundledSkills, readSkillInstallState } from "../commands/skill";
import { logger } from "../debug/logger";
import { VERSION } from "./version";

function displayNotice(): void {
  console.error(
    `\n${pc.green(`✓ Dosu ${VERSION}: refreshed the bundled agent skills`)}\n` +
      `${pc.dim("  Restart your AI agents to pick up the new skill content.")}\n`,
  );
}

/** Re-apply the bundled skills once after an upgrade. Called synchronously from the preAction
 * hook. With `notify: false` the refresh still runs but prints nothing (the TUI owns the screen). */
export function checkForSkillUpdates(options: { notify?: boolean } = {}): void {
  const notify = options.notify ?? true;
  try {
    const state = readSkillInstallState();
    if (!state || state.version === VERSION) return;

    const result = installBundledSkills(state.agents);
    if (!result.success) {
      logger.error("skill-update-check", `Skill refresh to ${VERSION} failed; will retry`);
      return;
    }
    logger.info("skill-update-check", `Refreshed skills from ${state.version} to ${VERSION}`);
    if (notify && result.version) displayNotice();
  } catch (err) {
    logger.error("skill-update-check", `Skill update check failed: ${err}`);
  }
}
