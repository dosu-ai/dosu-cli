import { join } from "node:path";
import { createJSONProvider } from "./base";

export const ClaudeProvider = () =>
  createJSONProvider({
    providerName: "Claude Code",
    providerID: "claude",
    local: true,
    priorityValue: 1,
    paths: ["~/.claude"],
    globalPath: "~/.claude.json",
    topKey: "mcpServers",
    localConfigPath: (cwd) => join(cwd, ".mcp.json"),
  });
