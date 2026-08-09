import { join } from "node:path";
import { mcpHeaders, mcpURL } from "../config-helpers";
import { createJSONProvider } from "./base";

export const AntigravityProvider = () =>
  createJSONProvider({
    providerName: "Antigravity",
    providerID: "antigravity",
    local: true,
    priorityValue: 15,
    paths: ["~/.gemini"],
    globalPath: "~/.gemini/config/mcp_config.json",
    configuredGlobalPaths: ["~/.gemini/antigravity/mcp_config.json"],
    topKey: "mcpServers",
    buildServer: (cfg) => ({
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      serverUrl: mcpURL(cfg.active_account!.target!.deployment_id!),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
      headers: mcpHeaders(cfg.active_account!.target!.api_key!),
    }),
    buildProjectServer: (command) => ({ command: command.command, args: command.args }),
    localConfigPath: (cwd) => join(cwd, ".agents", "mcp_config.json"),
  });
