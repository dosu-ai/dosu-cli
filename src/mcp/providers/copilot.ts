import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpBaseURL,
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

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
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
    const url = mcpEndpoint(cfg);

    if (global) {
      const server = {
        type: "http",
        url,
        tools: ["*"],
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
        headers: mcpHeaders(cfg.active_account!.target!.api_key!),
      };
      installJSONServer(globalPath(), "mcpServers", server);
    } else {
      const configPath = join(process.cwd(), ".vscode", "mcp.json");
      const server = {
        type: "http",
        url,
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
        headers: mcpHeaders(cfg.active_account!.target!.api_key!),
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
