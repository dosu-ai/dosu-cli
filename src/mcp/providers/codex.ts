/**
 * Codex provider — CLI and desktop app share ~/.codex/config.toml (TOML format).
 * Simplified: we write JSON-style to a TOML-like structure using manual serialization.
 * For full parity, we'd need a TOML library. For now, use JSON config as Codex also supports it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { mcpBaseURL, mcpRemoteServer, mcpURL, writeSecureFile } from "../config-helpers";
import { expandHome, findNpx, isInstalled, npxPathEnv } from "../detect";
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
  writeSecureFile(path, content);
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function installDosuToTOML(path: string, cfg: Config): void {
  let content = readTOML(path);
  // Remove existing [mcp_servers.dosu] section if present (including the
  // legacy [mcp_servers.dosu.http_headers] subtable from the remote-HTTP form)
  content = removeDosuFromTOML(content);
  // Codex desktop only renders MCP Apps (the Session Knowledge card) for
  // locally spawned stdio servers — a remote-HTTP entry serves tools fine
  // but never shows the card — so proxy the endpoint through `npx
  // mcp-remote`. Revert to the remote-HTTP form (type = "http" + url +
  // http_headers) once Codex desktop renders MCP Apps from remote servers
  // (no upstream issue tracks that as of 2026-08; closest is the closed
  // feature request openai/codex#28912). npx is written by absolute path
  // with an explicit PATH because this config is shared with Codex desktop,
  // which launches from the Dock with the minimal launchd PATH — the same
  // pitfall as Claude Desktop.
  const npx = findNpx();
  const remote = mcpRemoteServer(mcpEndpoint(cfg), cfg.active_account?.target?.api_key);
  const env: Record<string, string> = { PATH: npxPathEnv(npx), ...remote.env };
  const envEntries = Object.entries(env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join("\n");
  const args = remote.args.map(tomlString).join(", ");
  const section =
    `\n[mcp_servers.dosu]\ncommand = ${tomlString(npx)}\nargs = [${args}]\n` +
    `\n[mcp_servers.dosu.env]\n${envEntries}\n`;
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
  name: () => "Codex (CLI + Desktop)",
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
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    installDosuToTOML(getConfigPath(global), cfg);
  },
  remove(global: boolean): void {
    const path = getConfigPath(global);
    const content = readTOML(path);
    if (content) writeTOML(path, removeDosuFromTOML(content));
  },
});
