import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import {
  installJSONServer,
  isJSONKeyConfigured,
  mcpBaseURL,
  mcpRemoteArgs,
  mcpURL,
  removeJSONServer,
} from "../config-helpers";
import { appSupportDir, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";

function configPath(): string {
  return join(appSupportDir(), "Claude", "claude_desktop_config.json");
}

/**
 * Claude Desktop launches config-file MCP servers with a minimal environment
 * whose PATH lacks Homebrew/nvm, so `npx` must be referenced by absolute path
 * and the entry needs a PATH under which npx's `#!/usr/bin/env node` shebang
 * resolves. Resolved at install time from the user's shell PATH.
 */
function findNpx(): string {
  /* v8 ignore next -- platform dispatch, win32 arm not exercised on POSIX CI */
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "npx not found on PATH — Node.js is required to configure Claude Desktop (the entry runs `npx mcp-remote`).",
  );
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
    // Claude Desktop's chat surface only launches stdio servers (and only
    // renders MCP Apps from them), so proxy the remote HTTP endpoint through
    // `npx mcp-remote`.
    const npx = findNpx();
    installJSONServer(configPath(), "mcpServers", {
      command: npx,
      args: mcpRemoteArgs(url, cfg.active_account?.target?.api_key),
      env: { PATH: [dirname(npx), "/usr/bin", "/bin"].join(delimiter) },
    });
  },

  remove(global: boolean): void {
    if (!global) throw new Error("Claude Desktop does not support local removal");
    removeJSONServer(configPath(), "mcpServers");
  },
});
