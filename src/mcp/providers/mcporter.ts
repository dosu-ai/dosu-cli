import { existsSync } from "node:fs";
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

function resolveGlobalConfigPath(): string {
  const jsonPath = expandHome("~/.mcporter/mcporter.json");
  if (existsSync(jsonPath)) return jsonPath;
  const jsoncPath = expandHome("~/.mcporter/mcporter.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  return jsonPath;
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.deployment_id);
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
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(process.cwd(), "config", "mcporter.json");
    const server = {
      type: "http",
      url: mcpEndpoint(cfg),
      // biome-ignore lint/style/noNonNullAssertion: guaranteed by install() guard
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
