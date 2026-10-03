/** `/dosu-incognito` command installation per agent. The command file is the whole feature on
 * the agent side: invoking it records INCOGNITO_MARKER in the session transcript, which `dosu
 * knowledge sync` and the status line read. Codex has no user commands, so its command is a skill
 * the user mentions as `$dosu-incognito`. Targets mirror `src/rules/installer.ts`. */

import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCodeInstalled } from "../hooks/claude-code";
import { codexInstalled } from "../hooks/codex";
import { piHookAgent } from "../hooks/pi";
import { isInstalled } from "../mcp/detect";
import { INCOGNITO_COMMAND_NAME, INCOGNITO_MARKER } from "../sync/incognito";
import { isShippingEnabled, loadSyncState } from "../sync/state";

type IncognitoAction = "created" | "updated" | "unchanged" | "removed" | "not_found";

export interface IncognitoAgent {
  id(): string;
  name(): string;
  /** The agent itself is present on this machine. */
  isInstalled(): boolean;
  /** What the user types in a session to run it: `/dosu-incognito`, or Codex's `$dosu-incognito`. */
  invocation(): string;
  /** Where the command file lives. */
  commandPath(): string;
  /** The command file exists and carries the current marker. */
  isEnabled(): boolean;
  enable(): IncognitoAction;
  disable(): IncognitoAction;
}

/** The prompt the slash command expands to. The marker line is what the sync filter and the
 * status line look for; the rest tells the model to leave Dosu alone for the session. */
export const INCOGNITO_COMMAND_BODY = `Dosu incognito marker: ${INCOGNITO_MARKER}

Dosu is off for the rest of this session. Do not call any Dosu MCP tools (read_knowledge, write_knowledge, review_knowledge, finalize_session_knowledge), even where project rules ask you to. This session will not be shipped to Dosu memory.

Acknowledge in one line: "Dosu incognito: this session stays off the record."
`;

const DESCRIPTION =
  "Turn Dosu off for this session: no knowledge tools, and it is never shipped to Dosu memory";

/** Claude Code and OpenCode read a `description` from YAML frontmatter; Cursor takes plain
 * markdown. */
function withFrontmatter(body: string, extra = ""): string {
  return `---\ndescription: ${DESCRIPTION}\n${extra}---\n\n${body}`;
}

/** User invocation only. Claude Code offers its commands to the model through the Skill tool,
 * and the model runs one on its own when a prompt or project rule seems to ask for it ("Dosu must
 * be off here"): a session whose model ran this one would carry the marker the user never set.
 * OpenCode shows commands to the user alone, so its file needs no such line. */
const CLAUDE_COMMAND_POLICY = "disable-model-invocation: true\n";

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** opencode's global config dir, which it finds through XDG_CONFIG_HOME on every platform. */
function opencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

const FILE_NAME = `${INCOGNITO_COMMAND_NAME}.md`;

const SLASH_COMMAND = `/${INCOGNITO_COMMAND_NAME}`;

function carriesMarker(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf-8").includes(INCOGNITO_MARKER);
  } catch {
    return false;
  }
}

function writeIfChanged(path: string, content: string): IncognitoAction {
  if (existsSync(path)) {
    if (readFileSync(path, "utf-8") === content) return "unchanged";
    writeFileSync(path, content, "utf-8");
    return "updated";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return "created";
}

function removeIfPresent(path: string): IncognitoAction {
  if (!existsSync(path)) return "not_found";
  unlinkSync(path);
  return "removed";
}

/** Remove each directory in turn while it is empty: one the agent or the user keeps anything in
 * stays. */
function removeEmptyDirs(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

function fileAgent(options: {
  id: string;
  name: string;
  detectPath: () => string;
  commandPath: () => string;
  content: string;
}): IncognitoAgent {
  const { commandPath, content } = options;
  return {
    id: () => options.id,
    name: () => options.name,
    isInstalled: () => isInstalled([options.detectPath()]),
    invocation: () => SLASH_COMMAND,
    commandPath,
    isEnabled: () => carriesMarker(commandPath()),
    enable: () => writeIfChanged(commandPath(), content),
    disable: () => removeIfPresent(commandPath()),
  };
}

/** Codex's frontmatter is parsed as strict YAML, where an unquoted value cannot hold ": ". */
const CODEX_SKILL = `---\nname: ${INCOGNITO_COMMAND_NAME}\ndescription: ${JSON.stringify(DESCRIPTION)}\n---\n\n${INCOGNITO_COMMAND_BODY}`;

/** Explicit invocation only. Codex lists every other skill to the model, which may open one on
 * its own, and a session whose model read this one would carry the marker the user never set. */
const CODEX_SKILL_POLICY = "policy:\n  allow_implicit_invocation: false\n";

/** Codex: `$dosu-incognito`, a skill. Codex 0.140 and 0.160 run no user slash commands and no
 * longer load custom prompts (`prompts/*.md`, which older CLIs installed); a skill the user
 * mentions is injected into the conversation as a user turn, marker and all, in the TUI and in
 * `codex exec` alike. `$CODEX_HOME/skills` rather than the shared `~/.agents/skills`, which other
 * agents read too. */
function codexAgent(): IncognitoAgent {
  const skillDir = () => join(codexHome(), "skills", INCOGNITO_COMMAND_NAME);
  const skillPath = () => join(skillDir(), "SKILL.md");
  const policyPath = () => join(skillDir(), "agents", "openai.yaml");
  const legacyPromptPath = () => join(codexHome(), "prompts", FILE_NAME);
  /** The custom prompt an older CLI installed, never one of the user's own of the same name. */
  const removeLegacyPrompt = () => {
    if (!carriesMarker(legacyPromptPath())) return;
    unlinkSync(legacyPromptPath());
    removeEmptyDirs(dirname(legacyPromptPath()));
  };
  return {
    id: () => "codex",
    name: () => "Codex",
    // `codex` on PATH counts too, as for Claude Code.
    isInstalled: codexInstalled,
    invocation: () => `$${INCOGNITO_COMMAND_NAME}`,
    commandPath: skillPath,
    isEnabled: () => carriesMarker(skillPath()),
    enable: () => {
      const policy = writeIfChanged(policyPath(), CODEX_SKILL_POLICY);
      const skill = writeIfChanged(skillPath(), CODEX_SKILL);
      removeLegacyPrompt();
      return skill === "unchanged" && policy !== "unchanged" ? "updated" : skill;
    },
    disable: () => {
      const hadLegacy = carriesMarker(legacyPromptPath());
      removeLegacyPrompt();
      removeIfPresent(policyPath());
      const skill = removeIfPresent(skillPath());
      removeEmptyDirs(dirname(policyPath()), skillDir(), dirname(skillDir()));
      return hadLegacy ? "removed" : skill;
    },
  };
}

export function allIncognitoAgents(): IncognitoAgent[] {
  return [
    {
      ...fileAgent({
        id: "claude",
        name: "Claude Code",
        detectPath: claudeConfigDir,
        commandPath: () => join(claudeConfigDir(), "commands", FILE_NAME),
        content: withFrontmatter(INCOGNITO_COMMAND_BODY, CLAUDE_COMMAND_POLICY),
      }),
      // `claude` on PATH counts too: a fresh machine sets Dosu up before Claude Code's first run.
      isInstalled: claudeCodeInstalled,
    },
    fileAgent({
      id: "cursor",
      name: "Cursor",
      detectPath: () => join(homedir(), ".cursor"),
      commandPath: () => join(homedir(), ".cursor", "commands", FILE_NAME),
      content: INCOGNITO_COMMAND_BODY,
    }),
    codexAgent(),
    // A custom command: opencode sends the body as the session's next prompt.
    fileAgent({
      id: "opencode",
      name: "OpenCode",
      detectPath: opencodeConfigDir,
      commandPath: () => join(opencodeConfigDir(), "command", FILE_NAME),
      content: withFrontmatter(INCOGNITO_COMMAND_BODY),
    }),
  ];
}

export function getIncognitoAgent(id: string): IncognitoAgent | undefined {
  return allIncognitoAgents().find((agent) => agent.id() === id);
}

/** `dosu knowledge hooks disable <agent>`'s part for the agent's command. While transcript
 * shipping is on, any `dosu knowledge sync` (another agent's hook, a `--flush`) ships every
 * agent's sessions, its own hooks or not, so the command, the user's one way to keep a session
 * out, stays; once nothing ships, it goes with the hooks. `incognito disable` removes it either
 * way. */
export function disableIncognitoWithHooks(id: string): void {
  if (!isShippingEnabled(loadSyncState())) getIncognitoAgent(id)?.disable();
}

/** What `hooks disable` says when it left the agent's command in place; empty otherwise. */
export function keptIncognitoNote(id: string): string {
  const command = getIncognitoAgent(id);
  if (!command?.isEnabled() || !isShippingEnabled(loadSyncState())) return "";
  return `Kept ${command.invocation()}: ${command.name()} sessions still ship with any 'dosu knowledge sync' while transcript shipping is on. 'dosu knowledge incognito disable ${id}' removes it.`;
}

/** The incognito commands installed on this machine, for the messages that tell the user how to
 * keep a session out: "/dosu-incognito (Claude Code, Pi) or $dosu-incognito (Codex)". Pi's comes
 * with its Dosu extension. Null when no agent has one. */
export function installedIncognitoCommands(): string | null {
  const agents = new Map<string, string[]>();
  const add = (invocation: string, name: string) =>
    agents.set(invocation, [...(agents.get(invocation) ?? []), name]);
  for (const agent of allIncognitoAgents()) {
    if (agent.isEnabled()) add(agent.invocation(), agent.name());
  }
  if (piHookAgent().isEnabled()) add(SLASH_COMMAND, "Pi");
  if (agents.size === 0) return null;
  return [...agents]
    .map(([invocation, names]) => `${invocation} (${names.join(", ")})`)
    .join(" or ");
}
