/** Provider detection and utility functions. */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Checks if any of the given paths exist on the filesystem. */
export function isInstalled(paths: string[]): boolean {
  return paths.some((p) => existsSync(expandHome(p)));
}

/** Whether an executable named `bin` is in a PATH directory: an agent installed on a machine
 * where it has never run has no config dir yet. */
export function isOnPath(bin: string, path: string = process.env.PATH ?? ""): boolean {
  return path.split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, bin)));
}

/** Expands ~ to the user's home directory. */
export function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  return join(homedir(), path.slice(1));
}

/** Platform-specific Application Support dir; coverage-excluded because each CI runner
 * only exercises one switch arm. */
/* v8 ignore start */
export function appSupportDir(): string {
  switch (platform()) {
    case "darwin": {
      return join(homedir(), "Library", "Application Support");
    }
    case "win32": {
      return process.env.APPDATA ?? "";
    }
    default: {
      // linux
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return xdg;
      return join(homedir(), ".config");
    }
  }
}
/* v8 ignore stop */

/** Every absolute path `name` has on the shell PATH, in PATH order. */
export function allOnPath(name: string): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, name))
    .filter((candidate) => existsSync(candidate));
}

/** The absolute path of `name` on the shell PATH, or null. */
export function findOnPath(name: string): string | null {
  return allOnPath(name)[0] ?? null;
}

/** Locates `npx` by absolute path on the shell PATH. GUI hosts spawn stdio servers with the
 * minimal launchd PATH (no Homebrew/nvm), so config entries must reference npx absolutely. */
export function findNpx(): string {
  /* v8 ignore next -- platform dispatch, win32 arm not exercised on POSIX CI */
  const npx = findOnPath(platform() === "win32" ? "npx.cmd" : "npx");
  if (npx) return npx;
  throw new Error(
    "npx not found on PATH. Node.js is required (the MCP entry runs `npx mcp-remote`).",
  );
}

/** PATH for a spawned stdio entry: the launcher's own dir first (a Node launcher's `node` lives
 * beside it), the dir of a program it runs when given (`git`, wherever the installing shell found
 * it), plus the system dirs. */
export function launcherPathEnv(launcher: string, program?: string | null): string {
  const dirs = [dirname(launcher), ...(program ? [dirname(program)] : []), "/usr/bin", "/bin"];
  return [...new Set(dirs)].join(delimiter);
}
