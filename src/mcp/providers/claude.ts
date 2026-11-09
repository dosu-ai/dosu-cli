import { join } from "node:path";
import { createJSONProvider } from "./base";

/** Claude Code keeps its user config, MCP servers included, in `.claude.json` inside
 * CLAUDE_CONFIG_DIR when that is set (an empty value counts as unset), else in ~/.claude.json. */
function claudeConfigDir(): string | null {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || null;
}

export const ClaudeProvider = () => {
  const configDir = claudeConfigDir();
  return createJSONProvider({
    providerName: "Claude Code",
    providerID: "claude",
    local: true,
    priorityValue: 1,
    paths: [configDir ?? "~/.claude"],
    globalPath: configDir ? join(configDir, ".claude.json") : "~/.claude.json",
    topKey: "mcpServers",
    // alwaysLoad keeps every Dosu tool out of tool-search deferral. Clients that predate the
    // key (checked: 2.1.120, 2.1.74) connect normally and ignore it.
    buildServer: ({ url, headers }) => ({ type: "http", url, headers, alwaysLoad: true }),
    localConfigPath: (cwd) => join(cwd, ".mcp.json"),
  });
};
