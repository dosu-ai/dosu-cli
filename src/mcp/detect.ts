/** Provider detection and utility functions. */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Checks if any of the given paths exist on the filesystem. */
export function isInstalled(paths: string[]): boolean {
  return paths.some((p) => existsSync(expandHome(p)));
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

/** The absolute path of `name` on the shell PATH, or null. */
export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
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
 * beside it) plus the system dirs, where `git` is. */
export function launcherPathEnv(launcher: string): string {
  return [dirname(launcher), "/usr/bin", "/bin"].join(delimiter);
}
