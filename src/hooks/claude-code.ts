/** Where Claude Code keeps its settings, and whether it is on this machine at all. */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expandHome, isInstalled } from "../mcp/detect";

/** Same override the rules and slash-command installers honor. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || expandHome("~/.claude");
}

/** Whether an executable named `bin` is in a PATH directory. */
export function isOnPath(bin: string, path: string = process.env.PATH ?? ""): boolean {
  return path.split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, bin)));
}

/** Claude Code is installed when its config directory exists or `claude` is on PATH. Claude Code
 * creates the directory on its first run, and a freshly provisioned machine (a throwaway VM) sets
 * up Dosu before that run: the hooks must already be there when it happens. */
export function claudeCodeInstalled(): boolean {
  return isInstalled([claudeConfigDir()]) || isOnPath("claude");
}
