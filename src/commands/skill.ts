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
import { assertProjectSkillInstallSafe, type ProjectSkillTarget } from "./project-skill-ownership";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
export const SKILLS_CLI_VERSION = "1.5.22";
// The standalone `dosu skill install` command remains an explicit global
// legacy operation. Project setup passes its selected provider IDs instead,
// so new project-only mappings do not silently broaden that global footprint.
const DEFAULT_GLOBAL_SKILL_AGENTS = [
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
  factory: "droid",
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

export function skillInstallTargetForProvider(
  providerID: string,
  projectRoot?: string,
): SkillInstallTarget | null {
  const agentID = SKILL_AGENT_BY_PROVIDER[providerID];
  if (!agentID) return null;

  if (agentID === "claude-code") {
    if (projectRoot) {
      return { path: join(projectRoot, ".claude", "skills", SKILL_NAME), symlink: false };
    }
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return { path: join(claudeConfigDir, "skills", SKILL_NAME), symlink: true };
  }

  if (agentID === "windsurf") {
    if (projectRoot) {
      return { path: join(projectRoot, ".windsurf", "skills", SKILL_NAME), symlink: false };
    }
    return {
      path: join(homedir(), ".codeium", "windsurf", "skills", SKILL_NAME),
      symlink: true,
    };
  }

  if (agentID === "droid") {
    return {
      path: projectRoot
        ? join(projectRoot, ".factory", "skills", SKILL_NAME)
        : join(homedir(), ".factory", "skills", SKILL_NAME),
      symlink: !projectRoot,
    };
  }

  return {
    path: projectRoot
      ? join(projectRoot, ".agents", "skills", SKILL_NAME)
      : join(homedir(), ".agents", "skills", SKILL_NAME),
    symlink: false,
  };
}

/** Exact paths that pinned skills@1.5.22 mutates for a project install. */
export function projectSkillInstallTargetsForProviders(
  providerIDs: readonly string[],
  projectRoot: string,
): ProjectSkillTarget[] {
  const agents = skillAgentIDsForProviders(providerIDs);
  if (agents.length === 0) return [];
  if (agents.length === 1) {
    if (agents[0] === "claude-code") {
      return [{ path: join(projectRoot, ".claude", "skills", SKILL_NAME), symlink: false }];
    }
    if (agents[0] === "windsurf") {
      return [{ path: join(projectRoot, ".windsurf", "skills", SKILL_NAME), symlink: false }];
    }
    if (agents[0] === "droid") {
      return [{ path: join(projectRoot, ".factory", "skills", SKILL_NAME), symlink: false }];
    }
    return [{ path: join(projectRoot, ".agents", "skills", SKILL_NAME), symlink: false }];
  }

  const targets: ProjectSkillTarget[] = [
    { path: join(projectRoot, ".agents", "skills", SKILL_NAME), symlink: false },
  ];
  if (agents.includes("claude-code")) {
    targets.push({ path: join(projectRoot, ".claude", "skills", SKILL_NAME), symlink: true });
  }
  if (agents.includes("droid")) {
    targets.push({ path: join(projectRoot, ".factory", "skills", SKILL_NAME), symlink: true });
  }
  return targets;
}

function skillAgentArgs(providerIDs?: readonly string[]): string {
  const agents =
    providerIDs === undefined
      ? DEFAULT_GLOBAL_SKILL_AGENTS
      : skillAgentIDsForProviders(providerIDs);
  // skills@1.5.22 defines --agent as one variadic option. Repeating `-a`
  // replaces the previous value, so only the final agent would be installed.
  return agents.length > 0 ? `-a ${agents.join(" ")}` : "";
}

function execQuiet(command: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, ...(cwd ? { cwd } : {}) }, (error) => {
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
  options: { quiet?: boolean; projectRoot?: string } = {},
): Promise<{ success: boolean; sha?: string }> {
  const agentArgs = skillAgentArgs(providerIDs);
  if (!agentArgs) {
    logger.debug("skill", "No selected providers support the Dosu skill");
    return { success: true };
  }

  if (options.projectRoot) {
    const targets = projectSkillInstallTargetsForProviders(
      providerIDs ?? Object.keys(SKILL_AGENT_BY_PROVIDER),
      options.projectRoot,
    );
    assertProjectSkillInstallSafe({ projectRoot: options.projectRoot, targets });
  }

  try {
    const scope = options.projectRoot ? "" : " -g";
    const command = `npx -y skills@${SKILLS_CLI_VERSION} add ${SKILL_REPO}${scope} ${agentArgs} -s ${SKILL_NAME} -y`;
    if (options.quiet) await execQuiet(command, options.projectRoot);
    else
      execSync(command, {
        stdio: "inherit",
        ...(options.projectRoot ? { cwd: options.projectRoot } : {}),
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
        execSync(`npx -y skills@${SKILLS_CLI_VERSION} remove -g -s ${SKILL_NAME} -y`, {
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
      console.log(pc.green(`\n✓ Skill "${SKILL_NAME}" updated.`));
    });

  return cmd;
}
