/** Codex provider: CLI and desktop share ~/.codex/config.toml, plus a project-local
 * .codex/config.toml when the cwd has one. Codex merges the two per-key *inside* each
 * `mcp_servers.<name>` table, so both scopes must agree on the entry's shape. Written via
 * minimal manual TOML serialization instead of a TOML library. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { mcpEndpoint, mcpRemoteServer, writeSecureFile } from "../config-helpers";
import { expandHome, findNpx, isInstalled, npxPathEnv } from "../detect";
import type { SetupProvider } from "../providers";

function codexHome(): string {
  return process.env.CODEX_HOME ?? expandHome("~/.codex");
}

function getConfigPath(global: boolean): string {
  if (global) return join(codexHome(), "config.toml");
  return join(process.cwd(), ".codex", "config.toml");
}

/** Minimal TOML read/write, just enough to add/remove the [mcp_servers.dosu] entry. */
function readTOML(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function writeTOML(path: string, content: string): void {
  writeSecureFile(path, content);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function installDosuToTOML(path: string, cfg: Config): void {
  let content = readTOML(path);
  // Remove existing [mcp_servers.dosu] section if present (including the
  // legacy [mcp_servers.dosu.http_headers] subtable from the remote-HTTP form)
  content = removeDosuFromTOML(content);
  // Codex desktop only renders MCP Apps for stdio servers, so proxy through `npx mcp-remote`;
  // npx is absolute with explicit PATH because desktop launches with the minimal launchd PATH.
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

/** Keys that only ever appear on the remote-HTTP form of an MCP entry. */
const REMOTE_HTTP_KEY = /^(url|type|bearer_token_env_var)\s*=/;

/** Is the dosu entry here the legacy remote-HTTP form? Only the root [mcp_servers.dosu] table is
 * scanned for marker keys — [.env] holds arbitrary variable names and must not match against them. */
function hasRemoteHTTPForm(content: string): boolean {
  let inDosuRoot = false;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      // The http_headers subtable exists only on the remote-HTTP form.
      if (/^\[mcp_servers\.dosu\.http_headers]$/.test(trimmed)) return true;
      inDosuRoot = /^\[mcp_servers\.dosu]$/.test(trimmed);
      continue;
    }
    if (inDosuRoot && REMOTE_HTTP_KEY.test(trimmed)) return true;
  }
  return false;
}

/** Drop a legacy remote-HTTP dosu entry from the scope we are *not* writing. Codex merges
 * mcp_servers.dosu per-key across both configs, so such a leftover lands in the same table as the
 * stdio entry we just wrote; Codex resolves that table as stdio, rejects the stray `url`, and fails
 * to load the whole bootstrap config — taking every MCP server down, not just dosu. A *stdio* entry
 * in the other scope is left alone: it merges cleanly, and a local one is a per-repo override. */
function pruneLegacyRemoteEntry(path: string): void {
  if (!existsSync(path)) return;
  const content = readTOML(path);
  if (!hasRemoteHTTPForm(content)) return;
  writeTOML(path, removeDosuFromTOML(content));
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
    pruneLegacyRemoteEntry(getConfigPath(!global));
  },
  remove(global: boolean): void {
    const path = getConfigPath(global);
    const content = readTOML(path);
    if (content) writeTOML(path, removeDosuFromTOML(content));
  },
});
