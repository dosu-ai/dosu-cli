/**
 * Locate a Claude Code executable for the Agent SDK.
 *
 * The SDK resolves its own version-matched native binary from the optional
 * platform package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), which
 * only works when running from a source checkout with node_modules present.
 * Compiled binaries (`bun build --compile`) and the npm bundle inline the
 * SDK's JS without the ~230 MB native binary, so the SDK's own lookup throws
 * before the miner starts. For those installs we fall back to a system-wide
 * Claude Code and pass it via `pathToClaudeCodeExecutable`, which makes the
 * SDK skip its own resolution entirely.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Executable names to probe, per platform. */
export function binaryNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
}

/**
 * True when the SDK's own platform package (and the binary inside it) is
 * resolvable from this module — i.e. we are running from a checkout whose
 * node_modules carries the version-matched native binary.
 */
export function sdkNativeBinaryExists(): boolean {
  try {
    const requireRuntime = createRequire(import.meta.url);
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const pkgDir = dirname(requireRuntime.resolve(`${pkg}/package.json`));
    return binaryNames().some((name) => existsSync(join(pkgDir, name)));
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a system-wide Claude Code install: every PATH entry, then well-known
 * home-relative locations. The home-relative checks matter because agent
 * hooks often run with a minimal PATH that misses `~/.local/bin`.
 */
export function findSystemClaude(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string | undefined {
  const names = binaryNames();
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  dirs.push(join(homeDir, ".local", "bin"), join(homeDir, ".claude", "local"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Injectable for tests; defaults to probing the SDK's platform package. */
  sdkBinaryExists?: () => boolean;
}

/**
 * Path to pass as `pathToClaudeCodeExecutable`, or undefined to let the SDK
 * resolve its own version-matched binary (preferred when available).
 */
export function resolveClaudeExecutable(
  options: ResolveExecutableOptions = {},
): string | undefined {
  const hasSdkBinary = options.sdkBinaryExists ?? sdkNativeBinaryExists;
  if (hasSdkBinary()) return undefined;
  return findSystemClaude(options.env, options.homeDir);
}
