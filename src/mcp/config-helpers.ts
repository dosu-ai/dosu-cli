/**
 * Shared JSON config helpers for MCP provider configuration.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
// Static default import (not `createRequire`) so `bun build --compile`
// statically detects the dependency and bundles it into the binary.
// Otherwise the compiled `dosu` looks for `write-file-atomic` on the
// caller's CWD `node_modules` at runtime and fails outside this repo.
// @ts-expect-error — write-file-atomic ships no types; shape is documented inline.
import writeFileAtomicRaw from "write-file-atomic";
import { getBackendURL } from "../config/constants";

type WriteFileAtomicOptions = {
  mode: number;
  chown: false;
};

const writeFileAtomic = writeFileAtomicRaw as {
  sync(path: string, data: string, options: WriteFileAtomicOptions): void;
};

// biome-ignore lint/suspicious/noExplicitAny: JSON config values are inherently untyped
type JsonConfig = Record<string, any>;

/**
 * Returns the MCP endpoint URL with deployment ID encoded in the path.
 */
export function mcpURL(deploymentID: string): string {
  return `${getBackendURL()}/v1/mcp/deployments/${deploymentID}`;
}

/**
 * Returns the base MCP endpoint URL without a deployment ID (for OSS mode).
 */
export function mcpBaseURL(): string {
  return `${getBackendURL()}/v1/mcp`;
}

/**
 * Returns the standard MCP headers with API key auth.
 */
export function mcpHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) {
    throw new Error("API key is required. Run 'dosu setup' to create one.");
  }
  return { "X-Dosu-API-Key": apiKey };
}

/**
 * Reads and unmarshals a JSON config file. Returns an empty object if the file doesn't exist.
 * For .jsonc files, comments are stripped before parsing.
 */
export function loadJSONConfig(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  let data = readFileSync(path, "utf-8").trim();
  if (!data) return {};
  if (path.endsWith(".jsonc")) {
    data = stripJSONComments(data);
  }
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Strips // and block comments from JSONC content, preserving strings.
 */
export function stripJSONComments(data: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < data.length) {
    // String literal — copy verbatim, handling escapes
    if (data[i] === '"') {
      result.push(data[i]);
      i++;
      while (i < data.length && data[i] !== '"') {
        if (data[i] === "\\") {
          result.push(data[i]);
          i++;
          if (i < data.length) {
            result.push(data[i]);
            i++;
          }
          continue;
        }
        result.push(data[i]);
        i++;
      }
      if (i < data.length) {
        result.push(data[i]);
        i++;
      }
      continue;
    }

    // Line comment
    if (i + 1 < data.length && data[i] === "/" && data[i + 1] === "/") {
      i += 2;
      while (i < data.length && data[i] !== "\n") i++;
      continue;
    }

    // Block comment
    if (i + 1 < data.length && data[i] === "/" && data[i + 1] === "*") {
      i += 2;
      while (i + 1 < data.length && !(data[i] === "*" && data[i + 1] === "/")) i++;
      if (i + 1 < data.length) i += 2;
      continue;
    }

    result.push(data[i]);
    i++;
  }

  return result.join("");
}

/**
 * Writes a JSON config file, creating parent directories as needed.
 */
export function saveJSONConfig(path: string, cfg: JsonConfig): void {
  writeSecureFile(path, JSON.stringify(cfg, null, 2));
}

/** Writes a secret-bearing config file atomically with owner-only permissions. */
export function writeSecureFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileAtomic.sync(path, content, { mode: 0o600, chown: false });
}

/**
 * Checks if "dosu" exists under the given top-level key in a JSON config file.
 */
export function isJSONKeyConfigured(configPath: string, topLevelKey: string): boolean {
  const cfg = loadJSONConfig(configPath);
  const section = cfg[topLevelKey];
  if (typeof section !== "object" || section === null) return false;
  return "dosu" in section;
}

/**
 * Writes the dosu MCP server entry into a JSON config file.
 */
export function installJSONServer(configPath: string, topKey: string, server: JsonConfig): void {
  const jsonCfg = loadJSONConfig(configPath);
  let section = jsonCfg[topKey];
  if (typeof section !== "object" || section === null) {
    section = {};
  }
  section.dosu = server;
  jsonCfg[topKey] = section;
  saveJSONConfig(configPath, jsonCfg);
}

/**
 * Removes the dosu entry from a JSON config file.
 */
export function removeJSONServer(configPath: string, topKey: string): void {
  let jsonCfg: JsonConfig;
  try {
    jsonCfg = loadJSONConfig(configPath);
  } catch {
    return; // file doesn't exist or can't be read = nothing to remove
  }
  const section = jsonCfg[topKey];
  if (typeof section === "object" && section !== null) {
    delete section.dosu;
  }
  saveJSONConfig(configPath, jsonCfg);
}

// Marker used to identify the Dosu workflow hook entry so we can be idempotent.
const DOSU_HOOK_MARKER = "dosu write";

// biome-ignore lint/suspicious/noExplicitAny: hook entries are arbitrary JSON
type HookEntry = Record<string, any>;

/**
 * Installs a UserPromptSubmit hook into a Claude Code config file that reminds
 * the agent to save non-obvious facts with `dosu write` after each task.
 * Idempotent — no-ops if the hook is already present.
 */
export function installWorkflowHook(configPath: string): void {
  const cfg = loadJSONConfig(configPath);
  const hooks: Record<string, HookEntry[]> = cfg.hooks ?? {};
  const submitHooks: HookEntry[] = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit
    : [];

  const alreadyInstalled = submitHooks.some((entry: HookEntry) =>
    (entry.hooks ?? []).some(
      (h: HookEntry) => typeof h.command === "string" && h.command.includes(DOSU_HOOK_MARKER),
    ),
  );
  if (alreadyInstalled) return;

  submitHooks.push({
    hooks: [
      {
        type: "command",
        command:
          "echo 'When you finish this task: if you discovered any non-obvious facts (constraints, gotchas, decisions), save them with: dosu write \"<concise fact>\"'",
      },
    ],
  });

  cfg.hooks = { ...hooks, UserPromptSubmit: submitHooks };
  saveJSONConfig(configPath, cfg);
}

/**
 * Removes the Dosu workflow hook from a Claude Code config file.
 * Idempotent — no-ops if the hook is not present.
 */
export function removeWorkflowHook(configPath: string): void {
  let cfg: JsonConfig;
  try {
    cfg = loadJSONConfig(configPath);
  } catch {
    return;
  }

  const hooks: Record<string, HookEntry[]> = cfg.hooks ?? {};
  const submitHooks: HookEntry[] = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit
    : [];

  const filtered = submitHooks.filter(
    (entry: HookEntry) =>
      !(entry.hooks ?? []).some(
        (h: HookEntry) => typeof h.command === "string" && h.command.includes(DOSU_HOOK_MARKER),
      ),
  );

  if (filtered.length === submitHooks.length) return; // nothing changed

  if (filtered.length === 0) {
    delete hooks.UserPromptSubmit;
  } else {
    hooks.UserPromptSubmit = filtered;
  }

  if (Object.keys(hooks).length === 0) {
    delete cfg.hooks;
  } else {
    cfg.hooks = hooks;
  }
  saveJSONConfig(configPath, cfg);
}
