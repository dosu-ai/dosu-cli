import { createJSONProvider } from "./base";

export const AntigravityProvider = () =>
  createJSONProvider({
    providerName: "Antigravity",
    providerID: "antigravity",
    local: false,
    priorityValue: 15,
    paths: ["~/.gemini"],
    globalPath: "~/.gemini/antigravity/mcp_config.json",
    topKey: "mcpServers",
    buildServer: ({ url, headers }) => ({
      serverUrl: url,
      headers,
    }),
  });
