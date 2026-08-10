/**
 * `dosu skill` — manage Dosu agent skills from dosu-ai/dosu-skill.
 */

import { exec, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import { fetchLatestSha, writeSkillCache } from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
/** Skills shipped from SKILL_REPO. Install/update/remove apply to all of them. */
const SKILL_NAMES = ["dosu", "log-to-dosu-knowledge"] as const;
/** Primary skill path used for setup UI targets (symlink destination). */
const PRIMARY_SKILL_NAME = "dosu";
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

const SKILL_AGENT_BY_PROVIDER: Readonly<Record<string, string>> = {
  claude: "claude-code",
  cursor: "cursor",
  vscode: "github-copilot",
  gemini: "gemini-cli",
  codex: "codex",
  windsurf: "windsurf",
  zed: "zed",
  cline: "cline",
  "cline-cli": "cline",
  copilot: "github-copilot",
  opencode: "opencode",
  antigravity: "antigravity",
};

function skillSelectArgs(): string {
  return SKILL_NAMES.map((name) => `-s ${name}`).join(" ");
}

function skillNamesLabel(): string {
  return SKILL_NAMES.join(", ");
}

export function skillAgentIDsForProviders(providerIDs: readonly string[]): string[] {
  return [
    ...new Set(
      providerIDs
        .map((providerID) => SKILL_AGENT_BY_PROVIDER[providerID])
        .filter((agent): agent is string => Boolean(agent)),
    ),
  ];
}

export interface SkillInstallTarget {
  path: string;
  symlink: boolean;
}

export function skillInstallTargetForProvider(providerID: string): SkillInstallTarget | null {
  const agentID = SKILL_AGENT_BY_PROVIDER[providerID];
  if (!agentID) return null;

  if (agentID === "claude-code") {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return { path: join(claudeConfigDir, "skills", PRIMARY_SKILL_NAME), symlink: true };
  }

  if (agentID === "windsurf") {
    return {
      path: join(homedir(), ".codeium", "windsurf", "skills", PRIMARY_SKILL_NAME),
      symlink: true,
    };
  }

  return {
    path: join(homedir(), ".agents", "skills", PRIMARY_SKILL_NAME),
    symlink: false,
  };
}

function skillAgentArgs(providerIDs?: readonly string[]): string {
  const agents =
    providerIDs === undefined ? SUPPORTED_SKILL_AGENTS : skillAgentIDsForProviders(providerIDs);
  return agents.map((agent) => `-a ${agent}`).join(" ");
}

function execQuiet(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Install Dosu skills via `npx skills`. After a successful install we try
 * to fetch the latest commit SHA and cache it so the update checker knows
 * what was installed. Network failure is non-fatal — the skills are still
 * installed, the SHA is just not cached (the update checker will fill it
 * in on the next stale check).
 */
export async function installSkill(
  providerIDs?: readonly string[],
  options: { quiet?: boolean } = {},
): Promise<{ success: boolean; sha?: string }> {
  const agentArgs = skillAgentArgs(providerIDs);
  if (!agentArgs) {
    logger.debug("skill", "No selected providers support Dosu skills");
    return { success: true };
  }

  try {
    const command = `npx skills add ${SKILL_REPO} -g ${agentArgs} ${skillSelectArgs()} -y`;
    if (options.quiet) await execQuiet(command);
    else execSync(command, { stdio: "inherit" });
  } catch (err) {
    logger.error("skill", `Failed to install skills: ${err}`);
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
  logger.debug("skill", "Skills installed but could not fetch latest SHA");
  return { success: true };
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Manage Dosu agent skills");

  cmd
    .command("install")
    .description("Install Dosu skills for AI coding agents")
    .action(async () => {
      console.log(`Installing skills (${skillNamesLabel()}) from ${SKILL_REPO}...`);
      const result = await installSkill();
      if (result.success) {
        console.log(pc.green(`\n✓ Skills installed successfully: ${skillNamesLabel()}.`));
      } else {
        console.error(pc.red(`\nFailed to install skills. Make sure npx is available.`));
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .description("Remove Dosu skills")
    .action(() => {
      console.log(`Removing skills (${skillNamesLabel()})...`);
      try {
        execSync(`npx skills remove -g ${skillSelectArgs()} -y`, {
          stdio: "inherit",
        });
        console.log(pc.green(`\n✓ Skills removed: ${skillNamesLabel()}.`));
      } catch {
        console.error(pc.red(`\nFailed to remove skills.`));
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Update Dosu skills to the latest version")
    .action(async () => {
      console.log(`Updating skills (${skillNamesLabel()})...`);
      // Reinstall rather than `npx skills update`: update matches on the
      // skillPath recorded in the skills lockfile, so it can't follow the
      // skill across a repo-layout move (it reports "deleted upstream"
      // instead). `skills add` overwrites by name and refreshes the lock
      // entry, so it always converges on the latest layout.
      const result = await installSkill();
      if (!result.success) {
        console.error(pc.red(`\nFailed to update skills.`));
        process.exit(1);
      }
      console.log(pc.green(`\n✓ Skills updated: ${skillNamesLabel()}.`));
    });

  return cmd;
}
