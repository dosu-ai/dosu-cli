/**
 * `dosu skill` — manage the Dosu agent skill.
 */

import { execSync } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import {
  fetchLatestSha,
  refreshInstalledSha,
  writeSkillCache,
} from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
const SUPPORTED_SKILL_AGENTS = [
  "claude-code",
  "cursor",
  "gemini-cli",
  "codex",
  "windsurf",
  "zed",
  "cline",
  "github-copilot",
  "opencode",
  "antigravity",
];

function supportedSkillAgentArgs(): string {
  return SUPPORTED_SKILL_AGENTS.map((agent) => `-a ${agent}`).join(" ");
}

/**
 * Install the Dosu skill via `npx skills`. After a successful install we try
 * to fetch the latest commit SHA and cache it so the update checker knows
 * what was installed. Network failure is non-fatal — the skill is still
 * installed, the SHA is just not cached (the update checker will fill it
 * in on the next stale check).
 */
export async function installSkill(): Promise<{ success: boolean; sha?: string }> {
  try {
    execSync(`npx skills add ${SKILL_REPO} -g ${supportedSkillAgentArgs()} -s ${SKILL_NAME} -y`, {
      stdio: "inherit",
    });
  } catch (err) {
    logger.error("skill", `Failed to install skill: ${err}`);
    return { success: false };
  }

  const sha = await fetchLatestSha();
  if (sha) {
    writeSkillCache({
      lastCheck: Date.now(),
      latestSha: sha,
      installedSha: sha,
    });
    return { success: true, sha };
  }
  logger.debug("skill", "Skill installed but could not fetch latest SHA");
  return { success: true };
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Manage the Dosu agent skill");

  cmd
    .command("install")
    .description("Install the Dosu skill for AI coding agents")
    .action(async () => {
      console.log(`Installing ${SKILL_NAME} skill from ${SKILL_REPO}...`);
      const result = await installSkill();
      if (result.success) {
        console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" installed successfully.`));
      } else {
        console.error(pc.red(`\nFailed to install skill. Make sure npx is available.`));
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .description("Remove the Dosu skill")
    .action(() => {
      console.log(`Removing ${SKILL_NAME} skill...`);
      try {
        execSync(`npx skills remove -g -s ${SKILL_NAME} -y`, {
          stdio: "inherit",
        });
        console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" removed.`));
      } catch {
        console.error(pc.red(`\nFailed to remove skill.`));
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Update the Dosu skill to the latest version")
    .action(async () => {
      console.log(`Updating ${SKILL_NAME} skill...`);
      try {
        execSync(`npx skills update ${SKILL_NAME} -g`, {
          stdio: "inherit",
        });
      } catch {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
      await refreshInstalledSha();
      console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" updated.`));
    });

  return cmd;
}
