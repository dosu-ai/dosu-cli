/**
 * Factory Droid hooks installer.
 *
 * Writes the Dosu hook block into the project-level Factory hooks file
 * (`<repo>/.factory/hooks.json`). Factory's hook wire protocol mirrors
 * Claude Code's: the same event names (`UserPromptSubmit`, `PostToolUse`,
 * `Stop`), the same stdin fields, and the same stdout contracts. The
 * `dosu hooks …` entrypoints run unchanged; `--agent factory` attributes
 * tickets to Factory sessions.
 *
 * No `__dosu` marker is added to hook entries — unknown keys may be
 * rejected by Factory's config parsers. Ownership is detected purely from
 * the command shape (`dosu hooks …`), reusing the same predicate as the
 * Claude Code and Codex installers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveJSONConfig } from "../mcp/config-helpers";
import { DEFAULT_HOOK_EVENTS, isDosuGroup } from "./claude-code";

// biome-ignore lint/suspicious/noExplicitAny: hooks JSON is inherently untyped
type JsonConfig = Record<string, any>;

interface FactoryHookEntry {
  type: "command";
  command: string;
}

interface FactoryMatcherGroup {
  matcher?: string;
  hooks: FactoryHookEntry[];
}

/** Path to the project-level Factory hooks file under a project root. */
export function factoryHooksPath(dir: string): string {
  return join(dir, ".factory", "hooks.json");
}

/** Map a Factory hook event to its `dosu hooks` subcommand. */
const EVENT_SUBCOMMAND: Record<string, string> = {
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};

/**
 * The command Factory runs for a given hook subcommand. Bare `dosu` from PATH;
 * `--agent factory` attributes the resulting knowledge tickets to Factory sessions.
 */
export function factoryHookCommand(subcommand: string): string {
  return `dosu hooks ${subcommand} --agent factory`;
}

function dosuGroup(event: string): FactoryMatcherGroup {
  const group: FactoryMatcherGroup = {
    hooks: [{ type: "command", command: factoryHookCommand(EVENT_SUBCOMMAND[event]) }],
  };
  if (event === "PostToolUse") group.matcher = "*";
  return group;
}

function readHooksFileOrThrow(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonConfig;
  } catch {
    throw new Error(`refusing to modify ${path}: file exists but is not valid JSON`);
  }
}

export interface FactoryInstallOptions {
  /** Install the `Stop` hook. Defaults to true; pass `false` (via `--no-stop`) to skip it. */
  stop?: boolean;
}

/** Merge the Dosu hook block into a Factory hooks.json file. Returns the events installed. */
export function installFactoryHooks(
  configPath: string,
  opts: FactoryInstallOptions = {},
): { events: string[] } {
  const config = readHooksFileOrThrow(configPath);
  const events = DEFAULT_HOOK_EVENTS.filter((e) => e !== "Stop" || opts.stop !== false);

  const hooks: JsonConfig = typeof config.hooks === "object" && config.hooks ? config.hooks : {};
  for (const event of events) {
    const groups: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = groups.filter((g) => !isDosuGroup(g));
    kept.push(dosuGroup(event));
    hooks[event] = kept;
  }
  // Sweep Dosu groups from events not being installed (e.g. --no-stop reinstall).
  for (const event of DEFAULT_HOOK_EVENTS) {
    if (!events.includes(event) && Array.isArray(hooks[event])) {
      const kept = hooks[event].filter((g: unknown) => !isDosuGroup(g));
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  config.hooks = hooks;

  saveJSONConfig(configPath, config);
  return { events: [...events] };
}

/** Remove only Dosu-owned hook groups. Returns whether anything was removed. */
export function removeFactoryHooks(configPath: string): { removed: boolean } {
  if (!existsSync(configPath)) return { removed: false };
  let config: JsonConfig;
  try {
    config = readHooksFileOrThrow(configPath);
  } catch {
    return { removed: false };
  }
  const hooks = config.hooks;
  if (typeof hooks !== "object" || !hooks) return { removed: false };

  let removed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((g: unknown) => !isDosuGroup(g));
    if (kept.length !== hooks[event].length) {
      removed = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  if (removed) saveJSONConfig(configPath, config);
  return { removed };
}

/** Read-only inspection for `doctor`. Never throws. */
export function inspectFactoryHooks(configPath: string): {
  fileExists: boolean;
  parseError?: boolean;
  events: string[];
} {
  if (!existsSync(configPath)) return { fileExists: false, events: [] };
  let config: JsonConfig;
  try {
    config = readHooksFileOrThrow(configPath);
  } catch {
    return { fileExists: true, parseError: true, events: [] };
  }
  const hooks = config.hooks;
  if (typeof hooks !== "object" || !hooks) return { fileExists: true, events: [] };
  const events = Object.keys(hooks).filter(
    (event) => Array.isArray(hooks[event]) && hooks[event].some((g: unknown) => isDosuGroup(g)),
  );
  return { fileExists: true, events };
}
