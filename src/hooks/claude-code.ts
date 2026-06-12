/**
 * Claude Code hooks installer.
 *
 * Writes the Dosu hook block into Claude Code's per-user, git-ignored local
 * settings (`.claude/settings.local.json`) — never tracked `.claude/settings.json`.
 * Merges without clobbering existing user hooks, tags Dosu-owned entries with a
 * `__dosu` marker so uninstall removes only our groups, and is idempotent on
 * reinstall. Pure config-shape logic: no network, no auth.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveJSONConfig } from "../mcp/config-helpers";

/**
 * Events the default install owns. `Stop` is included by default (opt out with
 * `--no-stop`): it is the reliable last-chance delivery point. The async backend
 * lookup often becomes ready only after the agent has stopped calling tools, so a
 * `PostToolUse`-only install frequently never delivers; `Stop` closes that gap.
 */
export const DEFAULT_HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
const MARKER = "__dosu";

// biome-ignore lint/suspicious/noExplicitAny: settings JSON is inherently untyped
type JsonConfig = Record<string, any>;

interface HookCommandEntry {
  type: "command";
  command: string;
  [MARKER]?: boolean;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

/** Path to Claude Code's local (git-ignored) settings file under a project root. */
export function claudeLocalSettingsPath(dir: string): string {
  return join(dir, ".claude", "settings.local.json");
}

/** Map a Claude Code hook event (the config key) to its `dosu hooks` subcommand. */
const EVENT_SUBCOMMAND: Record<string, string> = {
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};

/**
 * The command Claude Code runs for a given hook subcommand.
 *
 * Bare `dosu` (resolved from PATH), NOT `npx @dosu/cli@…`: the user installs via
 * the global `dosu`, so the same binary is already present. A direct exec is far
 * faster than an npx resolution on every tool call, and it auto-follows the
 * installed version with no pin to drift.
 */
export function hookCommand(subcommand: string): string {
  return `dosu hooks ${subcommand}`;
}

function dosuGroup(event: string): HookGroup {
  const entry: HookCommandEntry = {
    type: "command",
    command: hookCommand(EVENT_SUBCOMMAND[event]),
    [MARKER]: true,
  };
  // PostToolUse matches all tools; UserPromptSubmit / Stop take no matcher.
  return event === "PostToolUse" ? { matcher: "*", hooks: [entry] } : { hooks: [entry] };
}

/** Fallback (marker-less) detection: a `dosu hooks …` or legacy `@dosu/cli … hooks …` command. */
function isDosuHookCommand(command: string): boolean {
  if (!/\bhooks\b/.test(command)) return false;
  if (/@dosu\/cli/.test(command)) return true;
  // `dosu` must be the command name (optionally path-prefixed), NOT merely an
  // argument — so a user hook like `echo "dosu hooks ..."` is not misidentified
  // (and therefore not wrongly deleted on uninstall).
  return /^([^\s]*\/)?dosu\s/.test(command.trimStart());
}

/** True if a hook group is Dosu-owned (by marker, or — fallback — by command shape). */
export function isDosuGroup(group: unknown): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      !!h &&
      typeof h === "object" &&
      ((h as HookCommandEntry)[MARKER] === true ||
        (typeof h.command === "string" && isDosuHookCommand(h.command))),
  );
}

/**
 * Read a settings file, refusing to clobber a file that exists but does not
 * parse. `loadJSONConfig` masks parse errors as `{}`, which would silently
 * overwrite a corrupt-but-real config, so installs/uninstalls use this instead.
 */
function readSettingsOrThrow(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as JsonConfig;
  } catch {
    throw new Error(`refusing to modify ${path}: file exists but is not valid JSON`);
  }
}

export interface InstallOptions {
  /** Install the `Stop` hook. Defaults to true; pass `false` (via `--no-stop`) to skip it. */
  stop?: boolean;
}

/** Merge the Dosu hook block into a Claude Code settings file. Returns the events installed. */
export function installClaudeHooks(
  configPath: string,
  opts: InstallOptions = {},
): { events: string[] } {
  const cfg = readSettingsOrThrow(configPath);
  if (typeof cfg.hooks !== "object" || cfg.hooks === null) {
    cfg.hooks = {};
  }
  const includeStop = opts.stop !== false;
  const events = DEFAULT_HOOK_EVENTS.filter((event) => event !== "Stop" || includeStop);
  for (const event of events) {
    const existing: HookGroup[] = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
    // Drop any prior Dosu group first so reinstall/upgrade is idempotent.
    const preserved = existing.filter((g) => !isDosuGroup(g));
    preserved.push(dosuGroup(event));
    cfg.hooks[event] = preserved;
  }
  saveJSONConfig(configPath, cfg);
  return { events };
}

/** Remove only Dosu-owned hook groups, preserving all user hooks. */
export function removeClaudeHooks(configPath: string): { removed: boolean } {
  let cfg: JsonConfig;
  try {
    cfg = readSettingsOrThrow(configPath);
  } catch {
    return { removed: false }; // never clobber an unparseable file
  }
  if (typeof cfg.hooks !== "object" || cfg.hooks === null) {
    return { removed: false };
  }
  let removed = false;
  for (const event of Object.keys(cfg.hooks)) {
    const arr = cfg.hooks[event];
    if (!Array.isArray(arr)) continue;
    const preserved = arr.filter((g: unknown) => {
      if (isDosuGroup(g)) {
        removed = true;
        return false;
      }
      return true;
    });
    if (preserved.length === 0) {
      delete cfg.hooks[event];
    } else {
      cfg.hooks[event] = preserved;
    }
  }
  if (Object.keys(cfg.hooks).length === 0) {
    delete cfg.hooks;
  }
  saveJSONConfig(configPath, cfg);
  return { removed };
}

/** Read-only inspection of installed Dosu hooks (for `doctor`). Never throws. */
export function inspectClaudeHooks(configPath: string): {
  fileExists: boolean;
  parseError: boolean;
  events: string[];
} {
  if (!existsSync(configPath)) return { fileExists: false, parseError: false, events: [] };
  let cfg: JsonConfig;
  try {
    cfg = readSettingsOrThrow(configPath);
  } catch {
    return { fileExists: true, parseError: true, events: [] };
  }
  const hooks = typeof cfg.hooks === "object" && cfg.hooks !== null ? cfg.hooks : {};
  const events = Object.keys(hooks).filter(
    (event) => Array.isArray(hooks[event]) && hooks[event].some(isDosuGroup),
  );
  return { fileExists: true, parseError: false, events };
}
