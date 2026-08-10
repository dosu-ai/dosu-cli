/**
 * Claude Code status-line installer (Dosu knowledge row).
 *
 * The row (`Knowledge 📚 3 pages · 📝 77 notes`) is rendered by an embedded
 * Python script from per-session state that `dosu hooks post-tool-use` / `stop`
 * write whenever knowledge is delivered (explicit `read_knowledge` calls and
 * hook-injected context alike — see src/statusline/state.ts). This module only
 * installs the renderer under `~/.dosu/claude/` and wires `statusLine` into the
 * user's `~/.claude/settings.json`.
 *
 * The main install hazard: `statusLine` is single-valued. Overwriting a user's
 * existing status line silently is worse than not installing, so an existing
 * foreign command is never replaced without `force` — the caller gets a
 * "conflict" result and reports it. The original command is backed up before a
 * forced replace so uninstall can restore it.
 */

import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveJSONConfig, writeSecureFile } from "../mcp/config-helpers";
import { STATUS_LINE_SOURCE } from "./assets";
import { knowledgeStateDir } from "./state";

// biome-ignore lint/suspicious/noExplicitAny: settings JSON is inherently untyped
type JsonConfig = Record<string, any>;

/** An earlier standalone-hook design installed this; installs/uninstalls clean it up. */
const LEGACY_HOOK_FILE = "dosu-knowledge-hook.py";
const STATUS_LINE_FILE = "dosu-statusline.py";

/** `~/.dosu/claude/` — ours alone, so uninstall is a single directory removal. */
export function statuslineScriptsDir(home: string = homedir()): string {
  return join(home, ".dosu", "claude");
}

export function claudeUserSettingsPath(home: string = homedir()): string {
  return join(home, ".claude", "settings.json");
}

/** Where a replaced statusLine value is saved so uninstall can restore it. */
export function statuslineBackupPath(home: string = homedir()): string {
  return join(statuslineScriptsDir(home), "statusline-backup.json");
}

export function statusLineScriptPath(home: string = homedir()): string {
  return join(statuslineScriptsDir(home), STATUS_LINE_FILE);
}

function legacyHookScriptPath(home: string): string {
  return join(statuslineScriptsDir(home), LEGACY_HOOK_FILE);
}

/** Write the embedded renderer, executable. Idempotent (refreshes on reinstall). */
export function writeStatuslineScripts(home: string = homedir()): void {
  const path = statusLineScriptPath(home);
  writeSecureFile(path, STATUS_LINE_SOURCE);
  chmodSync(path, 0o755); // must be executable — settings.json invokes it directly
}

/**
 * Read a settings file, refusing to clobber a file that exists but does not
 * parse — a malformed settings.json silently disables every setting in it,
 * so we must never be the ones who make it worse.
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

function isOurStatusLine(statusLine: unknown): boolean {
  return (
    !!statusLine &&
    typeof statusLine === "object" &&
    typeof (statusLine as JsonConfig).command === "string" &&
    (statusLine as JsonConfig).command.includes(STATUS_LINE_FILE)
  );
}

function isLegacyHookGroup(group: unknown): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as JsonConfig).hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) => h && typeof h.command === "string" && (h.command as string).includes(LEGACY_HOOK_FILE),
    )
  );
}

/** Strip the legacy standalone hook's PostToolUse entry, if present. */
function removeLegacyHookEntries(cfg: JsonConfig): boolean {
  if (!Array.isArray(cfg.hooks?.PostToolUse)) return false;
  const preserved = cfg.hooks.PostToolUse.filter((g: unknown) => !isLegacyHookGroup(g));
  const removed = preserved.length !== cfg.hooks.PostToolUse.length;
  if (preserved.length === 0) {
    delete cfg.hooks.PostToolUse;
  } else {
    cfg.hooks.PostToolUse = preserved;
  }
  if (cfg.hooks && Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  return removed;
}

export type StatusLineOutcome = "installed" | "updated" | "conflict" | "replaced";

export interface InstallResult {
  settingsPath: string;
  statusLine: StatusLineOutcome;
  /** The pre-existing foreign command, when statusLine is "conflict" or "replaced". */
  existingCommand?: string;
  warnings: string[];
}

/**
 * Wire the renderer into `~/.claude/settings.json` (user scope).
 *
 * `statusLine` absent → write ours. Ours already → refresh. Foreign →
 * conflict (skip) unless `force`, which backs the original up and replaces.
 * Also removes the legacy standalone-hook PostToolUse entry when found.
 */
export function installStatuslineSettings(
  home: string = homedir(),
  opts: { force?: boolean } = {},
): InstallResult {
  const settingsPath = claudeUserSettingsPath(home);
  const cfg = readSettingsOrThrow(settingsPath);
  const warnings = collectSettingsWarnings(cfg);

  let statusLine: StatusLineOutcome;
  let existingCommand: string | undefined;
  const ours = {
    type: "command",
    command: statusLineScriptPath(home),
    padding: 1,
  };
  if (cfg.statusLine === undefined) {
    cfg.statusLine = ours;
    statusLine = "installed";
  } else if (isOurStatusLine(cfg.statusLine)) {
    cfg.statusLine = ours;
    statusLine = "updated";
  } else {
    existingCommand =
      typeof (cfg.statusLine as JsonConfig)?.command === "string"
        ? (cfg.statusLine as JsonConfig).command
        : JSON.stringify(cfg.statusLine);
    if (opts.force) {
      // Save the original so uninstall can restore it.
      writeSecureFile(statuslineBackupPath(home), JSON.stringify(cfg.statusLine, null, 2));
      cfg.statusLine = ours;
      statusLine = "replaced";
    } else {
      statusLine = "conflict";
    }
  }

  removeLegacyHookEntries(cfg);
  saveJSONConfig(settingsPath, cfg);
  return { settingsPath, statusLine, existingCommand, warnings };
}

/** Environments where the install would be inert — detect and warn, don't guess. */
export function collectSettingsWarnings(cfg: JsonConfig): string[] {
  const warnings: string[] = [];
  if (cfg.disableAllHooks === true) {
    warnings.push(
      "disableAllHooks is set in ~/.claude/settings.json — hooks and the status line are disabled until it is removed",
    );
  }
  if (cfg.allowManagedHooksOnly === true) {
    warnings.push(
      "allowManagedHooksOnly is set — user hooks are blocked, so knowledge counts will never be recorded",
    );
  }
  return warnings;
}

export interface UninstallResult {
  settingsPath: string;
  statusLineRemoved: boolean;
  statusLineRestored: boolean;
}

/**
 * Reverse the install. Removes `statusLine` only if it still points at our
 * script (the user may have replaced it since), restoring any backed-up
 * original; deletes our files and state; strips any legacy hook entry.
 */
export function uninstallStatusline(home: string = homedir()): UninstallResult {
  const settingsPath = claudeUserSettingsPath(home);
  const result: UninstallResult = {
    settingsPath,
    statusLineRemoved: false,
    statusLineRestored: false,
  };

  let cfg: JsonConfig | null = null;
  try {
    cfg = readSettingsOrThrow(settingsPath);
  } catch {
    cfg = null; // never clobber an unparseable file; still remove our own files below
  }

  if (cfg) {
    if (isOurStatusLine(cfg.statusLine)) {
      const backup = statuslineBackupPath(home);
      let restored: JsonConfig | undefined;
      if (existsSync(backup)) {
        try {
          restored = JSON.parse(readFileSync(backup, "utf-8")) as JsonConfig;
        } catch {
          restored = undefined;
        }
      }
      if (restored) {
        cfg.statusLine = restored;
        result.statusLineRestored = true;
      } else {
        delete cfg.statusLine;
      }
      result.statusLineRemoved = true;
    }

    const legacyRemoved = removeLegacyHookEntries(cfg);
    if (result.statusLineRemoved || legacyRemoved) {
      saveJSONConfig(settingsPath, cfg);
    }
  }

  for (const path of [
    statusLineScriptPath(home),
    legacyHookScriptPath(home),
    statuslineBackupPath(home),
  ]) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
  try {
    rmSync(knowledgeStateDir(home), { recursive: true, force: true });
  } catch {
    // best-effort
  }
  return result;
}

/** Read-only inspection for `statusline status`. Never throws. */
export function inspectStatusline(home: string = homedir()): {
  scriptInstalled: boolean;
  statusLineConfigured: boolean;
  settingsParseError: boolean;
  warnings: string[];
} {
  let cfg: JsonConfig = {};
  let settingsParseError = false;
  try {
    cfg = readSettingsOrThrow(claudeUserSettingsPath(home));
  } catch {
    settingsParseError = true;
  }
  return {
    scriptInstalled: existsSync(statusLineScriptPath(home)),
    statusLineConfigured: isOurStatusLine(cfg.statusLine),
    settingsParseError,
    warnings: collectSettingsWarnings(cfg),
  };
}
