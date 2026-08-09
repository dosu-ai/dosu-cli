/**
 * Codex provider — CLI and desktop app share ~/.codex/config.toml (TOML format).
 * Simplified: we write JSON-style to a TOML-like structure using manual serialization.
 * For full parity, we'd need a TOML library. For now, use JSON config as Codex also supports it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { type Config, MODE_OSS } from "../../config/config";
import {
  isExactProjectCodexProxy,
  type ProjectProxyExpectation,
  planCodexDosuMcp,
} from "../../migration/planners";
import { assertSafeProjectPath } from "../../setup/project-path";
import { VERSION } from "../../version/version";
import {
  mcpBaseURL,
  mcpRemoteServer,
  mcpURL,
  type ProjectFileMutationReceipt,
  writeProjectFile,
  writeSecureFile,
} from "../config-helpers";
import { expandHome, findNpx, isInstalled, npxPathEnv } from "../detect";
import {
  buildProjectProxyCommand,
  ownedProjectProxyOptionsFromEntry,
  sameProjectProxyTarget,
} from "../project-proxy";
import type { SetupProvider } from "../providers";

function codexHome(): string {
  return process.env.CODEX_HOME ?? expandHome("~/.codex");
}

function getConfigPath(global: boolean, projectRoot?: string): string {
  if (global) return join(codexHome(), "config.toml");
  if (!projectRoot) throw new Error("Codex project installation requires a verified project root");
  return join(projectRoot, ".codex", "config.toml");
}

/**
 * Minimal TOML read/write for the Codex mcp_servers section.
 * We parse just enough to add/remove the [mcp_servers.dosu] entry.
 */
function readTOML(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

function writeTOML(
  path: string,
  content: string,
  global: boolean,
  expectedProjectContent?: string | null,
): ProjectFileMutationReceipt | undefined {
  if (global) writeSecureFile(path, content);
  else return writeProjectFile(path, content, expectedProjectContent);
}

function mcpEndpoint(cfg: Config): string {
  if (cfg.mode === MODE_OSS) return mcpBaseURL();
  if (!cfg.active_account?.target?.deployment_id) throw new Error("deployment ID is required");
  return mcpURL(cfg.active_account?.target?.deployment_id);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function projectExpectation(cfg: Config): ProjectProxyExpectation {
  if (cfg.mode === MODE_OSS) return { packageVersion: VERSION, oss: true };
  const deploymentID = cfg.active_account?.target?.deployment_id;
  if (!deploymentID) throw new Error("deployment ID is required");
  return { packageVersion: VERSION, deploymentID };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existingProjectTarget(content: string): {
  present: boolean;
  target: ReturnType<typeof ownedProjectProxyOptionsFromEntry>;
} {
  if (!content.trim()) return { present: false, target: null };
  try {
    const parsed: unknown = parseToml(content);
    if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) {
      return { present: false, target: null };
    }
    if (!Object.hasOwn(parsed.mcp_servers, "dosu")) return { present: false, target: null };
    return {
      present: true,
      target: ownedProjectProxyOptionsFromEntry(parsed.mcp_servers.dosu),
    };
  } catch {
    return { present: true, target: null };
  }
}

function removeOwnedDosuFromTOML(content: string): string {
  const plan = planCodexDosuMcp(content, {
    projectProxy: "any",
    allowLegacyGlobal: true,
  });
  if (plan.disposition === "preserved_ambiguous") {
    throw new Error("Found a non-Dosu or ambiguous Codex server named dosu; refusing to modify it");
  }
  return plan.disposition === "remove" ? (plan.nextContent ?? content) : content;
}

function installDosuToTOML(
  path: string,
  cfg: Config,
  global: boolean,
  allowProjectRetarget = false,
): ProjectFileMutationReceipt | undefined {
  const projectFileExisted = !global && existsSync(path);
  let content = readTOML(path);
  const originalContent = content;
  if (!global) {
    const current = existingProjectTarget(content);
    const expectation = projectExpectation(cfg);
    const desired = expectation.oss
      ? ({ oss: true } as const)
      : { deploymentID: expectation.deploymentID };
    if (
      current.present &&
      !allowProjectRetarget &&
      (!current.target || !sameProjectProxyTarget(current.target, desired))
    ) {
      throw new Error(
        "Existing Codex project MCP targets something else; refusing to retarget. " +
          "Pass an explicit deployment to retarget it",
      );
    }
  }
  content = removeOwnedDosuFromTOML(content);
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
    const expectation = projectExpectation(cfg);
    const command = buildProjectProxyCommand(cfg);
    const args = command.args.map(tomlString).join(", ");
    section = `\n[mcp_servers.dosu]\ncommand = ${tomlString(command.command)}\nargs = [${args}]\n`;
    if (command.args[1] !== `@dosu/cli@${expectation.packageVersion}`) {
      throw new Error("Project proxy version mismatch");
    }
  }
  content += section;
  return writeTOML(path, content, global, projectFileExisted ? originalContent : null);
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
    return planCodexDosuMcp(content).disposition === "remove";
  },
  projectConfigPath: (projectRoot) => join(projectRoot, ".codex", "config.toml"),
  isProjectConfigured: (projectRoot) => {
    const content = readTOML(join(projectRoot, ".codex", "config.toml"));
    return isExactProjectCodexProxy(content);
  },
  install(cfg: Config, global: boolean, opts = {}) {
    if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id)
      throw new Error("deployment ID is required");
    const path = getConfigPath(global, opts.projectRoot);
    if (!global) assertSafeProjectPath(opts.projectRoot as string, path);
    return installDosuToTOML(path, cfg, global, opts.allowProjectRetarget);
  },
  remove(global: boolean, opts = {}) {
    const path = getConfigPath(global, opts.projectRoot);
    if (!global) assertSafeProjectPath(opts.projectRoot as string, path);
    const content = readTOML(path);
    if (content) return writeTOML(path, removeOwnedDosuFromTOML(content), global, content);
  },
});
