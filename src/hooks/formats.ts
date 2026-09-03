/**
 * Hook config file formats.
 *
 * Two shapes cover the v1 agents:
 * - Grouped (Claude Code `settings.json`, Codex `hooks.json`):
 *   `hooks.<Event>` is an array of groups, each `{ matcher?, hooks: [{type:
 *   "command", command}] }`.
 * - Cursor (`~/.cursor/hooks.json`): `{ version: 1, hooks: { <event>:
 *   [{command}] } }`.
 *
 * Discipline mirrors the MCP entries: merge non-destructively into existing
 * arrays, identify our own entries by command, uninstall cleanly. One
 * deliberate difference from the MCP helpers: these files (especially Claude's
 * settings.json) carry unrelated user settings, so an existing file that does
 * not parse ABORTS the operation instead of being treated as empty — silently
 * rewriting it would destroy the user's settings.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  getBackendURL,
  getSupabaseAnonKey,
  getSupabaseURL,
  getWebAppURL,
} from "../config/constants";
import { writeSecureFile } from "../mcp/config-helpers";
import { selfInvocation } from "../sync/detach";

/**
 * What production hooks run. Plain `dosu` (PATH-resolved) rather than an
 * absolute path: hook commands run through a shell, absolute install paths
 * churn with version/node switches, and Codex pins a trust hash on the exact
 * command text — so the string must be stable. `hooks enable` warns when
 * `dosu` is not on PATH.
 */
export const HOOK_COMMAND = "dosu knowledge sync --quiet --detach";

/**
 * `*_OVERRIDE` env vars baked into dev hook commands, each resolved to the
 * URL the enabling process is actually using. Hooks fire from arbitrary cwds
 * where Bun does not load this repo's `.env.development`, so a dev hook that
 * doesn't carry its URLs runs against empty ones — the miner's gateway URL
 * degenerates to the relative path `/v1/llm-gateway` and every run fails
 * with "Invalid URL". Resolving through the constants getters (not just
 * echoing already-set `*_OVERRIDE` vars) covers the common dev case where
 * the URLs came from `.env.development` under their build-time names.
 * The LLM gateway URL is not baked: it derives from the backend URL at
 * runtime, so inlining the backend override is enough — unless the developer
 * explicitly set `DOSU_LLM_GATEWAY_URL_OVERRIDE`, which is passed through.
 */
const DEV_HOOK_ENV: ReadonlyArray<{ name: string; resolve: () => string }> = [
  { name: "DOSU_WEB_APP_URL_OVERRIDE", resolve: getWebAppURL },
  { name: "DOSU_BACKEND_URL_OVERRIDE", resolve: getBackendURL },
  {
    name: "DOSU_LLM_GATEWAY_URL_OVERRIDE",
    resolve: () => process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE ?? "",
  },
  { name: "SUPABASE_URL_OVERRIDE", resolve: getSupabaseURL },
  { name: "SUPABASE_ANON_KEY_OVERRIDE", resolve: getSupabaseAnonKey },
];

/**
 * The command `hooks enable` writes. Dev installs (`DOSU_DEV=true`) pin the
 * current working copy by absolute path with the dev env inline, so
 * hook-triggered runs exercise the code under development and write to the
 * dev config dir — plain `dosu` would resolve to whatever published CLI is
 * on PATH, which may not even have this subcommand yet.
 */
export function hookCommand(): string {
  if (process.env.DOSU_DEV !== "true") return HOOK_COMMAND;
  const { command, baseArgs } = selfInvocation();
  const quoted = [command, ...baseArgs].map((part) => `'${part}'`).join(" ");
  const env = ["DOSU_DEV=true"];
  for (const { name, resolve } of DEV_HOOK_ENV) {
    const value = resolve();
    if (value) env.push(`${name}='${value}'`);
  }
  return `${env.join(" ")} ${quoted} knowledge sync --quiet --detach`;
}

/**
 * Matches our entry even if flags evolve across CLI versions. The second
 * pattern covers dev-mode commands, where the invocation is an absolute
 * runtime/script path that need not contain the word `dosu`.
 */
export function isDosuHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (command.includes("dosu knowledge sync") || command.includes("knowledge sync --quiet"))
  );
}

export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConfigError";
  }
}

// biome-ignore lint/suspicious/noExplicitAny: hook config files are arbitrary JSON
type JsonConfig = Record<string, any>;

/** Missing or empty file → `{}`; existing but unparseable → error, never clobber. */
export function readHookConfig(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  const data = readFileSync(path, "utf-8").trim();
  if (!data) return {};
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw new HookConfigError(`${path} exists but is not valid JSON; fix or remove it, then retry`);
  }
}

export function writeHookConfig(path: string, config: JsonConfig): void {
  writeSecureFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

// --- Grouped format (Claude Code, Codex) ---

interface GroupedHookEntry {
  type?: unknown;
  command?: unknown;
}

interface GroupedHookGroup {
  matcher?: unknown;
  hooks?: GroupedHookEntry[];
}

function groupedEventArray(config: JsonConfig, event: string): GroupedHookGroup[] {
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const groups = hooks[event];
  return Array.isArray(groups) ? groups : [];
}

export function hasGroupedHook(config: JsonConfig, event: string): boolean {
  return groupedEventArray(config, event).some(
    (group) =>
      Array.isArray(group?.hooks) && group.hooks.some((h) => isDosuHookCommand(h?.command)),
  );
}

export function addGroupedHook(config: JsonConfig, event: string): JsonConfig {
  const desired = hookCommand();

  let present = false;
  for (const group of groupedEventArray(config, event)) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const hook of group.hooks) {
      if (!isDosuHookCommand(hook?.command)) continue;
      present = true;
      hook.command = desired;
    }
  }
  if (present) return config;
  if (typeof config.hooks !== "object" || config.hooks === null) config.hooks = {};
  if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
  config.hooks[event].push({ hooks: [{ type: "command", command: desired }] });
  return config;
}

export function removeGroupedHook(config: JsonConfig, event: string): JsonConfig {
  const groups = groupedEventArray(config, event);
  if (groups.length === 0) return config;
  const kept = groups
    .map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => !isDosuHookCommand(h?.command));
      return { ...group, hooks };
    })
    .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
  if (kept.length > 0) {
    config.hooks[event] = kept;
  } else {
    delete config.hooks[event];
  }
  return config;
}

// --- Cursor format ---

interface CursorHookEntry {
  command?: unknown;
}

function cursorEventArray(config: JsonConfig, event: string): CursorHookEntry[] {
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const entries = hooks[event];
  return Array.isArray(entries) ? entries : [];
}

export function hasCursorHook(config: JsonConfig, event: string): boolean {
  return cursorEventArray(config, event).some((entry) => isDosuHookCommand(entry?.command));
}

export function addCursorHook(config: JsonConfig, event: string): JsonConfig {
  const desired = hookCommand();
  // Same stale-command refresh as addGroupedHook.
  let present = false;
  for (const entry of cursorEventArray(config, event)) {
    if (!isDosuHookCommand(entry?.command)) continue;
    present = true;
    entry.command = desired;
  }
  if (present) return config;
  if (config.version === undefined) config.version = 1;
  if (typeof config.hooks !== "object" || config.hooks === null) config.hooks = {};
  if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
  config.hooks[event].push({ command: desired });
  return config;
}

export function removeCursorHook(config: JsonConfig, event: string): JsonConfig {
  const entries = cursorEventArray(config, event);
  if (entries.length === 0) return config;
  const kept = entries.filter((entry) => !isDosuHookCommand(entry?.command));
  if (kept.length > 0) {
    config.hooks[event] = kept;
  } else {
    delete config.hooks[event];
  }
  return config;
}
