/**
 * `dosu skill` — manage the Dosu agent skill.
 */

import { execSync } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Manage the Dosu agent skill");

  cmd
    .command("install")
    .description("Install the Dosu skill for AI coding agents")
    .action(() => {
      console.log(`Installing ${SKILL_NAME} skill from ${SKILL_REPO}...`);
      try {
        execSync(`npx skills add ${SKILL_REPO} -g -s ${SKILL_NAME} -y`, {
          stdio: "inherit",
        });
        console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" installed successfully.`));
      } catch {
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
    .action(() => {
      console.log(`Updating ${SKILL_NAME} skill...`);
      try {
        execSync(`npx skills update ${SKILL_NAME} -g`, {
          stdio: "inherit",
        });
        console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" updated.`));
      } catch {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
    });

  return cmd;
}
