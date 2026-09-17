/** `dosu skill`: manage the Dosu agent skill. */

import { exec, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import { clearInstalledSha, fetchLatestSha, writeSkillCache } from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
/** Names are interpolated into a shell command; the leading character must be alphanumeric so
 * a name like `--all` cannot be re-parsed as an option by `skills remove`. */
const SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
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

/** Install the Dosu skill via `npx skills` and cache the installed SHA for the update checker.
 * SHA fetch failure is non-fatal; the update checker fills it in on the next stale check. */
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
    // `-s "*"` installs every skill in the repo; the double quotes are load-bearing (POSIX
    // would glob-expand a bare *, and cmd.exe forwards single-quoted '*' literally).
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

/** Names of globally installed skills from {@link SKILL_REPO}. `skills remove` has no wildcard,
 * so removal enumerates first; [] means none installed, null means the inventory was unreadable. */
function installedSkillNames(): string[] | null {
  let entries: { name?: unknown; source?: unknown }[];
  try {
    const json = execSync("npx skills list -g --json", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    entries = parsed;
  } catch (err) {
    logger.debug("skill", `Could not list installed skills: ${err}`);
    return null;
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.source !== SKILL_REPO || typeof entry.name !== "string") continue;
    if (!SAFE_SKILL_NAME.test(entry.name)) {
      logger.warn("skill", `Skipping skill with an unsupported name: ${entry.name}`);
      continue;
    }
    names.push(entry.name);
  }
  return names;
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
      const installed = installedSkillNames();
      if (installed?.length === 0) {
        console.log(`No skills from ${SKILL_REPO} are installed.`);
        return;
      }
      // Names go in positionally (the remove parser silently drops `-s`); if the inventory is
      // unreadable, fall back to the one name we have always shipped.
      const targets = installed ?? [SKILL_NAME];
      console.log(`Removing skills from ${SKILL_REPO}...`);
      try {
        execSync(`npx skills remove -g ${targets.join(" ")} -y`, {
          stdio: "inherit",
        });
        clearInstalledSha();
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
      // Reinstall rather than `npx skills update`: update cannot follow the skill across a
      // repo-layout move, while `skills add` overwrites by name and always converges.
      const result = await installSkill();
      if (!result.success) {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
      console.log(pc.green(`\n✓ Skills updated.`));
    });

  return cmd;
}
