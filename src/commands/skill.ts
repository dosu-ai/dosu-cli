/**
 * `dosu skill` — manage the Dosu agent skill.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { logger } from "../debug/logger";
import { findNpx, npxPathEnv } from "../mcp/detect";
import { clearInstalledSha, fetchLatestSha, writeSkillCache } from "../version/skill-update-check";

const SKILL_REPO = "dosu-ai/dosu-skill";
const SKILL_NAME = "dosu";
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
  "droid",
];

const SKILL_AGENT_ID_BY_DISPLAY_NAME: Readonly<Record<string, string>> = {
  Antigravity: "antigravity",
  "Claude Code": "claude-code",
  Cline: "cline",
  Codex: "codex",
  Cursor: "cursor",
  Droid: "droid",
  Factory: "droid",
  "Gemini CLI": "gemini-cli",
  "GitHub Copilot": "github-copilot",
  OpenCode: "opencode",
  Windsurf: "windsurf",
  Zed: "zed",
};

const SUPPORTED_SKILL_AGENT_SET = new Set(SUPPORTED_SKILL_AGENTS);

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

  if (agentID === "droid") {
    return {
      path: join(homedir(), ".factory", "skills", SKILL_NAME),
      symlink: true,
    };
  }

  return {
    path: join(homedir(), ".agents", "skills", SKILL_NAME),
    symlink: false,
  };
}

function skillAgentArgs(agentIDs: readonly string[]): string[] {
  return agentIDs.flatMap((agent) => ["-a", agent]);
}

interface SkillInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function windowsCommandProcessor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (
    env.ComSpec &&
    win32.isAbsolute(env.ComSpec) &&
    win32.basename(env.ComSpec).toLowerCase() === "cmd.exe"
  ) {
    return env.ComSpec;
  }
  const systemRoot =
    env.SystemRoot && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return win32.join(systemRoot, "System32", "cmd.exe");
}

function quoteWindowsCommandArg(value: string): string {
  if (/[\r\n"&|<>^%!]/.test(value)) {
    throw new Error("npx path or argument contains unsupported Windows shell characters");
  }
  return value === "*" || /\s/.test(value) ? `"${value}"` : value;
}

/** Build a project-independent invocation of the trusted npx found on PATH. */
function buildSkillInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  npx: string = findNpx(),
): SkillInvocation {
  const safeEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: npxPathEnv(npx),
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    YARN_IGNORE_PATH: "1",
  };
  if (platform !== "win32") return { command: npx, args: [...args], env: safeEnv };

  const commandLine = [npx, ...args].map(quoteWindowsCommandArg).join(" ");
  return {
    command: windowsCommandProcessor(env),
    args: ["/d", "/s", "/c", commandLine],
    env: { ...safeEnv, NoDefaultCurrentDirectoryInExePath: "1" },
  };
}

function runSkillSync(
  args: readonly string[],
  output: "inherit" | "capture" = "inherit",
): string | null {
  const invocation = buildSkillInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: homedir(),
    encoding: output === "capture" ? "utf8" : undefined,
    env: invocation.env,
    shell: false,
    stdio: output === "capture" ? ["ignore", "pipe", "ignore"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    throw (
      result.error ?? new Error(`skills command exited with status ${result.status ?? "unknown"}`)
    );
  }
  return output === "capture" && typeof result.stdout === "string" ? result.stdout : null;
}

function runSkillQuiet(args: readonly string[]): Promise<void> {
  const invocation = buildSkillInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: homedir(),
      env: invocation.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`skills command exited with status ${code ?? "unknown"}`));
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
  const agentIDs =
    providerIDs === undefined ? SUPPORTED_SKILL_AGENTS : skillAgentIDsForProviders(providerIDs);
  return installSkillForAgents(agentIDs, options);
}

/** Install every official skill for an already validated set of agent IDs. */
export async function installSkillForAgents(
  requestedAgentIDs: readonly string[],
  options: { quiet?: boolean } = {},
): Promise<{ success: boolean; sha?: string }> {
  const agentIDs = [
    ...new Set(requestedAgentIDs.filter((agentID) => SUPPORTED_SKILL_AGENT_SET.has(agentID))),
  ];
  const agentArgs = skillAgentArgs(agentIDs);
  if (agentArgs.length === 0) {
    logger.debug("skill", "No supported agents were selected for the Dosu skill");
    return { success: true };
  }

  try {
    // The literal wildcard asks the upstream installer for every skill in the
    // reviewed Dosu repository. Argument arrays keep it out of shell globbing.
    const args = ["skills", "add", SKILL_REPO, "-g", ...agentArgs, "-s", "*", "-y"];
    if (options.quiet) await runSkillQuiet(args);
    else runSkillSync(args);
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
export interface InstalledDosuSkillState {
  names: string[];
  agentIDs: string[];
}

export function installedDosuSkillState(): InstalledDosuSkillState | null {
  let entries: { name?: unknown; source?: unknown; agents?: unknown }[];
  try {
    const json = runSkillSync(["skills", "list", "-g", "--json"], "capture");
    if (json === null) throw new Error("skills inventory produced no output");
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    entries = parsed;
  } catch (err) {
    logger.debug("skill", `Could not list installed skills: ${err}`);
    return null;
  }

  const names = new Set<string>();
  const agentIDs = new Set<string>();
  for (const entry of entries) {
    if (entry.source !== SKILL_REPO || typeof entry.name !== "string") continue;
    if (!SAFE_SKILL_NAME.test(entry.name)) {
      logger.warn("skill", `Skipping skill with an unsupported name: ${entry.name}`);
      continue;
    }
    names.add(entry.name);
    if (!Array.isArray(entry.agents)) continue;
    for (const displayName of entry.agents) {
      if (typeof displayName !== "string") continue;
      const agentID = SKILL_AGENT_ID_BY_DISPLAY_NAME[displayName] ?? displayName;
      if (SUPPORTED_SKILL_AGENT_SET.has(agentID)) agentIDs.add(agentID);
    }
  }
  return { names: [...names], agentIDs: [...agentIDs] };
}

function installedSkillNames(): string[] | null {
  return installedDosuSkillState()?.names ?? null;
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
        runSkillSync(["skills", "remove", "-g", ...targets, "-y"]);
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
      const installed = installedDosuSkillState();
      if (installed === null) {
        console.error(pc.red(`\nCould not inspect installed Dosu skills.`));
        process.exit(1);
      }
      if (installed.names.length === 0) {
        console.log(`No skills from ${SKILL_REPO} are installed.`);
        return;
      }
      if (installed.agentIDs.length === 0) {
        console.error(pc.red(`\nCould not determine which agents use the installed Dosu skills.`));
        process.exit(1);
      }
      // Reinstall rather than `npx skills update`: update matches on the
      // skillPath recorded in the skills lockfile, so it can't follow the
      // skill across a repo-layout move (it reports "deleted upstream"
      // instead). `skills add` overwrites by name and refreshes the lock
      // entry, so it always converges on the latest layout.
      const result = await installSkillForAgents(installed.agentIDs);
      if (!result.success) {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
      console.log(pc.green(`\n✓ Skills updated.`));
    });

  return cmd;
}
