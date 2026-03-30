import { createJSONProvider } from "./base";
import { mcpURL, mcpHeaders } from "../config-helpers";

export const AntigravityProvider = () =>
  createJSONProvider({
    providerName: "Antigravity",
    providerID: "antigravity",
    local: false,
    priorityValue: 15,
    paths: ["~/.gemini"],
    globalPath: "~/.gemini/antigravity/mcp_config.json",
    topKey: "mcpServers",
    buildServer: (cfg) => ({
      serverUrl: mcpURL(cfg.deployment_id!),
      headers: mcpHeaders(cfg.api_key!),
    }),
  });
