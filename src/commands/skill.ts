/**
 * `dosu skill` — manage the Dosu agent skill, and link Dosu documents as live
 * skills (`link|resolve|links|unlink`).
 */

import { exec, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, Option } from "commander";
import pc from "picocolors";
import { emitError } from "../agent/output";
import { createTypedClient } from "../client/trpc";
import { logger } from "../debug/logger";
import { inGitWorkTree } from "../setup/agents-md-step";
import {
  defaultSkillDescription,
  MAX_SKILL_DESCRIPTION_LENGTH,
  renderSkillMarkdown,
  skillNameError,
} from "../skills/binding";
import { resolveLinkedProcedure } from "../skills/resolve";
import {
  type ExistingBinding,
  linkedSkillRoot,
  listLinkedSkills,
  readExistingBinding,
  removeLinkedSkill,
  type SkillRoot,
  skillPathsFor,
  writeSkillFile,
} from "../skills/store";
import {
  type LinkedSkillEntry,
  SKILL_LINK_TEMPLATE_VERSION,
  type SkillAgent,
  type SkillScope,
} from "../skills/types";
import { clearInstalledSha, fetchLatestSha, writeSkillCache } from "../version/skill-update-check";
import { VERSION } from "../version/version";
import { boundedText, positiveInteger, uuid } from "./arguments";
import { requireLoginConfig } from "./auth";
import { printInfo, printResult, printTable } from "./output";

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

// ─── Live knowledge skills (`skill link|resolve|links|unlink`) ───────────────

/** Coding agents that can host a linked skill. Claude Code only in v1. */
const LINK_AGENTS: readonly SkillAgent[] = ["claude"];

const INVALID_NAME_NEXT_STEPS =
  "Choose a name that starts with a letter or digit and uses only letters, digits, '.', '_' or '-'.";

const UNLINK_NEXT_STEPS: Readonly<Record<"not_found" | "not_a_dosu_link" | "corrupt", string>> = {
  not_found: "Run 'dosu skill links' to see linked skills.",
  not_a_dosu_link:
    "This skill was not created by 'dosu skill link'; remove it manually if intended.",
  corrupt: "Inspect the file and remove it manually if intended.",
};

interface CommandFailure {
  reason: string;
  message: string;
  agent_next_steps: string;
  details?: Record<string, unknown>;
}

/**
 * Report a classified failure and exit 1. In `--json` mode the error is one JSON
 * object on stdout (the driving agent reads stdout); in human mode it is red
 * text on stderr so stdout only ever carries data.
 */
function fail(step: string, json: boolean | undefined, failure: CommandFailure): never {
  if (json) {
    emitError({
      step,
      reason: failure.reason,
      message: failure.message,
      ...(failure.details ? { details: failure.details } : {}),
      agent_next_steps: failure.agent_next_steps,
    });
  } else {
    console.error(pc.red(`Error [${failure.reason}]: ${failure.message}`));
    console.error(pc.dim(failure.agent_next_steps));
  }
  process.exit(1);
}

/** Logged in with a selected Library; same guard and messages as `dosu docs`. */
function requireConfig() {
  const cfg = requireLoginConfig();
  const libraryId = cfg.active_account?.target?.space_id;
  if (!libraryId) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return { cfg, libraryId, orgId: cfg.active_account?.target?.org_id ?? null };
}

function agentOption(): Option {
  return new Option("--agent <agent>", "Coding agent that hosts the skill").choices(LINK_AGENTS);
}

function scopeFor(project: boolean | undefined): SkillScope {
  return project ? "project" : "user";
}

/** Validate the name, then resolve `<root>/<name>/SKILL.md` with the containment check. */
function pathsFor(
  agent: SkillAgent,
  scope: SkillScope,
  name: string,
  step: string,
  json: boolean | undefined,
): { dir: string; file: string } {
  const nameError = skillNameError(name);
  if (nameError) {
    fail(step, json, {
      reason: "invalid_name",
      message: nameError,
      agent_next_steps: INVALID_NAME_NEXT_STEPS,
    });
  }
  const root = linkedSkillRoot(agent, scope);
  const paths = skillPathsFor(root, name);
  // Defense in depth: skillNameError already rejects every shape skillPathsFor
  // refuses, but the containment check is what actually guards the filesystem.
  if (!paths) {
    fail(step, json, {
      reason: "invalid_name",
      message: `Skill name "${name}" does not resolve to a directory inside ${root}.`,
      agent_next_steps: INVALID_NAME_NEXT_STEPS,
    });
  }
  return paths;
}

type LinkAction = "created" | "updated" | "unchanged";

type LinkDecision =
  | { kind: "write"; action: Exclude<LinkAction, "unchanged"> }
  | { kind: "unchanged" }
  | { kind: "fail"; failure: CommandFailure };

/**
 * Existing-target rules for `skill link`. Foreign skills are never overwritten,
 * `--force` or not; owned bindings are rewritten freely unless the user edited
 * the generated file or the binding points at another document.
 */
function decideLink(
  existing: ExistingBinding,
  input: { name: string; file: string; document_id: string; content: string; force: boolean },
): LinkDecision {
  const { name, file, document_id, content, force } = input;
  switch (existing.kind) {
    case "absent":
      return { kind: "write", action: "created" };
    case "foreign":
      return {
        kind: "fail",
        failure: {
          reason: "name_taken",
          message: `A skill named '${name}' already exists at ${file} and was not created by Dosu.`,
          agent_next_steps:
            "Choose a different --name. --force does not overwrite skills Dosu does not own.",
        },
      };
    case "corrupt":
      if (force) return { kind: "write", action: "updated" };
      return {
        kind: "fail",
        failure: {
          reason: "binding_corrupt",
          message: existing.message,
          agent_next_steps: "Inspect the file, then re-run with --force to overwrite it.",
        },
      };
    case "owned": {
      const previous = existing.marker.document_id;
      if (previous !== document_id && !force) {
        return {
          kind: "fail",
          failure: {
            reason: "binding_points_elsewhere",
            message: `Skill '${name}' is linked to document ${previous}.`,
            details: { previous_document_id: previous },
            agent_next_steps: `Re-run with --force to point it at ${document_id}, or choose a different --name.`,
          },
        };
      }
      if (existing.content === content) return { kind: "unchanged" };
      if (existing.edited && !force) {
        return {
          kind: "fail",
          failure: {
            reason: "binding_modified",
            message: `The generated file at ${file} was edited after it was created.`,
            agent_next_steps:
              "Re-run with --force to overwrite your edits, or unlink and link again.",
          },
        };
      }
      return { kind: "write", action: "updated" };
    }
  }
}

function trackingLabel(revision: number | null): string {
  return revision === null ? "live" : `pinned to revision ${revision}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function linkRow(entry: LinkedSkillEntry): string[] {
  const { marker } = entry;
  return [
    entry.edited ? `${entry.name} *` : entry.name,
    shortId(marker.document_id),
    marker.revision === null ? "live" : `pinned (r${marker.revision})`,
    shortId(marker.library_id),
    entry.scope,
    entry.path,
  ];
}

interface LinkOptions {
  name: string;
  agent: SkillAgent;
  revision?: number;
  description?: string;
  project?: boolean;
  force?: boolean;
  json?: boolean;
}

interface ResolveOptions {
  document: string;
  library: string;
  revision?: number;
  json?: boolean;
}

interface LinksOptions {
  agent: SkillAgent;
  project?: boolean;
  json?: boolean;
}

interface UnlinkOptions {
  agent: SkillAgent;
  project?: boolean;
  json?: boolean;
}

export function skillCommand(): Command {
  const cmd = new Command("skill").description(
    "Manage the Dosu agent skill and link Dosu documents as live skills",
  );

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

  cmd
    .command("link")
    .description("Link a Dosu document as a live skill for a coding agent")
    .argument("<document-id>", "Dosu document ID", uuid)
    .requiredOption("--name <skill-name>", "Skill name (invoked as /<skill-name>)")
    .addOption(agentOption().makeOptionMandatory())
    .option(
      "--revision <n>",
      "Pin the skill to this revision instead of following the highest published one",
      positiveInteger,
    )
    .option(
      "--description <text>",
      "Override the generated skill description",
      boundedText(MAX_SKILL_DESCRIPTION_LENGTH),
    )
    .option("--project", "Link in this repository's .claude/skills instead of user scope")
    .option("--force", "Overwrite an edited binding or one linked to another document")
    .option("--json", "Output as JSON")
    .action(async (documentId: string, opts: LinkOptions) => {
      const step = "skill_link";
      const { cfg, libraryId, orgId } = requireConfig();
      const scope = scopeFor(opts.project);
      if (scope === "project" && !inGitWorkTree()) {
        fail(step, opts.json, {
          reason: "not_a_git_work_tree",
          message: "--project requires a git work tree.",
          agent_next_steps:
            "Run this command inside a repository, or omit --project to link in user scope.",
        });
      }
      const paths = pathsFor(opts.agent, scope, opts.name, step, opts.json);
      const revision = opts.revision ?? null;

      // Resolve exactly as `skill resolve` would; a source that cannot be
      // resolved now is refused at link time and nothing is written.
      const client = createTypedClient(cfg);
      const result = await resolveLinkedProcedure(client, {
        document_id: documentId,
        library_id: libraryId,
        active_library_id: libraryId,
        revision,
      });
      if (!result.ok) fail(step, opts.json, result);

      const description =
        opts.description ?? defaultSkillDescription(result.source.title, opts.name, revision);
      const content = renderSkillMarkdown({
        name: opts.name,
        description,
        marker: {
          document_id: documentId,
          library_id: libraryId,
          org_id: orgId,
          revision,
          template: SKILL_LINK_TEMPLATE_VERSION,
          cli_version: VERSION,
        },
      });

      const decision = decideLink(readExistingBinding(paths.file), {
        name: opts.name,
        file: paths.file,
        document_id: documentId,
        content,
        force: opts.force === true,
      });
      if (decision.kind === "fail") fail(step, opts.json, decision.failure);
      if (decision.kind === "write") writeSkillFile(paths.file, content);
      const action: LinkAction = decision.kind === "write" ? decision.action : "unchanged";

      const nextSteps = `Invoke /${opts.name} in Claude Code. If the skill does not appear, start a new session.`;
      if (opts.json) {
        printResult(
          {
            step,
            status: "ok",
            action,
            skill: { name: opts.name, agent: opts.agent, scope, path: paths.file },
            source: {
              document_id: documentId,
              title: result.source.title,
              library_id: libraryId,
              tracking: result.source.tracking,
              resolved_revision: result.source.revision,
            },
            agent_next_steps: nextSteps,
          },
          { json: true },
        );
        return;
      }
      console.log(pc.green(`✓ Linked skill '${opts.name}' (${action})`));
      printInfo([
        ["Document", result.source.title],
        ["ID", documentId],
        ["Tracking", trackingLabel(revision)],
        ["Resolved", `revision ${result.source.revision}`],
        ["Path", paths.file],
      ]);
      console.log(pc.dim(nextSteps));
    });

  cmd
    .command("resolve")
    .description("Fetch the published revision of the document a linked skill points at")
    .requiredOption("--document <document-id>", "Dosu document ID", uuid)
    .requiredOption("--library <library-id>", "Library ID recorded in the skill", uuid)
    .option("--revision <n>", "Pinned revision (omit for the highest published)", positiveInteger)
    .option("--json", "Output as JSON")
    .action(async (opts: ResolveOptions) => {
      const step = "skill_resolve";
      const { cfg, libraryId } = requireConfig();
      const client = createTypedClient(cfg);
      const result = await resolveLinkedProcedure(client, {
        document_id: opts.document,
        library_id: opts.library,
        active_library_id: libraryId,
        revision: opts.revision ?? null,
      });
      if (!result.ok) fail(step, opts.json, result);

      if (opts.json) {
        printResult(
          { step, status: "ok", source: result.source, body: result.body },
          { json: true },
        );
        return;
      }
      const { title, document_id, revision, tracking } = result.source;
      console.log(
        pc.bold(
          `Source: "${title}" · document ${document_id} · revision ${revision} · ${tracking}`,
        ),
      );
      console.log("");
      // The body is data for the agent to follow; nothing in it is executed here.
      console.log(result.body);
    });

  cmd
    .command("links")
    .description("List skills linked to Dosu documents")
    .addOption(agentOption().default("claude"))
    .option("--project", "Also scan this repository's .claude/skills")
    .option("--json", "Output as JSON")
    .action((opts: LinksOptions) => {
      const roots: SkillRoot[] = [
        { root: linkedSkillRoot(opts.agent, "user"), agent: opts.agent, scope: "user" },
      ];
      const projectRoot = linkedSkillRoot(opts.agent, "project");
      if (opts.project || existsSync(projectRoot)) {
        roots.push({ root: projectRoot, agent: opts.agent, scope: "project" });
      }
      const entries = listLinkedSkills(roots);

      if (opts.json) {
        printResult({ step: "skill_links", status: "ok", skills: entries }, { json: true });
        return;
      }
      if (entries.length === 0) {
        console.log(pc.dim("No linked skills found."));
        return;
      }
      printTable(
        ["Name", "Document", "Tracking", "Library", "Scope", "Path"],
        entries.map(linkRow),
      );
      if (entries.some((entry) => entry.edited)) {
        console.log(pc.dim("* edited after it was generated"));
      }
    });

  cmd
    .command("unlink")
    .description("Remove a skill created by 'dosu skill link'")
    .argument("<skill-name>", "Skill name")
    .addOption(agentOption().makeOptionMandatory())
    .option("--project", "Remove from this repository's .claude/skills instead of user scope")
    .option("--json", "Output as JSON")
    .action((name: string, opts: UnlinkOptions) => {
      const step = "skill_unlink";
      const scope = scopeFor(opts.project);
      const paths = pathsFor(opts.agent, scope, name, step, opts.json);
      const result = removeLinkedSkill(paths.file);
      if (!result.removed) {
        fail(step, opts.json, {
          reason: result.reason,
          message: result.message,
          agent_next_steps: UNLINK_NEXT_STEPS[result.reason],
        });
      }

      if (opts.json) {
        printResult(
          {
            step,
            status: "ok",
            skill: { name, agent: opts.agent, scope, path: paths.file },
            directory_removed: result.directory_removed,
            leftover: result.leftover,
          },
          { json: true },
        );
        return;
      }
      console.log(pc.green(`✓ Unlinked skill '${name}'`));
      if (result.leftover.length > 0) {
        console.log(pc.dim(`Left in place: ${paths.dir} (${result.leftover.join(", ")})`));
      }
    });

  return cmd;
}
