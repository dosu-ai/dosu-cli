/**
 * Codex CLI hooks installer.
 *
 * Writes the Dosu hook block into the project-level Codex hooks file
 * (`<repo>/.codex/hooks.json`) — the dedicated-file form Codex documents as
 * one of its two supported representations ("Prefer one representation per
 * layer"). Codex merges this with the user's own hooks from other layers, so
 * we never touch `~/.codex/config.toml`.
 *
 * Codex's hook wire protocol intentionally mirrors Claude Code's: the same
 * event names (`UserPromptSubmit`, `PostToolUse`, `Stop`), the same stdin
 * fields (`session_id`, `prompt`, `cwd`, `turn_id`, `stop_hook_active`), and
 * the same stdout contracts (`hookSpecificOutput.additionalContext`,
 * `decision: "block"` + `reason` on Stop). The `dosu hooks …` entrypoints
 * therefore run unchanged; the installed commands only add `--agent codex`
 * for analytics attribution.
 *
 * Two Codex-specific constraints shape this module:
 *
 * 1. TRUST — Codex runs a non-managed command hook only after the user
 *    reviews and trusts it (against a hash of the definition) via `/hooks`
 *    inside Codex. An installer cannot pre-trust its own hooks; install
 *    output must tell the user to complete that one-time step.
 * 2. NO MARKER KEYS — unlike Claude Code's settings (where we tag entries
 *    with a `__dosu` key), unknown fields could be rejected by Codex's
 *    strict parsers, and any edit changes the hook's trust hash. Ownership
 *    is therefore detected purely from the command shape (`dosu hooks …`),
 *    reusing the same predicate as the Claude Code installer.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { saveJSONConfig } from "../mcp/config-helpers";
import { DEFAULT_HOOK_EVENTS, isDosuGroup } from "./claude-code";
import { resolveHookCommandPrefix } from "./runtime";

// biome-ignore lint/suspicious/noExplicitAny: hooks JSON is inherently untyped
type JsonConfig = Record<string, any>;

interface CodexHookEntry {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface CodexMatcherGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

/** Path to the project-level Codex hooks file under a project root. */
export function codexHooksPath(dir: string): string {
  return join(dir, ".codex", "hooks.json");
}

/** Map a Codex hook event (the config key) to its `dosu hooks` subcommand. */
const EVENT_SUBCOMMAND: Record<string, string> = {
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};

/**
 * Per-event timeouts (seconds). Codex defaults to 600s — far longer than any
 * dosu hook should ever hold a turn. The entrypoints' no-op path returns in
 * milliseconds; Stop may wait up to ~8s for an in-flight lookup.
 */
const EVENT_TIMEOUT_SEC: Record<string, number> = {
  UserPromptSubmit: 10,
  PostToolUse: 10,
  Stop: 30,
};

/** Shown by Codex while the hook runs. */
const EVENT_STATUS_MESSAGE: Record<string, string> = {
  UserPromptSubmit: "Dosu knowledge lookup",
  PostToolUse: "Dosu knowledge delivery",
  Stop: "Dosu final knowledge check",
};

/**
 * The command Codex runs for a given hook subcommand. `dosu` from PATH, or the
 * materialized runtime when there is no global install (same resolution as the
 * Claude Code installer — see hooks/runtime.ts); `--agent codex` attributes
 * the resulting knowledge tickets to Codex sessions.
 */
export function codexHookCommand(
  subcommand: string,
  prefix: string = resolveHookCommandPrefix(),
): string {
  return `${prefix} hooks ${subcommand} --agent codex`;
}

function dosuGroup(event: string): CodexMatcherGroup {
  // No `matcher`: Codex treats a missing matcher as match-everything, and
  // ignores matchers entirely for UserPromptSubmit/Stop.
  return {
    hooks: [
      {
        type: "command",
        command: codexHookCommand(EVENT_SUBCOMMAND[event]),
        timeout: EVENT_TIMEOUT_SEC[event],
        statusMessage: EVENT_STATUS_MESSAGE[event],
      },
    ],
  };
}

/**
 * Read the hooks file, refusing to clobber a file that exists but does not
 * parse — same stance as the Claude Code installer.
 */
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

export interface CodexInstallOptions {
  /** Install the `Stop` hook. Defaults to true; pass `false` (via `--no-stop`) to skip it. */
  stop?: boolean;
}

/** Merge the Dosu hook block into a Codex hooks.json file. Returns the events installed. */
export function installCodexHooks(
  configPath: string,
  opts: CodexInstallOptions = {},
): { events: string[] } {
  const config = readHooksFileOrThrow(configPath);
  const events = DEFAULT_HOOK_EVENTS.filter((e) => e !== "Stop" || opts.stop !== false);

  const hooks: JsonConfig = typeof config.hooks === "object" && config.hooks ? config.hooks : {};
  for (const event of events) {
    const groups: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Idempotent reinstall: drop any prior Dosu-owned group, keep user groups.
    const kept = groups.filter((g) => !isDosuGroup(g));
    kept.push(dosuGroup(event));
    hooks[event] = kept;
  }
  // A previous full install may have left a Dosu Stop group behind a --no-stop
  // reinstall; sweep Dosu groups from events we are not installing this time.
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
export function removeCodexHooks(configPath: string): { removed: boolean } {
  if (!existsSync(configPath)) return { removed: false };
  let config: JsonConfig;
  try {
    config = readHooksFileOrThrow(configPath);
  } catch {
    return { removed: false }; // invalid JSON — leave it alone
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
export function inspectCodexHooks(configPath: string): {
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
