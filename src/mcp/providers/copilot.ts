import { join } from "node:path";
import type { Config } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";

function globalPath(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "mcp-config.json");
  }
  return expandHome("~/.copilot/mcp-config.json");
}

export const CopilotProvider = (): SetupProvider => ({
  name: () => "GitHub Copilot CLI",
  id: () => "copilot",
  supportsLocal: () => true,
  priority: () => 13,
  detectPaths: () => [expandHome("~/.copilot")],
  isInstalled: () => isInstalled([expandHome("~/.copilot")]),
  globalConfigPath: () => globalPath(),
  isConfigured: () => isJSONKeyConfigured(globalPath(), "mcpServers"),

  install(cfg: Config, global: boolean): void {
    if (!cfg.deployment_id) throw new Error("deployment ID is required");
    const url = mcpURL(cfg.deployment_id);

    if (global) {
      const server = {
        type: "http",
        url,
        tools: ["*"],
        headers: mcpHeaders(cfg.api_key ?? ""),
      };
      installJSONServer(globalPath(), "mcpServers", server);
    } else {
      const configPath = join(process.cwd(), ".vscode", "mcp.json");
      const server = {
        type: "http",
        url,
        headers: mcpHeaders(cfg.api_key ?? ""),
      };
      installJSONServer(configPath, "servers", server);
    }
  },

  remove(global: boolean): void {
    if (global) {
      removeJSONServer(globalPath(), "mcpServers");
    } else {
      const configPath = join(process.cwd(), ".vscode", "mcp.json");
      removeJSONServer(configPath, "servers");
    }
  },
});
