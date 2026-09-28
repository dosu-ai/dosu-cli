/** `dosu skill`: install the agent skills that ship inside this CLI build.
 *
 * The skills (`skills/` in the repository, embedded at build time as `BUNDLED_SKILLS`) are
 * written to the universal `~/.agents/skills/<name>` directory that Cursor, Codex, Gemini CLI,
 * Zed, Cline, Copilot, OpenCode, and Antigravity all read. Claude Code and Windsurf read their own
 * directories, which receive a symlink to the universal copy (or a plain copy where symlinks are
 * unavailable). Because the skill content is version-locked to the binary, "updating" a skill
 * means upgrading the CLI; `checkForSkillUpdates` re-applies the bundle after an upgrade. */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import { BUNDLED_SKILLS, type BundledSkill } from "../generated/skills";
import { VERSION } from "../version/version";

/** Primary skill; setup summaries point at its install path. */
const SKILL_NAME = "dosu";
/** Source recorded by the `skills` CLI for installs that predate the bundled skills. */
const LEGACY_SKILL_SOURCE = "dosu-ai/dosu-skill";
const INSTALL_STATE_FILENAME = "skill-install.json";
const LEGACY_CACHE_FILENAME = "skill-update-check.json";

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
] as const;

type SkillAgentID = (typeof SUPPORTED_SKILL_AGENTS)[number];

const SKILL_AGENT_BY_PROVIDER: Readonly<Record<string, SkillAgentID>> = {
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
        .filter((agent): agent is SkillAgentID => Boolean(agent)),
    ),
  ];
}

function isSkillAgentID(agent: string): agent is SkillAgentID {
  return (SUPPORTED_SKILL_AGENTS as readonly string[]).includes(agent);
}

/** Directory shared by every agent that reads the universal skills location. */
function universalSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

/** Agents that read a private skills directory instead of the universal one. */
function linkedSkillsDir(agent: SkillAgentID): string | null {
  if (agent === "claude-code") {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    return join(claudeConfigDir, "skills");
  }
  if (agent === "windsurf") return join(homedir(), ".codeium", "windsurf", "skills");
  return null;
}

export interface SkillInstallTarget {
  path: string;
  symlink: boolean;
}

export function skillInstallTargetForProvider(providerID: string): SkillInstallTarget | null {
  const agentID = SKILL_AGENT_BY_PROVIDER[providerID];
  if (!agentID) return null;
  const linked = linkedSkillsDir(agentID);
  if (linked) return { path: join(linked, SKILL_NAME), symlink: true };
  return { path: join(universalSkillsDir(), SKILL_NAME), symlink: false };
}

// ---------------------------------------------------------------------------------------------
// Install state — which bundle version wrote the skills, for which agents.
// ---------------------------------------------------------------------------------------------

export interface SkillInstallState {
  /** CLI version whose bundle was last written to disk. */
  version: string;
  /** Skill agent IDs (not provider IDs) whose directories were populated or linked. */
  agents: string[];
  installedAt: number;
}

function installStatePath(): string {
  return join(getConfigDir(), INSTALL_STATE_FILENAME);
}

export function readSkillInstallState(): SkillInstallState | null {
  try {
    const path = installStatePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (
      typeof data?.version === "string" &&
      Array.isArray(data.agents) &&
      data.agents.every((agent: unknown) => typeof agent === "string") &&
      typeof data.installedAt === "number"
    ) {
      return { version: data.version, agents: data.agents, installedAt: data.installedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function writeSkillInstallState(state: SkillInstallState): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(installStatePath(), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    logger.debug("skill", `Could not record skill install state: ${err}`);
  }
}

function clearSkillInstallState(): void {
  rmSync(installStatePath(), { force: true });
}

// ---------------------------------------------------------------------------------------------
// Legacy `skills` CLI bookkeeping.
// ---------------------------------------------------------------------------------------------

/** Names the `skills` CLI recorded as installed from {@link LEGACY_SKILL_SOURCE}, removing those
 * entries from its lock file so a later `npx skills update` cannot overwrite the bundled copy
 * with the archived repository's content. Best effort; returns the names it found. */
function pruneLegacySkillLock(): string[] {
  const lockPath = join(homedir(), ".agents", ".skill-lock.json");
  try {
    if (!existsSync(lockPath)) return [];
    const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
    const skills = lock?.skills;
    if (!skills || typeof skills !== "object") return [];
    const legacy = Object.entries(skills as Record<string, { source?: unknown }>)
      .filter(([, entry]) => entry?.source === LEGACY_SKILL_SOURCE)
      .map(([name]) => name);
    if (legacy.length === 0) return [];
    for (const name of legacy) delete skills[name];
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    logger.debug("skill", `Removed legacy lock entries: ${legacy.join(", ")}`);
    return legacy;
  } catch (err) {
    logger.debug("skill", `Could not read legacy skill lock: ${err}`);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Filesystem operations.
// ---------------------------------------------------------------------------------------------

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Replace `dir` wholesale with the skill's files, mirroring how `skills add` overwrote by name. */
function writeSkillDir(skill: BundledSkill, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  for (const file of skill.files) {
    const target = join(dir, ...file.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { mode: file.executable ? 0o755 : 0o644 });
  }
}

/** Point `linkPath` at `targetDir`, falling back to a copy where symlinks are unavailable. */
function linkSkillDir(linkPath: string, targetDir: string): "symlink" | "copy" {
  mkdirSync(dirname(linkPath), { recursive: true });
  rmSync(linkPath, { recursive: true, force: true });
  try {
    symlinkSync(relative(dirname(linkPath), targetDir), linkPath, "dir");
    return "symlink";
  } catch (err) {
    logger.debug("skill", `Symlink failed for ${linkPath}, copying instead: ${err}`);
    cpSync(targetDir, linkPath, { recursive: true });
    return "copy";
  }
}

function removeSkillDir(dir: string): boolean {
  if (!pathExists(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface SkillInstallResult {
  success: boolean;
  /** CLI version whose bundle was written. */
  version?: string;
  /** Every directory written or linked, for display. */
  paths?: string[];
}

/** Write the bundled skills for the given skill agents. Synchronous: it is pure filesystem work
 * and also runs from the pre-action upgrade check. */
export function installBundledSkills(agentIDs: readonly string[]): SkillInstallResult {
  const agents = agentIDs.filter(isSkillAgentID);
  if (agents.length === 0) {
    logger.debug("skill", "No selected agents support the Dosu skill");
    return { success: true };
  }

  try {
    const legacy = pruneLegacySkillLock();
    const bundledNames = new Set(BUNDLED_SKILLS.map((skill) => skill.name));
    const linkDirs = [
      ...new Set(agents.map(linkedSkillsDir).filter((dir): dir is string => !!dir)),
    ];

    // Skills the archived repository shipped that this build no longer carries would otherwise
    // linger unmanaged; drop them like `dosu skill remove` always has.
    for (const name of legacy) {
      if (bundledNames.has(name)) continue;
      for (const dir of [universalSkillsDir(), ...linkDirs]) removeSkillDir(join(dir, name));
    }

    const paths: string[] = [];
    for (const skill of BUNDLED_SKILLS) {
      const universal = join(universalSkillsDir(), skill.name);
      writeSkillDir(skill, universal);
      paths.push(universal);
      for (const dir of linkDirs) {
        const linkPath = join(dir, skill.name);
        linkSkillDir(linkPath, universal);
        paths.push(linkPath);
      }
    }

    const previous = readSkillInstallState();
    writeSkillInstallState({
      version: VERSION,
      agents: [...new Set([...(previous?.agents ?? []), ...agents])],
      installedAt: Date.now(),
    });
    rmSync(join(getConfigDir(), LEGACY_CACHE_FILENAME), { force: true });
    logger.info("skill", `Installed bundled skills v${VERSION} for ${agents.join(", ")}`);
    return { success: true, version: VERSION, paths };
  } catch (err) {
    logger.error("skill", `Failed to install skill: ${err}`);
    return { success: false };
  }
}

/** Install the bundled skills for the given MCP providers (all supported agents when omitted). */
export async function installSkill(providerIDs?: readonly string[]): Promise<SkillInstallResult> {
  const agents =
    providerIDs === undefined
      ? [...SUPPORTED_SKILL_AGENTS]
      : skillAgentIDsForProviders(providerIDs);
  return installBundledSkills(agents);
}

/** Remove every bundled skill from the universal directory and every linked agent directory,
 * plus anything the legacy `skills` CLI still attributes to the Dosu repository. */
export function removeSkills(): string[] {
  const legacy = pruneLegacySkillLock();
  const names = new Set([...BUNDLED_SKILLS.map((skill) => skill.name), ...legacy]);
  const dirs = [
    universalSkillsDir(),
    ...new Set(SUPPORTED_SKILL_AGENTS.map(linkedSkillsDir).filter((dir): dir is string => !!dir)),
  ];
  const removed: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (removeSkillDir(path)) removed.push(path);
    }
  }
  clearSkillInstallState();
  rmSync(join(getConfigDir(), LEGACY_CACHE_FILENAME), { force: true });
  return removed;
}

function printPaths(paths: readonly string[]): void {
  for (const path of paths) console.log(pc.dim(`  ${path}`));
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description("Manage the Dosu agent skills bundled with the CLI");

  cmd
    .command("install")
    .description("Install the bundled Dosu skills for AI coding agents")
    .action(async () => {
      console.log(`Installing Dosu skills (v${VERSION})...`);
      const result = await installSkill();
      if (result.success) {
        printPaths(result.paths ?? []);
        console.log(pc.green(`\n✓ Skills installed successfully.`));
      } else {
        console.error(pc.red(`\nFailed to install skill. Run with --debug for details.`));
        process.exit(1);
      }
    });

  cmd
    .command("remove")
    .description("Remove the Dosu skills")
    .action(() => {
      try {
        const removed = removeSkills();
        if (removed.length === 0) {
          console.log("No Dosu skills are installed.");
          return;
        }
        console.log("Removing Dosu skills...");
        printPaths(removed);
        console.log(pc.green(`\n✓ Skills removed.`));
      } catch (err) {
        logger.error("skill", `Failed to remove skills: ${err}`);
        console.error(pc.red(`\nFailed to remove skills.`));
        process.exit(1);
      }
    });

  cmd
    .command("update")
    .description("Rewrite the Dosu skills from this CLI version (upgrade the CLI for newer skills)")
    .action(async () => {
      console.log(`Updating Dosu skills to the copy bundled with v${VERSION}...`);
      const result = await installSkill();
      if (!result.success) {
        console.error(pc.red(`\nFailed to update skill.`));
        process.exit(1);
      }
      printPaths(result.paths ?? []);
      console.log(pc.green(`\n✓ Skills updated.`));
      console.log(pc.dim("  Skills ship with the CLI; run `dosu upgrade` to get newer ones."));
    });

  return cmd;
}
