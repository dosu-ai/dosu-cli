import { piAgentDir, piHookAgent } from "../../hooks/pi";
import type { SetupProvider } from "../providers";

function globalOnly(): never {
  throw new Error("Pi's Dosu extension installs only globally");
}

/** Pi in `dosu setup` and `dosu mcp`: its Dosu "MCP" is the Dosu pi extension, which registers
 * search_memory and get_memory_evidence and also carries the session-end trigger, prompt-time
 * memory and /dosu-incognito, so installing it here and enabling pi's hook are the same act. */
export const PiProvider = (): SetupProvider => {
  const extension = piHookAgent();
  return {
    name: () => "Pi",
    id: () => "pi",
    supportsLocal: () => false,
    priority: () => 18,
    detectPaths: () => [piAgentDir()],
    isInstalled: () => extension.isInstalled(),
    isConfigured: () => extension.isEnabled(),
    globalConfigPath: () => extension.configPath(),
    install: (_cfg, global) => (global ? extension.enable() : globalOnly()),
    remove: (global) => (global ? extension.disable() : globalOnly()),
  };
};
