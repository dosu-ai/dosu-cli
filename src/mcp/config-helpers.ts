/**
 * Shared JSON config helpers for MCP provider configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBackendURL } from "../config/constants";

/**
 * Returns the MCP endpoint URL with deployment ID encoded in the path.
 */
export function mcpURL(deploymentID: string): string {
  return `${getBackendURL()}/v1/mcp/deployments/${deploymentID}`;
}

/**
 * Returns the standard MCP headers with API key auth.
 */
export function mcpHeaders(apiKey: string): Record<string, string> {
  return { "X-Dosu-API-Key": apiKey };
}

/**
 * Reads and unmarshals a JSON config file. Returns an empty object if the file doesn't exist.
 * For .jsonc files, comments are stripped before parsing.
 */
export function loadJSONConfig(path: string): Record<string, any> {
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
export function saveJSONConfig(path: string, cfg: Record<string, any>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2));
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
export function installJSONServer(
  configPath: string,
  topKey: string,
  server: Record<string, any>,
): void {
  const jsonCfg = loadJSONConfig(configPath);
  let section = jsonCfg[topKey];
  if (typeof section !== "object" || section === null) {
    section = {};
  }
  section["dosu"] = server;
  jsonCfg[topKey] = section;
  saveJSONConfig(configPath, jsonCfg);
}

/**
 * Removes the dosu entry from a JSON config file.
 */
export function removeJSONServer(configPath: string, topKey: string): void {
  let jsonCfg: Record<string, any>;
  try {
    jsonCfg = loadJSONConfig(configPath);
  } catch {
    return; // file doesn't exist or can't be read = nothing to remove
  }
  const section = jsonCfg[topKey];
  if (typeof section === "object" && section !== null) {
    delete section["dosu"];
  }
  saveJSONConfig(configPath, jsonCfg);
}
