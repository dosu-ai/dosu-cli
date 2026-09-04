import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpBaseURL,
  mcpRemoteServer,
  mcpURL,
  removeJSONServer,
} from "../config-helpers";
import { appSupportDir, findNpx, isInstalled, npxPathEnv } from "../detect";
import type { SetupProvider } from "../providers";

function configPath(): string {
  return join(appSupportDir(), "Claude", "claude_desktop_config.json");
}

export const ClaudeDesktopProvider = (): SetupProvider => ({
  name: () => "Claude Desktop",
  id: () => "claude-desktop",
  supportsLocal: () => false,
  priority: () => 2,
  detectPaths: () => [join(appSupportDir(), "Claude")],
  isInstalled: () => isInstalled([join(appSupportDir(), "Claude")]),
  globalConfigPath: () => configPath(),
  isConfigured: () => isJSONKeyConfigured(configPath(), "mcpServers"),

  install(cfg: Config, global: boolean): void {
    if (!global) throw new Error("Claude Desktop does not support local installation");
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    const url =
      cfg.mode === MODE_OSS
        ? mcpBaseURL()
        : // biome-ignore lint/style/noNonNullAssertion: guaranteed by the guard above
          mcpURL(cfg.active_account!.target!.deployment_id!);
    // Claude Desktop only launches stdio servers from this file, so proxy through `npx
    // mcp-remote` with absolute npx and explicit PATH (it spawns with the minimal launchd PATH).
    const npx = findNpx();
    const remote = mcpRemoteServer(url, cfg.active_account?.target?.api_key);
    installJSONServer(configPath(), "mcpServers", {
      command: npx,
      args: remote.args,
      env: { PATH: npxPathEnv(npx), ...remote.env },
    });
  },

  remove(global: boolean): void {
    if (!global) throw new Error("Claude Desktop does not support local removal");
    removeJSONServer(configPath(), "mcpServers");
  },
});
