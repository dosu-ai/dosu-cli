import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SetupProvider } from "../providers";
import type { Config } from "../../config/config";
import { expandHome, isInstalled } from "../detect";
import {
  mcpURL,
  mcpHeaders,
  isJSONKeyConfigured,
  installJSONServer,
  removeJSONServer,
} from "../config-helpers";

function resolveGlobalConfigPath(): string {
  const jsonPath = expandHome("~/.mcporter/mcporter.json");
  if (existsSync(jsonPath)) return jsonPath;
  const jsoncPath = expandHome("~/.mcporter/mcporter.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

export const MCPorterProvider = (): SetupProvider => ({
  name: () => "MCPorter",
  id: () => "mcporter",
  supportsLocal: () => true,
  priority: () => 16,
  detectPaths: () => ["~/.mcporter"],
  isInstalled: () => isInstalled(["~/.mcporter"]),
  globalConfigPath: () => resolveGlobalConfigPath(),
  isConfigured: () => isJSONKeyConfigured(resolveGlobalConfigPath(), "mcpServers"),

  install(cfg: Config, global: boolean): void {
    if (!cfg.deployment_id) throw new Error("deployment ID is required");
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(process.cwd(), "config", "mcporter.json");
    const server = {
      type: "http",
      url: mcpURL(cfg.deployment_id),
      headers: mcpHeaders(cfg.api_key!),
    };
    installJSONServer(configPath, "mcpServers", server);
  },

  remove(global: boolean): void {
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(process.cwd(), "config", "mcporter.json");
    removeJSONServer(configPath, "mcpServers");
  },
});
