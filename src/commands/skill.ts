/**
 * `dosu skill` — manage the Dosu agent skill.
 */

import { exec, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import { fetchLatestSha, writeSkillCache } from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
/** Names are interpolated into a shell command, so keep them boring. */
const SAFE_SKILL_NAME = /^[a-zA-Z0-9._-]+$/;
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
    return { path: join(claudeConfigDir, "skills", SKILL_NAME), symlink: true };
  }

  if (agentID === "windsurf") {
    return {
      path: join(homedir(), ".codeium", "windsurf", "skills", SKILL_NAME),
      symlink: true,
    };
  }

  return {
    path: join(homedir(), ".agents", "skills", SKILL_NAME),
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
 * Install the Dosu skill via `npx skills`. After a successful install we try
 * to fetch the latest commit SHA and cache it so the update checker knows
 * what was installed. Network failure is non-fatal — the skill is still
 * installed, the SHA is just not cached (the update checker will fill it
 * in on the next stale check).
 */
export async function installSkill(
  providerIDs?: readonly string[],
  options: { quiet?: boolean } = {},
): Promise<{ success: boolean; sha?: string }> {
  const agentArgs = skillAgentArgs(providerIDs);
  if (!agentArgs) {
    logger.debug("skill", "No selected providers support the Dosu skill");
    return { success: true };
  }

  try {
    // `-s "*"` installs every skill the repo exposes, so adding one upstream
    // does not require a CLI release. The quoting is load-bearing and must be
    // double quotes: this string is run through a shell, so on POSIX a bare `*`
    // would glob-expand against cwd, while on Windows the shell is cmd.exe,
    // which does not treat single quotes as delimiters and would forward a
    // literal `'*'` that matches no skill name.
    const command = `npx skills add ${SKILL_REPO} -g ${agentArgs} -s "*" -y`;
    if (options.quiet) await execQuiet(command);
    else execSync(command, { stdio: "inherit" });
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

/**
 * Names of the globally installed skills that came from {@link SKILL_REPO},
 * as reported by the skills CLI's own inventory.
 *
 * `skills remove` resolves exact names and has no wildcard, so removing our
 * whole set means enumerating it first. Returns an empty list if the inventory
 * cannot be read.
 */
function installedSkillNames(): string[] {
  try {
    const json = execSync("npx skills list -g --json", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const entries = JSON.parse(json) as { name?: unknown; source?: unknown }[];
    return entries
      .filter((entry) => entry.source === SKILL_REPO)
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string" && SAFE_SKILL_NAME.test(name));
  } catch (err) {
    logger.debug("skill", `Could not list installed skills: ${err}`);
    return [];
  }
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Manage the Dosu agent skill");

  cmd
    .command("install")
    .description("Install the Dosu skill for AI coding agents")
    .action(async () => {
      console.log(`Installing skills from ${SKILL_REPO}...`);
      const result = await installSkill();
      if (result.success) {
        console.log(pc.green(`\n✓ Skills installed successfully.`));
      } else {
        console.error(pc.red(`\nFailed to install skill. Make sure npx is available.`));
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .description("Remove the Dosu skills")
    .action(() => {
      // Names go in positionally: the remove parser silently drops `-s`, and
      // passing none at all opens an interactive picker. Falling back to the
      // original skill keeps the command non-interactive when the inventory
      // is unreadable.
      const installed = installedSkillNames();
      const targets = installed.length > 0 ? installed : [SKILL_NAME];
      console.log(`Removing skills from ${SKILL_REPO}...`);
      try {
        execSync(`npx skills remove -g ${targets.join(" ")} -y`, {
          stdio: "inherit",
        });
        console.log(pc.green(`\n✓ Skills removed.`));
      } catch {
        console.error(pc.red(`\nFailed to remove skills.`));
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Update the Dosu skill to the latest version")
    .action(async () => {
      console.log(`Updating skills from ${SKILL_REPO}...`);
      // Reinstall rather than `npx skills update`: update matches on the
      // skillPath recorded in the skills lockfile, so it can't follow the
      // skill across a repo-layout move (it reports "deleted upstream"
      // instead). `skills add` overwrites by name and refreshes the lock
      // entry, so it always converges on the latest layout.
      const result = await installSkill();
      if (!result.success) {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
      console.log(pc.green(`\n✓ Skills updated.`));
    });

  return cmd;
}
