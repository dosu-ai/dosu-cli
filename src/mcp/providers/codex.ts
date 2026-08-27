/** Codex provider — CLI and desktop app share TOML configuration. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AST, parseTOML } from "toml-eslint-parser";
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

function parseConfigTOML(content: string): AST.TOMLProgram {
  try {
    return parseTOML(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex TOML: ${detail}`);
  }
}

function tableNodes(program: AST.TOMLProgram): AST.TOMLTable[] {
  return program.body[0].body.filter((node): node is AST.TOMLTable => node.type === "TOMLTable");
}

function isDosuTable(table: AST.TOMLTable): boolean {
  return table.resolvedKey[0] === "mcp_servers" && table.resolvedKey[1] === "dosu";
}

function dosuTables(program: AST.TOMLProgram): AST.TOMLTable[] {
  return tableNodes(program).filter(isDosuTable);
}

function keyParts(node: AST.TOMLKeyValue): string[] {
  return node.key.keys.map((key) => String(key.type === "TOMLBare" ? key.name : key.value));
}

function isDosuKey(parts: readonly string[]): boolean {
  return parts[0] === "mcp_servers" && parts[1] === "dosu";
}

/** Detect valid TOML forms that would collide with `[mcp_servers.dosu]`. */
function hasAlternateDosuDefinition(program: AST.TOMLProgram): boolean {
  for (const node of program.body[0].body) {
    if (node.type === "TOMLKeyValue") {
      const parts = keyParts(node);
      if (isDosuKey(parts)) return true;
      // TOML inline tables are closed: appending `[mcp_servers.dosu]` after
      // `mcp_servers = { ... }` would redefine the root key and corrupt an
      // otherwise valid config, whether or not we can inspect its children.
      if (
        parts.length === 1 &&
        parts[0] === "mcp_servers" &&
        node.value.type === "TOMLInlineTable"
      ) {
        return true;
      }
    }
    if (node.type !== "TOMLTable" || isDosuTable(node)) continue;
    for (const entry of node.body) {
      if (isDosuKey([...node.resolvedKey.map(String), ...keyParts(entry)])) return true;
    }
  }
  return false;
}

function keyName(node: AST.TOMLKeyValue): string | undefined {
  if (node.key.keys.length !== 1) return undefined;
  const key = node.key.keys[0];
  return key.type === "TOMLBare" ? key.name : key.value;
}

function stringValue(node: AST.TOMLContentNode): string | undefined {
  return node.type === "TOMLValue" && node.kind === "string" ? node.value : undefined;
}

function stringArray(node: AST.TOMLContentNode): string[] | undefined {
  if (node.type !== "TOMLArray") return undefined;
  const values = node.elements.map(stringValue);
  return values.every((value): value is string => value !== undefined) ? values : undefined;
}

function isOwnedProjectSection(program: AST.TOMLProgram): boolean {
  const base = dosuTables(program).find((table) => table.resolvedKey.length === 2);
  if (!base) return false;
  const commandNode = base.body.find((node) => keyName(node) === "command");
  const argsNode = base.body.find((node) => keyName(node) === "args");
  if (!commandNode || !argsNode) return false;
  const command = stringValue(commandNode.value);
  const args = stringArray(argsNode.value);
  return Boolean(command && args && isDosuOwnedMcpServer({ command, args }));
}

function removeDosuTables(content: string, tables: readonly AST.TOMLTable[]): string {
  let result = content;
  for (const table of [...tables].sort((left, right) => right.range[0] - left.range[0])) {
    let end = table.range[1];
    if (result.startsWith("\r\n", end)) end += 2;
    else if (result.startsWith("\n", end)) end += 1;
    result = result.slice(0, table.range[0]) + result.slice(end);
  }
  return result;
}

function lineEndingFor(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function upsertDosuTables(
  content: string,
  tables: readonly AST.TOMLTable[],
  section: string,
  lineEnding: "\r\n" | "\n",
): string {
  if (tables.length === 0) {
    if (!content) return section;
    const separator = content.endsWith(`${lineEnding}${lineEnding}`)
      ? ""
      : content.endsWith(lineEnding)
        ? lineEnding
        : `${lineEnding}${lineEnding}`;
    return `${content}${separator}${section}`;
  }

  const insertion = Math.min(...tables.map((table) => table.range[0]));
  const withoutDosu = removeDosuTables(content, tables);
  return `${withoutDosu.slice(0, insertion)}${section}${withoutDosu.slice(insertion)}`;
}

function installDosuToTOML(path: string, cfg: Config, global: boolean): void {
  let content = readTOML(path);
  const lineEnding = lineEndingFor(content);
  const parsed = parseConfigTOML(content);
  if (hasAlternateDosuDefinition(parsed)) {
    throw new Error(
      'Codex already declares "mcp_servers.dosu" in an alternate TOML form; refusing to overwrite it',
    );
  }
  const existingTables = dosuTables(parsed);
  if (!global && existingTables.length > 0 && !isOwnedProjectSection(parsed)) {
    throw new Error(
      'Codex already has a non-Dosu MCP server named "dosu"; refusing to overwrite it',
    );
  }
  // Remove existing [mcp_servers.dosu] section if present (including the
  // legacy [mcp_servers.dosu.http_headers] subtable from the remote-HTTP form)
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
      .join(lineEnding);
    const args = remote.args.map(tomlString).join(", ");
    section =
      `[mcp_servers.dosu]${lineEnding}` +
      `command = ${tomlString(npx)}${lineEnding}` +
      `args = [${args}]${lineEnding}${lineEnding}` +
      `[mcp_servers.dosu.env]${lineEnding}${envEntries}${lineEnding}`;
  } else {
    const command = buildProjectProxyCommand(cfg);
    const args = command.args.map(tomlString).join(", ");
    section =
      `[mcp_servers.dosu]${lineEnding}` +
      `command = ${tomlString(command.command)}${lineEnding}` +
      `args = [${args}]${lineEnding}`;
  }
  content = upsertDosuTables(content, existingTables, section, lineEnding);
  writeTOML(path, content);
}

export const CodexProvider = (): SetupProvider => ({
  // Project .codex/config.toml is documented for Codex CLI and the IDE extension.
  // Do not imply that Codex Desktop currently honors project MCP configuration.
  name: () => "Codex",
  id: () => "codex",
  configurationKind: () => "project",
  priority: () => 8,
  detectPaths: () => ["~/.codex"],
  isInstalled: () => isInstalled(["~/.codex"]),
  globalConfigPath: () => join(codexHome(), "config.toml"),
  isConfigured: () => {
    const content = readTOML(join(codexHome(), "config.toml"));
    try {
      return dosuTables(parseConfigTOML(content)).length > 0;
    } catch {
      return false;
    }
  },
  projectConfigPath: (projectRoot: string) => join(projectRoot, ".codex", "config.toml"),
  isProjectConfigured: (projectRoot: string) => {
    try {
      return isOwnedProjectSection(parseConfigTOML(readTOML(getConfigPath(false, projectRoot))));
    } catch {
      return false;
    }
  },
  install(cfg: Config, opts): void {
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    const global = opts.scope === "global";
    installDosuToTOML(getConfigPath(global, opts.projectRoot), cfg, global);
  },
  remove(opts): void {
    const global = opts.scope === "global";
    const path = getConfigPath(global, opts.projectRoot);
    const content = readTOML(path);
    if (!content) return;
    const parsed = parseConfigTOML(content);
    if (hasAlternateDosuDefinition(parsed)) {
      throw new Error(
        'Codex declares "mcp_servers.dosu" in an alternate TOML form; refusing to remove it',
      );
    }
    const existingTables = dosuTables(parsed);
    if (!global && existingTables.length > 0 && !isOwnedProjectSection(parsed)) {
      throw new Error('Codex has a non-Dosu MCP server named "dosu"; refusing to remove it');
    }
    if (existingTables.length > 0) writeTOML(path, removeDosuTables(content, existingTables));
  },
});
