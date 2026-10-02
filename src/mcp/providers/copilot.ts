import { join } from "node:path";
import type { Config } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpEndpoint,
  mcpHeaders,
  readJSONServer,
  removeJSONServer,
} from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";
import { ANY, hasShape, shapeEndpoint } from "../shape";

function globalServer(url: string, apiKey: string | undefined) {
  return { type: "http", url, tools: ["*"], headers: mcpHeaders(apiKey) };
}

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
  isCurrent: (cfg) =>
    hasShape(globalServer(shapeEndpoint(cfg), ANY), readJSONServer(globalPath(), "mcpServers")),

  install(cfg: Config, global: boolean): void {
    const url = mcpEndpoint(cfg);

    if (global) {
      installJSONServer(
        globalPath(),
        "mcpServers",
        globalServer(url, cfg.active_account?.target?.api_key),
      );
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
