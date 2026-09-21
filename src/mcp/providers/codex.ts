/** Codex provider: CLI and desktop share ~/.codex/config.toml, plus a project-local
 * .codex/config.toml when the cwd has one. Codex merges the two per-key *inside* each
 * `mcp_servers.<name>` table, so both scopes must agree on the entry's shape. Written via
 * minimal manual TOML serialization instead of a TOML library. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** The table name from a TOML section header, tolerating a trailing comment and TOML's optional
 * inner whitespace: `[ mcp_servers.dosu ] # override` -> `mcp_servers.dosu`. Null if not a header. */
function sectionName(line: string): string | null {
  const match = line.trim().match(/^\[([^\]]*)]\s*(?:#.*)?$/);
  return match ? match[1].trim() : null;
}

function isDosuSection(name: string): boolean {
  return name === "mcp_servers.dosu" || name.startsWith("mcp_servers.dosu.");
}

function removeDosuFromTOML(content: string): string {
  // Remove [mcp_servers.dosu] and [mcp_servers.dosu.*] sections
  const result: string[] = [];
  let inDosuSection = false;

  for (const line of content.split("\n")) {
    const name = sectionName(line);
    if (name !== null) {
      inDosuSection = isDosuSection(name);
      if (inDosuSection) continue;
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
    const name = sectionName(line);
    if (name !== null) {
      // The http_headers subtable exists only on the remote-HTTP form.
      if (name === "mcp_servers.dosu.http_headers") return true;
      inDosuRoot = name === "mcp_servers.dosu";
      continue;
    }
    if (inDosuRoot && REMOTE_HTTP_KEY.test(line.trim())) return true;
  }
  return false;
}

/** Every .codex/config.toml Codex merges for the cwd. Codex walks from the project root — the
 * nearest ancestor holding a .git marker — down to the working directory and loads each one, so a
 * legacy entry at the repo root still conflicts when setup runs from a subdirectory. */
function projectConfigPaths(): string[] {
  const cwd = process.cwd();
  const chain: string[] = [];
  for (let dir = cwd; ; ) {
    chain.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    // No project root marker anywhere above: Codex treats the cwd as the only project layer.
    if (parent === dir) return [join(cwd, ".codex", "config.toml")];
    dir = parent;
  }
  return chain.reverse().map((dir) => join(dir, ".codex", "config.toml"));
}

/** Drop a legacy remote-HTTP dosu entry from a config layer we are not writing. Codex merges
 * mcp_servers.dosu per-key across every layer, so such a leftover lands in the same table as the
 * stdio entry we just wrote; Codex resolves that table as stdio, rejects the stray `url`, and fails
 * to load the whole bootstrap config — taking every MCP server down, not just dosu. A *stdio* entry
 * in another layer is left alone: it merges cleanly, and a project one is a per-repo override. */
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
    // A project-local install must never rewrite the global config — other projects rely on that
    // entry and on its deployment — but a legacy entry there merges into ours and breaks Codex
    // outright. Stop with the remedy rather than silently deleting it or writing a broken config.
    if (!global && hasRemoteHTTPForm(readTOML(getConfigPath(true)))) {
      throw new Error(
        "the global Codex config still holds the legacy remote-HTTP Dosu entry, which Codex would " +
          "merge with a project-local entry and reject. Migrate it first with " +
          "`dosu mcp add codex --global`, then re-run this.",
      );
    }
    const written = getConfigPath(global);
    installDosuToTOML(written, cfg);
    for (const path of projectConfigPaths()) {
      if (path !== written) pruneLegacyRemoteEntry(path);
    }
  },
  remove(global: boolean): void {
    const path = getConfigPath(global);
    const content = readTOML(path);
    if (content) writeTOML(path, removeDosuFromTOML(content));
  },
});
