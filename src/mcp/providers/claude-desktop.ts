import { join } from "node:path";
import type { Config } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpEndpoint,
  mcpHeaders,
  mcpRemoteServer,
  removeJSONServer,
} from "../config-helpers";
import { appSupportDir, findNpx, isInstalled, launcherPathEnv } from "../detect";
import type { SetupProvider } from "../providers";
import { proxyCommand, stdioServer } from "../proxy-entry";

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
    const url = mcpEndpoint(cfg);
    // Claude Desktop's chat surface launches only stdio servers from this
    // config file (and only renders MCP Apps from them); remote HTTP goes
    // through the Connectors UI, which cannot be automated. Run Dosu's own
    // proxy, or without a `dosu` on PATH proxy the remote endpoint through
    // `npx mcp-remote`, with an absolute npx path and an explicit PATH
    // because Claude Desktop spawns servers with the minimal launchd PATH.
    const proxy = proxyCommand("claude-desktop");
    if (proxy) {
      mcpHeaders(cfg.active_account?.target?.api_key);
      installJSONServer(configPath(), "mcpServers", stdioServer(proxy));
      return;
    }
    const npx = findNpx();
    const remote = mcpRemoteServer(url, cfg.active_account?.target?.api_key);
    installJSONServer(configPath(), "mcpServers", {
      command: npx,
      args: remote.args,
      env: { PATH: launcherPathEnv(npx), ...remote.env },
    });
  },

  remove(global: boolean): void {
    if (!global) throw new Error("Claude Desktop does not support local removal");
    removeJSONServer(configPath(), "mcpServers");
  },
});
