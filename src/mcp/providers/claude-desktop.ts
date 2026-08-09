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
  projectConfigPath: () => null,
  isProjectConfigured: () => false,

  install(cfg: Config, global: boolean) {
    if (!global) throw new Error("Claude Desktop does not support project installation");
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    const url =
      cfg.mode === MODE_OSS
        ? mcpBaseURL()
        : // biome-ignore lint/style/noNonNullAssertion: guaranteed by the guard above
          mcpURL(cfg.active_account!.target!.deployment_id!);
    // Claude Desktop's chat surface launches only stdio servers from this
    // config file (and only renders MCP Apps from them); remote HTTP goes
    // through the Connectors UI, which cannot be automated. Proxy the remote
    // endpoint through `npx mcp-remote`, with an absolute npx path and an
    // explicit PATH because Claude Desktop spawns servers with the minimal
    // launchd PATH. Revert to a plain remote-HTTP entry if
    // claude_desktop_config.json ever accepts one.
    const npx = findNpx();
    const remote = mcpRemoteServer(url, cfg.active_account?.target?.api_key);
    installJSONServer(configPath(), "mcpServers", {
      command: npx,
      args: remote.args,
      env: { PATH: npxPathEnv(npx), ...remote.env },
    });
    return undefined;
  },

  remove(global: boolean) {
    if (!global) throw new Error("Claude Desktop does not support project removal");
    removeJSONServer(configPath(), "mcpServers");
    return undefined;
  },
});
