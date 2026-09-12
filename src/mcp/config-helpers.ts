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
 * Exact-pinned so npx never floats to a fresh release on user machines —
 * mcp-remote is a third-party package on the agent hot path, and a floating
 * tag would bypass the supply-chain delay this repo applies to its own
 * dependencies (bunfig minimumReleaseAge). Bump deliberately.
 */
export const MCP_REMOTE_VERSION = "0.1.38";

export interface McpRemoteServer {
  args: string[];
  env: Record<string, string>;
}

/**
 * Builds the `npx mcp-remote` invocation that proxies the remote HTTP MCP
 * endpoint as a local stdio server. Hosts that only render MCP Apps for
 * stdio servers (Codex desktop, Claude Desktop chat) need this form — a
 * remote-HTTP entry serves tools fine but never shows the Session Knowledge
 * card.
 *
 * Header values are passed as `${VAR}` placeholders that mcp-remote expands
 * from its environment, so the API key lives in the config entry's `env`
 * block instead of argv (argv is visible to every local process via `ps`).
 */
export function mcpRemoteServer(url: string, apiKey: string | undefined): McpRemoteServer {
  const env: Record<string, string> = {};
  const headerArgs = Object.entries(mcpHeaders(apiKey)).flatMap(([key, value]) => {
    const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    env[envKey] = value;
    return ["--header", `${key}:\${${envKey}}`];
  });
  return {
    args: [
      "-y",
      `mcp-remote@${MCP_REMOTE_VERSION}`,
      url,
      ...headerArgs,
      "--transport",
      "http-only",
    ],
    env,
  };
}

/**
 * Reads and unmarshals a JSON config file. Returns an empty object if the file doesn't exist.
 * For .jsonc files, comments are stripped before parsing.
 */
export function loadJSONConfig(path: string): JsonConfig {
  try {
    return readJSONConfig(path);
  } catch {
    return {};
  }
}

/**
 * Reads a JSON/JSONC config file. Returns `{}` for a missing or empty file and
 * THROWS when a non-empty file cannot be parsed, so writers never mistake an
 * unreadable file for an empty one and overwrite it.
 *
 * Comments and trailing commas are tolerated regardless of extension: several
 * hosts (Zed's `settings.json`, VS Code's `mcp.json`) are JSONC-by-default and
 * Zed's shipped template opens with `//` header lines.
 */
export function readJSONConfig(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(stripTrailingCommas(stripJSONComments(raw)));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse ${path} as JSON (${detail}). Fix the file and retry.`);
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
 * Removes trailing commas before `}` / `]` outside of string literals
 * (JSONC-lenient parsers such as Zed's accept them; `JSON.parse` does not).
 * Run AFTER stripJSONComments so only whitespace can sit between the comma
 * and the closing bracket.
 */
export function stripTrailingCommas(data: string): string {
  const result: string[] = [];
  let inString = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (inString) {
      result.push(ch);
      if (ch === "\\" && i + 1 < data.length) {
        result.push(data[++i]);
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result.push(ch);
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < data.length && /\s/.test(data[j])) j++;
      if (data[j] === "}" || data[j] === "]") continue; // drop the comma
    }
    result.push(ch);
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
  // Strict read: an unparseable settings file must abort, never be replaced.
  const jsonCfg = readJSONConfig(configPath);
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
  if (!existsSync(configPath)) return; // nothing to remove, and don't create the file
  let jsonCfg: JsonConfig;
  try {
    jsonCfg = readJSONConfig(configPath);
  } catch {
    return; // unparseable: leave the user's file untouched rather than clobber it
  }
  const section = jsonCfg[topKey];
  if (typeof section !== "object" || section === null || !("dosu" in section)) return;
  delete section.dosu;
  saveJSONConfig(configPath, jsonCfg);
}
