/** Hook config file formats (grouped Claude Code/Codex shape and Cursor shape). Unlike the MCP
 * helpers, an existing file that does not parse ABORTS: rewriting would destroy user settings. */

import { existsSync, readFileSync } from "node:fs";
import {
  getBackendURL,
  getSupabaseAnonKey,
  getSupabaseURL,
  getWebAppURL,
} from "../config/constants";
import { writeSecureFile } from "../mcp/config-helpers";
import { selfInvocation } from "../sync/detach";

/** Plain PATH-resolved `dosu` rather than an absolute path: the command text must stay stable
 * because Codex pins a trust hash on it. `hooks enable` warns when `dosu` is not on PATH. */
export const HOOK_COMMAND = "dosu knowledge sync --quiet --detach";

/** `*_OVERRIDE` vars baked into dev hook commands. Hooks fire from cwds where this repo's
 * `.env.development` is not loaded, so each URL is resolved now and inlined or runs fail. */
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

/** The command `hooks enable` writes. Dev installs pin the working copy by absolute path with
 * env inline so hook-triggered runs exercise the code under development, not the PATH `dosu`. */
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

/** Matches our entry even if flags evolve; the second pattern covers dev-mode commands whose
 * absolute runtime/script path need not contain the word `dosu`. */
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
