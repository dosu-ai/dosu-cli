/**
 * `dosu skill` — manage the Dosu agent skill.
 */

import { exec, execSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import { assertSafeProjectPath, hasSymlinkInPath } from "../setup/project-root";
import { clearInstalledSha, fetchLatestSha, writeSkillCache } from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
// Pin the temporary destructive migration to the skills CLI behavior audited for this release.
const LEGACY_SKILLS_CLI_VERSION = "1.5.22";
const ISOLATED_LEGACY_GLOBAL_SKILL_PROVIDERS = new Set(["claude", "factory"]);
const OWNED_SKILL_SOURCES = new Set([
  SKILL_REPO,
  `https://github.com/${SKILL_REPO}`,
  `https://github.com/${SKILL_REPO}.git`,
]);
/**
 * Names are interpolated into a shell command as positional arguments, so keep
 * them boring. The leading character must be alphanumeric: `skills list` echoes
 * the SKILL.md front-matter name verbatim without validating its shape, and a
 * name like `--all` would be re-parsed as an option by `skills remove`, which
 * treats it as "delete every installed skill from every source".
 */
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

function skillAgentArgs(providerIDs?: readonly string[], project = false): string {
  const agents =
    providerIDs === undefined ? SUPPORTED_SKILL_AGENTS : skillAgentIDsForProviders(providerIDs);
  return project
    ? agents.length > 0
      ? `-a ${agents.join(" ")}`
      : ""
    : agents.map((agent) => `-a ${agent}`).join(" ");
}

function execQuiet(command: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, ...(cwd ? { cwd } : {}) }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function hasOwnedSkillLock(lockPath: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      skills?: Record<string, { source?: unknown; sourceUrl?: unknown }>;
    };
    const entry = lock.skills?.[SKILL_NAME];
    return Boolean(
      entry &&
        [entry.source, entry.sourceUrl].some(
          (source) => typeof source === "string" && OWNED_SKILL_SOURCES.has(source),
        ),
    );
  } catch {
    return false;
  }
}

function isDosuSkillDirectory(path: string): boolean {
  try {
    const skillFile = join(path, "SKILL.md");
    if (!lstatSync(path).isDirectory() || hasSymlinkInPath(skillFile)) return false;
    if (!lstatSync(skillFile).isFile()) return false;
    const content = readFileSync(skillFile, "utf-8");
    return /^name:\s*['"]?dosu['"]?\s*$/m.test(content) && content.includes("Dosu CLI");
  } catch {
    return false;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function safeLegacyGlobalSkillProviderIDs(providerIDs: readonly string[]): string[] {
  const canonicalPath = join(homedir(), ".agents", "skills", SKILL_NAME);
  if (hasSymlinkInPath(canonicalPath)) return [];
  if (pathEntryExists(canonicalPath) && !isDosuSkillDirectory(canonicalPath)) return [];
  return [...new Set(providerIDs)].filter((providerID) => {
    // Universal agents share ~/.agents/skills and have extra upstream removal
    // paths, so they keep their global copy until that can be migrated safely.
    if (!ISOLATED_LEGACY_GLOBAL_SKILL_PROVIDERS.has(providerID)) return false;
    const target = skillInstallTargetForProvider(providerID);
    if (!target || !pathEntryExists(target.path) || hasSymlinkInPath(dirname(target.path))) {
      return false;
    }
    try {
      const stat = lstatSync(target.path);
      if (!stat.isSymbolicLink()) return isDosuSkillDirectory(target.path);
      if (!target.symlink || hasSymlinkInPath(dirname(canonicalPath))) return false;
      return (
        realpathSync(target.path) === realpathSync(canonicalPath) &&
        isDosuSkillDirectory(canonicalPath)
      );
    } catch {
      return false;
    }
  });
}

/** Providers whose expected project skill target is a verified Dosu copy. */
export function verifiedProjectSkillProviderIDs(
  providerIDs: readonly string[],
  projectRoot: string,
): string[] {
  const lockPath = join(projectRoot, "skills-lock.json");
  try {
    assertSafeProjectPath(projectRoot, lockPath);
    if (!hasOwnedSkillLock(lockPath)) return [];
  } catch {
    return [];
  }

  return [...new Set(providerIDs)].filter((providerID) => {
    const target = skillInstallTargetForProvider(providerID, projectRoot);
    if (!target) return false;
    try {
      assertSafeProjectPath(projectRoot, target.path);
      assertSafeProjectPath(projectRoot, join(target.path, "SKILL.md"));
      return isDosuSkillDirectory(target.path);
    } catch {
      return false;
    }
  });
}

/** Best-effort removal used only by the temporary legacy setup migration. */
export async function removeGlobalSkillQuietly(providerIDs: readonly string[]): Promise<boolean> {
  try {
    const stateRoot = process.env.XDG_STATE_HOME?.trim();
    const lockPath = stateRoot
      ? join(stateRoot, "skills", ".skill-lock.json")
      : join(homedir(), ".agents", ".skill-lock.json");
    if (hasSymlinkInPath(lockPath) || !hasOwnedSkillLock(lockPath)) return false;
    const agentIDs = skillAgentIDsForProviders(safeLegacyGlobalSkillProviderIDs(providerIDs));
    if (agentIDs.length === 0) return false;
    await execQuiet(
      `npx -y skills@${LEGACY_SKILLS_CLI_VERSION} remove -g -a ${agentIDs.join(" ")} -s ${SKILL_NAME} -y`,
    );
    return true;
  } catch {
    return false;
  }
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
  const agentArgs = skillAgentArgs(providerIDs, Boolean(options.projectRoot));
  if (!agentArgs) {
    logger.debug("skill", "No selected providers support the Dosu skill");
    return { success: true };
  }

  if (options.projectRoot) {
    assertSafeProjectPath(options.projectRoot, join(options.projectRoot, "skills-lock.json"));
    const targets = new Set(
      (providerIDs ?? [])
        .map((providerID) => skillInstallTargetForProvider(providerID, options.projectRoot))
        .filter((target): target is SkillInstallTarget => target !== null)
        .map((target) => target.path),
    );
    for (const target of targets) assertSafeProjectPath(options.projectRoot, target);
  }

  try {
    // `-s "*"` installs every skill the repo exposes, so adding one upstream
    // does not require a CLI release. The quoting is load-bearing and must be
    // double quotes: this string is run through a shell, so on POSIX a bare `*`
    // would glob-expand against cwd, while on Windows the shell is cmd.exe,
    // which does not treat single quotes as delimiters and would forward a
    // literal `'*'` that matches no skill name.
    const global = options.projectRoot ? "" : " -g";
    const copy = options.projectRoot ? " --copy" : "";
    const command = `npx skills add ${SKILL_REPO}${global} ${agentArgs} -s "*"${copy} -y`;
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

/**
 * Names of the globally installed skills that came from {@link SKILL_REPO},
 * as reported by the skills CLI's own inventory.
 *
 * `skills remove` resolves exact names and has no wildcard, so removing our
 * whole set means enumerating it first. An empty array means none of ours are
 * installed; `null` means the inventory could not be read, which is a different
 * situation and gets a different fallback.
 */
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
      // Names go in positionally: the remove parser silently drops `-s`, and
      // passing none at all opens an interactive picker. When the inventory is
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
