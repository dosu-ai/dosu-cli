import { join } from "node:path";
import type { SetupProvider } from "../providers";
import { appSupportDir, isInstalled } from "../detect";

export const ClaudeDesktopProvider = (): SetupProvider => ({
  name: () => "Claude Desktop",
  id: () => "claude-desktop",
  supportsLocal: () => false,
  priority: () => 2,
  detectPaths: () => [join(appSupportDir(), "Claude")],
  isInstalled: () => isInstalled([join(appSupportDir(), "Claude")]),
  globalConfigPath: () => join(appSupportDir(), "Claude", "claude_desktop_config.json"),
  isConfigured: () => false,
  install() {
    throw new Error("this tool only supports local (stdio) servers and cannot be configured for remote MCP");
  },
  remove() {
    throw new Error("this tool only supports local (stdio) servers and cannot be configured for remote MCP");
  },
});
