/**
 * Codex CLI provider — uses TOML config format.
 * Simplified: we write JSON-style to a TOML-like structure using manual serialization.
 * For full parity, we'd need a TOML library. For now, use JSON config as Codex also supports it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { mcpBaseURL, mcpHeaders, mcpURL } from "../config-helpers";
import { expandHome, isInstalled } from "../detect";
import type { SetupProvider } from "../providers";

function codexHome(): string {
  return process.env.CODEX_HOME ?? expandHome("~/.codex");
}

function getConfigPath(global: boolean): string {
  if (global) return join(codexHome(), "config.toml");
  return join(process.cwd(), ".codex", "config.toml");
}

/**
 * Minimal TOML read/write for the Codex mcp_servers section.
 * We parse just enough to add/remove the [mcp_servers.dosu] entry.
 */
function readTOML(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function writeTOML(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: Windows and some filesystems may not support chmod.
  }
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.deployment_id);
}

function installDosuToTOML(path: string, cfg: Config): void {
  let content = readTOML(path);
  // Remove existing [mcp_servers.dosu] section if present
  content = removeDosuFromTOML(content);
  // Append new section
  const url = mcpEndpoint(cfg);
  const headers = mcpHeaders(cfg.api_key);
  const headerEntries = Object.entries(headers)
    .map(([k, v]) => `${k} = "${v}"`)
    .join("\n");

  const section = `\n[mcp_servers.dosu]\ntype = "http"\nurl = "${url}"\n\n[mcp_servers.dosu.http_headers]\n${headerEntries}\n`;
  content += section;
  writeTOML(path, content);
}

function removeDosuFromTOML(content: string): string {
  // Remove [mcp_servers.dosu] and [mcp_servers.dosu.*] sections
  const lines = content.split("\n");
  const result: string[] = [];
  let inDosuSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^\[mcp_servers\.dosu(\..*)?]$/)) {
      inDosuSection = true;
      continue;
    }
    if (inDosuSection && trimmed.startsWith("[")) {
      inDosuSection = false;
    }
    if (!inDosuSection) {
      result.push(line);
    }
  }
  return result.join("\n");
}

export const CodexProvider = (): SetupProvider => ({
  name: () => "Codex CLI",
  id: () => "codex",
  supportsLocal: () => true,
  priority: () => 8,
  detectPaths: () => ["~/.codex"],
  isInstalled: () => isInstalled(["~/.codex"]),
  globalConfigPath: () => join(codexHome(), "config.toml"),
  isConfigured: () => {
    const content = readTOML(join(codexHome(), "config.toml"));
    return content.includes("[mcp_servers.dosu]");
  },
  install(cfg: Config, global: boolean): void {
    if (cfg.mode !== MODE_OSS && !cfg.deployment_id) throw new Error("deployment ID is required");
    installDosuToTOML(getConfigPath(global), cfg);
  },
  remove(global: boolean): void {
    const path = getConfigPath(global);
    const content = readTOML(path);
    if (content) writeTOML(path, removeDosuFromTOML(content));
  },
});
