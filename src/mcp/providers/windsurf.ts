import { homedir } from "node:os";
import { join } from "node:path";
import { createJSONProvider } from "./base";

export const WindsurfProvider = () =>
  createJSONProvider({
    providerName: "Windsurf",
    providerID: "windsurf",
    local: false,
    priorityValue: 9,
    paths: [join(homedir(), ".codeium", "windsurf")],
    globalPath: join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
    topKey: "mcpServers",
  });
