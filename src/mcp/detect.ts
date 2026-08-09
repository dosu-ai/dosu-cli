/**
 * Provider detection and utility functions.
 */

import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";

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

/**
 * Locates `npx` by absolute path on the current process PATH. Setup uses this
 * as an install-time availability check; the private proxy runtime uses the
 * absolute result to give its child a PATH that also resolves Node.js.
 * Project files deliberately keep the portable command name `npx`, so GUI
 * clients with a restricted PATH may still need to be restarted from a shell.
 */
export function findNpx(): string {
  /* v8 ignore next -- platform dispatch, win32 arm not exercised on POSIX CI */
  const bin = platform() === "win32" ? "npx.cmd" : "npx";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("npx not found on PATH — Node.js 22+ is required for this MCP configuration.");
}

/**
 * PATH value for a spawned stdio entry: npx's own directory first (node
 * lives beside npx in every common layout) plus the system dirs. The Unix
 * fallbacks are harmless on Windows.
 */
export function npxPathEnv(npx: string): string {
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(npx) || npx.startsWith("\\\\");
  const parent = windowsStyle ? win32.dirname(npx) : dirname(npx);
  const separator = windowsStyle ? ";" : delimiter;
  const inherited = process.env.PATH?.split(separator).filter(Boolean) ?? [];
  const fallback = windowsStyle ? [] : ["/usr/bin", "/bin"];
  return [...new Set([parent, ...inherited, ...fallback])].join(separator);
}
