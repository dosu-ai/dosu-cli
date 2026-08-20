import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadJSONConfig, saveJSONConfig, writeSecureFile } from "../mcp/config-helpers";

/* v8 ignore start -- External agent config mutation is verified by isolated config and packaged E2E. */

export type DriveMcpAgent = "codex" | "claude";

export interface DriveMcpConfigStatus {
  agent: DriveMcpAgent;
  configured: boolean;
  path: string;
}

export function installDriveMcp(agent: string): DriveMcpConfigStatus {
  const selected = parseAgent(agent);
  const invocation = driveInvocation();
  if (selected === "codex") installCodex(invocation);
  else installClaude(invocation);
  return driveMcpConfigStatus(selected);
}

export function removeDriveMcp(agent: string): DriveMcpConfigStatus {
  const selected = parseAgent(agent);
  if (selected === "codex") removeCodex();
  else removeClaude();
  return driveMcpConfigStatus(selected);
}

export function driveMcpConfigStatus(agent: DriveMcpAgent): DriveMcpConfigStatus {
  const path = agent === "codex" ? codexConfigPath() : claudeConfigPath();
  if (!existsSync(path)) return { agent, configured: false, path };
  if (agent === "codex") {
    return {
      agent,
      configured: readFileSync(path, "utf8").includes("[mcp_servers.dosu-drive]"),
      path,
    };
  }
  const config = loadJSONConfig(path);
  return {
    agent,
    configured: isRecord(config.mcpServers) && isRecord(config.mcpServers["dosu-drive"]),
    path,
  };
}

export function removeDriveMcpFromToml(content: string): string {
  const lines = content.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  let owned = false;
  let output = "";
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)]$/)?.[1];
    if (section)
      owned = section === "mcp_servers.dosu-drive" || section.startsWith("mcp_servers.dosu-drive.");
    if (!owned) output += line;
  }
  return output;
}

function installCodex(invocation: DriveInvocation): void {
  const path = codexConfigPath();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  let content = removeDriveMcpFromToml(current);
  if (content && !content.endsWith("\n")) content += "\n";
  if (content && !content.endsWith("\n\n")) content += "\n";
  content += `[mcp_servers.dosu-drive]\ncommand = ${tomlString(invocation.command)}\nargs = [${invocation.args.map(tomlString).join(", ")}]\n`;
  if (Object.keys(invocation.env).length > 0) {
    content += `\n[mcp_servers.dosu-drive.env]\n${Object.entries(invocation.env)
      .map(([key, value]) => `${key} = ${tomlString(value)}`)
      .join("\n")}\n`;
  }
  writeSecureFile(path, content);
}

function removeCodex(): void {
  const path = codexConfigPath();
  if (!existsSync(path)) return;
  const current = readFileSync(path, "utf8");
  const next = removeDriveMcpFromToml(current);
  if (next !== current) writeSecureFile(path, next);
}

function installClaude(invocation: DriveInvocation): void {
  const path = claudeConfigPath();
  const config = loadJSONConfig(path);
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  servers["dosu-drive"] = {
    command: invocation.command,
    args: invocation.args,
    ...(Object.keys(invocation.env).length > 0 ? { env: invocation.env } : {}),
  };
  config.mcpServers = servers;
  saveJSONConfig(path, config);
}

function removeClaude(): void {
  const path = claudeConfigPath();
  if (!existsSync(path)) return;
  const config = loadJSONConfig(path);
  if (isRecord(config.mcpServers)) delete config.mcpServers["dosu-drive"];
  saveJSONConfig(path, config);
}

interface DriveInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function driveInvocation(): DriveInvocation {
  const suffix = ["drive", "mcp", "serve"];
  const env: Record<string, string> = {};
  if (process.env.DOSU_DRIVE_HOME) env.DOSU_DRIVE_HOME = process.env.DOSU_DRIVE_HOME;
  const override = process.env.DOSU_DRIVE_EXECUTABLE;
  if (override) return { command: override, args: suffix, env };

  const entry = process.argv[1];
  if (entry && /\.(?:cjs|mjs|js|ts)$/.test(entry)) {
    return { command: process.execPath, args: [entry, ...suffix], env };
  }
  if (entry && basename(entry).startsWith("dosu")) {
    return { command: entry, args: suffix, env };
  }
  return { command: process.execPath, args: suffix, env };
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
}

function claudeConfigPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");
}

function parseAgent(agent: string): DriveMcpAgent {
  if (agent === "codex" || agent === "claude") return agent;
  throw new Error("Drive MCP agent must be `codex` or `claude`");
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/* v8 ignore stop */
