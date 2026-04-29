/**
 * Provider detection and utility functions.
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Checks if any of the given paths exist on the filesystem.
 */
export function isInstalled(paths: string[]): boolean {
  return paths.some((p) => existsSync(expandHome(p)));
}

/**
 * Expands ~ to the user's home directory.
 */
export function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  return join(homedir(), path.slice(1));
}

/**
 * Returns the platform-specific Application Support directory.
 *
 * v8 coverage of the switch arms varies by platform (macOS CI hits darwin,
 * Linux CI hits default). The arms are trivial dispatch — exclude from
 * coverage so the global threshold is stable across runners.
 */
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
