import { join } from "node:path";
import { claudeCodeInstalled } from "../../hooks/claude-code";
import { stdioServer } from "../proxy-entry";
import { createJSONProvider } from "./base";

export const ClaudeProvider = () => ({
  ...createJSONProvider({
    providerName: "Claude Code",
    providerID: "claude",
    local: true,
    priorityValue: 1,
    paths: ["~/.claude"],
    globalPath: "~/.claude.json",
    topKey: "mcpServers",
    // alwaysLoad keeps every Dosu tool out of tool-search deferral. Clients that predate the
    // key (checked: 2.1.120, 2.1.74) connect normally and ignore it. Changing this shape, or
    // removing the key, needs a new MCP_FORMAT_CHANGES entry to rewrite existing installs.
    buildStdioServer: (proxy) => ({ type: "stdio", ...stdioServer(proxy), alwaysLoad: true }),
    buildServer: ({ url, headers }) => ({ type: "http", url, headers, alwaysLoad: true }),
    localConfigPath: (cwd) => join(cwd, ".mcp.json"),
  }),
  // `claude` on PATH counts too: a fresh machine sets Dosu up before Claude Code's first run.
  isInstalled: claudeCodeInstalled,
});
