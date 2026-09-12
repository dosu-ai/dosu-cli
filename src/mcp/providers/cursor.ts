import { join } from "node:path";
import { createJSONProvider } from "./base";

export const CursorProvider = () =>
  createJSONProvider({
    providerName: "Cursor",
    providerID: "cursor",
    local: true,
    priorityValue: 5,
    paths: ["~/.cursor"],
    globalPath: "~/.cursor/mcp.json",
    topKey: "mcpServers",
    buildServer: ({ url, headers }) => ({
      url,
      headers,
    }),
    localConfigPath: (cwd) => join(cwd, ".cursor", "mcp.json"),
  });
