import { existsSync } from "node:fs";
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
import { ANY, entryHasShape, shapeEndpoint } from "../shape";

function server(url: string, apiKey: string | undefined) {
  return { type: "http", url, headers: mcpHeaders(apiKey) };
}

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
  isCurrent: (cfg) =>
    entryHasShape(
      server(shapeEndpoint(cfg), ANY),
      readJSONServer(resolveGlobalConfigPath(), "mcpServers"),
    ),

  install(cfg: Config, global: boolean): void {
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(process.cwd(), "config", "mcporter.json");
    installJSONServer(
      configPath,
      "mcpServers",
      server(mcpEndpoint(cfg), cfg.active_account?.target?.api_key),
    );
  },

  remove(global: boolean): void {
    const configPath = global
      ? resolveGlobalConfigPath()
      : join(process.cwd(), "config", "mcporter.json");
    removeJSONServer(configPath, "mcpServers");
  },
});
