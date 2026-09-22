/** `/dosu-incognito` slash-command installation per agent. The command file is the whole
 * feature on the agent side: invoking it records INCOGNITO_MARKER in the session transcript,
 * which `dosu knowledge sync` and the status line read. Targets mirror `src/rules/installer.ts`. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isInstalled } from "../mcp/detect";
import { INCOGNITO_COMMAND_NAME, INCOGNITO_MARKER } from "../sync/incognito";

export type IncognitoAction = "created" | "updated" | "unchanged" | "removed" | "not_found";

export interface IncognitoAgent {
  id(): string;
  name(): string;
  /** The agent itself is present on this machine. */
  isInstalled(): boolean;
  /** Where the slash-command file lives. */
  commandPath(): string;
  /** The command file exists and carries the current marker. */
  isEnabled(): boolean;
  enable(): IncognitoAction;
  disable(): IncognitoAction;
}

/** The prompt the slash command expands to. The marker line is what the sync filter and the
 * status line look for; the rest tells the model to leave Dosu alone for the session. */
export const INCOGNITO_COMMAND_BODY = `Dosu incognito marker: ${INCOGNITO_MARKER}

Dosu is off for the rest of this session. Do not call any Dosu MCP tools (read_knowledge, write_knowledge, review_knowledge, finalize_session_knowledge), even where project rules ask you to. This session will not be studied for shared knowledge.

Acknowledge in one line: "Dosu incognito: this session will not be studied."
`;

const DESCRIPTION = "Turn Dosu off for this session: no knowledge tools, and it is never studied";

/** Claude Code and Codex read a `description` from YAML frontmatter; Cursor takes plain markdown. */
function withFrontmatter(body: string): string {
  return `---\ndescription: ${DESCRIPTION}\n---\n\n${body}`;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

const FILE_NAME = `${INCOGNITO_COMMAND_NAME}.md`;

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
    commandPath,
    isEnabled: () => {
      const path = commandPath();
      if (!existsSync(path)) return false;
      try {
        return readFileSync(path, "utf-8").includes(INCOGNITO_MARKER);
      } catch {
        return false;
      }
    },
    enable: () => {
      const path = commandPath();
      if (existsSync(path)) {
        if (readFileSync(path, "utf-8") === content) return "unchanged";
        writeFileSync(path, content, "utf-8");
        return "updated";
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf-8");
      return "created";
    },
    disable: () => {
      const path = commandPath();
      if (!existsSync(path)) return "not_found";
      unlinkSync(path);
      return "removed";
    },
  };
}

export function allIncognitoAgents(): IncognitoAgent[] {
  return [
    fileAgent({
      id: "claude",
      name: "Claude Code",
      detectPath: claudeConfigDir,
      commandPath: () => join(claudeConfigDir(), "commands", FILE_NAME),
      content: withFrontmatter(INCOGNITO_COMMAND_BODY),
    }),
    fileAgent({
      id: "cursor",
      name: "Cursor",
      detectPath: () => join(homedir(), ".cursor"),
      commandPath: () => join(homedir(), ".cursor", "commands", FILE_NAME),
      content: INCOGNITO_COMMAND_BODY,
    }),
    fileAgent({
      id: "codex",
      name: "Codex",
      detectPath: codexHome,
      commandPath: () => join(codexHome(), "prompts", FILE_NAME),
      content: withFrontmatter(INCOGNITO_COMMAND_BODY),
    }),
  ];
}

export function getIncognitoAgent(id: string): IncognitoAgent | undefined {
  return allIncognitoAgents().find((agent) => agent.id() === id);
}
