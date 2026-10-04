/** Hook config file formats (grouped Claude Code/Codex shape and Cursor shape). Unlike the MCP
 * helpers, an existing file that does not parse ABORTS: rewriting would destroy user settings. */

import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
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

/** Hooks invoke plain `dosu`; warn at enable time when that will not resolve. */
export function dosuOnPath(): boolean {
  const bin = process.platform === "win32" ? "dosu.cmd" : "dosu";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, bin)));
}

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

/** `NAME='value'` assignments a dev-mode command needs so a run from any cwd hits the same
 * endpoints as this working copy. Shared by the hook and status-line installers. */
export function devEnvAssignments(): string[] {
  const env = ["DOSU_DEV=true"];
  for (const { name, resolve } of DEV_HOOK_ENV) {
    const value = resolve();
    if (value) env.push(`${name}='${value}'`);
  }
  return env;
}

/** This working copy's entry point, single-quoted for a shell or a shell-style splitter. */
export function devSelfCommand(): string {
  const { command, baseArgs } = selfInvocation();
  return [command, ...baseArgs].map((part) => `'${part}'`).join(" ");
}

/** The command `hooks enable` writes. Dev installs pin the working copy by absolute path with
 * env inline so hook-triggered runs exercise the code under development, not the PATH `dosu`. */
export function hookCommand(): string {
  if (process.env.DOSU_DEV !== "true") return HOOK_COMMAND;
  return `${devEnvAssignments().join(" ")} ${devSelfCommand()} knowledge sync --quiet --detach`;
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
  timeout?: unknown;
}

/** What a grouped-hook edit writes and which existing entries it owns. Defaults to the
 * knowledge-sync hook; agent memory passes its own so the two never touch each other's entries. */
export interface GroupedHookSpec {
  command: string;
  owns: (command: unknown) => boolean;
  /** Per-hook `timeout`, in seconds. */
  timeout?: number;
  /** Codex's per-hook `async`: run in the background. */
  async?: boolean;
}

function knowledgeHookSpec(): GroupedHookSpec {
  return { command: hookCommand(), owns: isDosuHookCommand };
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

export function hasGroupedHook(
  config: JsonConfig,
  event: string,
  owns: GroupedHookSpec["owns"] = isDosuHookCommand,
): boolean {
  return groupedEventArray(config, event).some(
    (group) => Array.isArray(group?.hooks) && group.hooks.some((h) => owns(h?.command)),
  );
}

export function addGroupedHook(
  config: JsonConfig,
  event: string,
  spec: GroupedHookSpec = knowledgeHookSpec(),
): JsonConfig {
  const options = {
    ...(spec.timeout === undefined ? {} : { timeout: spec.timeout }),
    ...(spec.async ? { async: true } : {}),
  };

  let present = false;
  for (const group of groupedEventArray(config, event)) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const hook of group.hooks) {
      if (!spec.owns(hook?.command)) continue;
      present = true;
      hook.command = spec.command;
      Object.assign(hook, options);
    }
  }
  if (present) return config;
  if (typeof config.hooks !== "object" || config.hooks === null) config.hooks = {};
  if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
  config.hooks[event].push({ hooks: [{ type: "command", command: spec.command, ...options }] });
  return config;
}

export function removeGroupedHook(
  config: JsonConfig,
  event: string,
  owns: GroupedHookSpec["owns"] = isDosuHookCommand,
): JsonConfig {
  const groups = groupedEventArray(config, event);
  if (groups.length === 0) return config;
  const kept = groups
    .map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((h) => !owns(h?.command));
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

const isEmptyGroup = (group: GroupedHookGroup) =>
  Array.isArray(group?.hooks) && group.hooks.length === 0;

/** Remove our entries without moving anyone else's. Codex keys a hook's trust to its file, event,
 * group index and handler index (`hook_key` in codex-rs/hooks, 0.153 and 0.160), so a group left
 * empty stays as `{"hooks": []}` while a later group follows it; empty groups at the end go.
 * Returns how many other handlers still moved, which happens only where one of ours shared their
 * group: Codex skips those until they are trusted again. */
export function removeGroupedHookInPlace(
  config: JsonConfig,
  event: string,
  owns: GroupedHookSpec["owns"],
): { config: JsonConfig; moved: number } {
  const groups = groupedEventArray(config, event);
  if (groups.length === 0) return { config, moved: 0 };
  let moved = 0;
  const kept = groups.map((group) => {
    if (!Array.isArray(group?.hooks)) return group;
    const first = group.hooks.findIndex((h) => owns(h?.command));
    if (first < 0) return group;
    moved += group.hooks.slice(first).filter((h) => !owns(h?.command)).length;
    return { ...group, hooks: group.hooks.filter((h) => !owns(h?.command)) };
  });
  while (kept.length > 0 && isEmptyGroup(kept[kept.length - 1])) kept.pop();
  if (kept.length > 0) {
    config.hooks[event] = kept;
  } else {
    delete config.hooks[event];
  }
  return { config, moved };
}

// --- Cursor format ---

interface CursorHookEntry {
  command?: unknown;
}

/** As `GroupedHookSpec`, for Cursor's flat entries, which also take a `matcher`. */
export interface CursorHookSpec {
  command: string;
  owns: (command: unknown) => boolean;
  /** Per-hook `timeout`, in seconds. */
  timeout?: number;
  /** Regex on what the event matches, such as the tool name. */
  matcher?: string;
}

function knowledgeCursorSpec(): CursorHookSpec {
  return { command: hookCommand(), owns: isDosuHookCommand };
}

function cursorEventArray(config: JsonConfig, event: string): CursorHookEntry[] {
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) return [];
  const entries = hooks[event];
  return Array.isArray(entries) ? entries : [];
}

export function hasCursorHook(
  config: JsonConfig,
  event: string,
  owns: CursorHookSpec["owns"] = isDosuHookCommand,
): boolean {
  return cursorEventArray(config, event).some((entry) => owns(entry?.command));
}

export function addCursorHook(
  config: JsonConfig,
  event: string,
  spec: CursorHookSpec = knowledgeCursorSpec(),
): JsonConfig {
  const options = {
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
    ...(spec.timeout === undefined ? {} : { timeout: spec.timeout }),
  };
  // Same stale-command refresh as addGroupedHook.
  let present = false;
  for (const entry of cursorEventArray(config, event)) {
    if (!spec.owns(entry?.command)) continue;
    present = true;
    entry.command = spec.command;
    Object.assign(entry, options);
  }
  if (present) return config;
  if (config.version === undefined) config.version = 1;
  if (typeof config.hooks !== "object" || config.hooks === null) config.hooks = {};
  if (!Array.isArray(config.hooks[event])) config.hooks[event] = [];
  config.hooks[event].push({ command: spec.command, ...options });
  return config;
}

export function removeCursorHook(
  config: JsonConfig,
  event: string,
  owns: CursorHookSpec["owns"] = isDosuHookCommand,
): JsonConfig {
  const entries = cursorEventArray(config, event);
  if (entries.length === 0) return config;
  const kept = entries.filter((entry) => !owns(entry?.command));
  if (kept.length > 0) {
    config.hooks[event] = kept;
  } else {
    delete config.hooks[event];
  }
  return config;
}
