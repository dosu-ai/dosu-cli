import { mcpHeaders, mcpURL } from "../config-helpers";
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
    buildServer: (cfg) => ({
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      serverUrl: mcpURL(cfg.deployment_id!),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.api_key!),
    }),
  });
