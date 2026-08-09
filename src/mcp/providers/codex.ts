/**
 * Codex provider — CLI and desktop app share ~/.codex/config.toml (TOML format).
 * Simplified: we write JSON-style to a TOML-like structure using manual serialization.
 * For full parity, we'd need a TOML library. For now, use JSON config as Codex also supports it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, MODE_OSS } from "../../config/config";
import { assertSafeProjectPath } from "../../setup/project-root";
import { mcpBaseURL, mcpRemoteServer, mcpURL, writeSecureFile } from "../config-helpers";
import { expandHome, findNpx, isInstalled, npxPathEnv } from "../detect";
import { buildProjectProxyCommand, isDosuOwnedMcpServer } from "../project-proxy";
import type { SetupProvider } from "../providers";

function codexHome(): string {
  return process.env.CODEX_HOME ?? expandHome("~/.codex");
}

function getConfigPath(global: boolean, projectRoot?: string): string {
  if (global) return join(codexHome(), "config.toml");
  if (!projectRoot) {
    throw new Error("Codex project installation requires an explicit project root");
  }
  const path = join(projectRoot, ".codex", "config.toml");
  assertSafeProjectPath(projectRoot, path);
  return path;
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

function hasDosuSection(content: string): boolean {
  return content.split("\n").some((line) => /^\[mcp_servers\.dosu(?:\..*)?]$/.test(line.trim()));
}

function isOwnedProjectSection(content: string): boolean {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.dosu]");
  if (start < 0) return false;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    body.push(line);
  }
  const text = body.join("\n");
  const commandMatch = text.match(/^command\s*=\s*("(?:\\.|[^"])*")\s*$/m);
  const argsMatch = text.match(/^args\s*=\s*(\[[^\n]*])\s*$/m);
  if (!commandMatch || !argsMatch) return false;
  try {
    return isDosuOwnedMcpServer({
      command: JSON.parse(commandMatch[1]),
      args: JSON.parse(argsMatch[1]),
    });
  } catch {
    return false;
  }
}

function installDosuToTOML(path: string, cfg: Config, global: boolean): void {
  let content = readTOML(path);
  if (!global && hasDosuSection(content) && !isOwnedProjectSection(content)) {
    throw new Error(
      'Codex already has a non-Dosu MCP server named "dosu"; refusing to overwrite it',
    );
  }
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
  let section: string;
  if (global) {
    const npx = findNpx();
    const remote = mcpRemoteServer(mcpEndpoint(cfg), cfg.active_account?.target?.api_key);
    const env: Record<string, string> = { PATH: npxPathEnv(npx), ...remote.env };
    const envEntries = Object.entries(env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join("\n");
    const args = remote.args.map(tomlString).join(", ");
    section =
      `\n[mcp_servers.dosu]\ncommand = ${tomlString(npx)}\nargs = [${args}]\n` +
      `\n[mcp_servers.dosu.env]\n${envEntries}\n`;
  } else {
    const command = buildProjectProxyCommand(cfg);
    const args = command.args.map(tomlString).join(", ");
    section = `\n[mcp_servers.dosu]\ncommand = ${tomlString(command.command)}\nargs = [${args}]\n`;
  }
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
  // Project .codex/config.toml is documented for Codex CLI and the IDE extension.
  // Do not imply that Codex Desktop currently honors project MCP configuration.
  name: () => "Codex",
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
  projectConfigPath: (projectRoot: string) => join(projectRoot, ".codex", "config.toml"),
  isProjectConfigured: (projectRoot: string) =>
    isOwnedProjectSection(readTOML(getConfigPath(false, projectRoot))),
  install(cfg: Config, global: boolean, opts = {}): void {
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    installDosuToTOML(getConfigPath(global, opts.projectRoot), cfg, global);
  },
  remove(global: boolean, opts = {}): void {
    const path = getConfigPath(global, opts.projectRoot);
    const content = readTOML(path);
    if (!content) return;
    if (!global && hasDosuSection(content) && !isOwnedProjectSection(content)) {
      throw new Error('Codex has a non-Dosu MCP server named "dosu"; refusing to remove it');
    }
    if (hasDosuSection(content)) writeTOML(path, removeDosuFromTOML(content));
  },
});
