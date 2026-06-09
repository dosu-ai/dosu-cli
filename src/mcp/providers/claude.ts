import { join } from "node:path";
import type { Config } from "../../config/config";
import { installWorkflowHook, removeWorkflowHook } from "../config-helpers";
import { expandHome } from "../detect";
import { createJSONProvider } from "./base";

const CLAUDE_GLOBAL_PATH = "~/.claude.json";

export const ClaudeProvider = () => {
  const base = createJSONProvider({
    providerName: "Claude Code",
    providerID: "claude",
    local: true,
    priorityValue: 1,
    paths: ["~/.claude"],
    globalPath: CLAUDE_GLOBAL_PATH,
    topKey: "mcpServers",
    localConfigPath: (cwd) => join(cwd, ".mcp.json"),
  });

  return {
    ...base,
    install(cfg: Config, global: boolean): void {
      base.install(cfg, global);
      if (global) {
        installWorkflowHook(expandHome(CLAUDE_GLOBAL_PATH));
      }
    },
    remove(global: boolean): void {
      base.remove(global);
      if (global) {
        removeWorkflowHook(expandHome(CLAUDE_GLOBAL_PATH));
      }
    },
  };
};
