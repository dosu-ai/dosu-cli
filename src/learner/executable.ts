/** Locate a Claude Code executable for the Agent SDK: bundled installs lack the SDK's native
 * binary, so we fall back to a system-wide Claude via `pathToClaudeCodeExecutable`. */

import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Executable names to probe, per platform. */
export function binaryNames(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
}

/** True when the SDK's version-matched native binary is resolvable from this module. */
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

/** Find a system-wide Claude Code on PATH, then home-relative dirs (agent hooks often run with
 * a minimal PATH that misses `~/.local/bin`). */
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

/** Path to pass as `pathToClaudeCodeExecutable`, or undefined to let the SDK resolve its own
 * version-matched binary (preferred when available). */
export function resolveClaudeExecutable(
  options: ResolveExecutableOptions = {},
): string | undefined {
  const hasSdkBinary = options.sdkBinaryExists ?? sdkNativeBinaryExists;
  if (hasSdkBinary()) return undefined;
  return findSystemClaude(options.env, options.homeDir);
}
