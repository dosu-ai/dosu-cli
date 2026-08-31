/**
 * Settings-file conflict detection for the mining-agent subprocess.
 *
 * `buildMinerEnv` strips the environment and `CLAUDE_CONFIG_DIR` isolates
 * per-user config, but Claude Code also reads *managed settings* from a
 * system path outside the config dir. A managed `apiKeyHelper` or
 * `env.ANTHROPIC_BASE_URL` would silently reroute the miner's auth or
 * traffic no matter what the spawn env says — so when one is present the
 * miner must refuse to run (fail closed), not hope for the best.
 */

import { existsSync, readFileSync } from "node:fs";

/** Managed settings locations, per Claude Code docs. */
export function managedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "darwin":
      return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
    case "win32":
      return ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
    default:
      return ["/etc/claude-code/managed-settings.json"];
  }
}

/** Settings keys that override auth or routing for every spawned binary. */
const CONFLICTING_KEYS = [
  "apiKeyHelper",
  "forceLoginMethod",
  "awsAuthRefresh",
  "awsCredentialExport",
];

const CONFLICTING_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "AWS_"];

export interface MinerConflict {
  file: string;
  /** The offending keys, e.g. `["apiKeyHelper", "env.ANTHROPIC_BASE_URL"]`. */
  keys: string[];
}

function conflictingKeysIn(settings: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of CONFLICTING_KEYS) {
    if (key in settings) keys.push(key);
  }
  const env = settings.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    for (const name of Object.keys(env)) {
      if (CONFLICTING_ENV_PREFIXES.some((p) => name.startsWith(p))) keys.push(`env.${name}`);
    }
  }
  return keys;
}

/**
 * Scan managed settings files for keys that would hijack a miner run.
 * Returns one entry per conflicting file; an empty array means safe to
 * spawn. An unreadable or unparsable managed file is itself a conflict —
 * we cannot prove it is harmless.
 */
export function detectSettingsConflicts(paths: string[] = managedSettingsPaths()): MinerConflict[] {
  const conflicts: MinerConflict[] = [];
  for (const file of paths) {
    if (!existsSync(file)) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      conflicts.push({ file, keys: ["<unreadable or invalid JSON>"] });
      continue;
    }
    if (typeof settings !== "object" || settings === null) continue;
    const keys = conflictingKeysIn(settings as Record<string, unknown>);
    if (keys.length > 0) conflicts.push({ file, keys });
  }
  return conflicts;
}
