import { spawn as nodeSpawn } from "node:child_process";
import { win32 } from "node:path";
import { type Config, loadConfig, MODE_OSS, targetForDeployment } from "../config/config";
import { mcpBaseURL, mcpRemoteServer, mcpURL } from "./config-helpers";
import { findNpx, npxPathEnv } from "./detect";

export interface ProjectProxyOptions {
  deploymentID?: string;
  oss?: boolean;
}

export interface ProjectProxyCommand {
  command: "dosu";
  args: string[];
}

export interface ProjectProxyRuntime {
  endpoint: string;
  apiKey: string;
}

export type ProjectMcpTarget = { kind: "deployment"; deploymentID: string } | { kind: "oss" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectCommand(value: unknown): { command: string; args: string[] } | null {
  if (!isRecord(value)) return null;
  if (typeof value.command === "string" && Array.isArray(value.args)) {
    return value.args.every((arg) => typeof arg === "string")
      ? { command: value.command, args: value.args }
      : null;
  }
  if (Array.isArray(value.command) && value.command.every((arg) => typeof arg === "string")) {
    const [command, ...args] = value.command;
    return command ? { command, args } : null;
  }
  return null;
}

/** Extract the target only from an MCP entry shape written by a released Dosu CLI flow. */
export function projectMcpTarget(value: unknown): ProjectMcpTarget | null {
  if (!isRecord(value)) return null;

  const command = projectCommand(value);
  if (command?.command === "dosu") {
    const [mcp, proxy, targetFlag, targetValue] = command.args;
    if (mcp === "mcp" && proxy === "proxy") {
      if (targetFlag === "--oss" && targetValue === undefined && command.args.length === 3) {
        return { kind: "oss" };
      }
      if (
        targetFlag === "--deployment" &&
        targetValue !== undefined &&
        command.args.length === 4 &&
        SAFE_DEPLOYMENT_ID.test(targetValue)
      ) {
        return { kind: "deployment", deploymentID: targetValue };
      }
    }
  }
  if (command?.command === "npx") {
    const [yes, cliPackage, mcp, proxy, targetFlag, targetValue] = command.args;
    const releasedPrefix =
      yes === "-y" &&
      typeof cliPackage === "string" &&
      /^@dosu\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(cliPackage) &&
      mcp === "mcp" &&
      proxy === "proxy";
    if (releasedPrefix) {
      if (targetFlag === "--oss" && targetValue === undefined && command.args.length === 5) {
        return { kind: "oss" };
      }
      if (
        targetFlag === "--deployment" &&
        targetValue !== undefined &&
        command.args.length === 6 &&
        SAFE_DEPLOYMENT_ID.test(targetValue)
      ) {
        return { kind: "deployment", deploymentID: targetValue };
      }
    }
  }

  return null;
}

/** True only for an MCP entry shape written by a released Dosu CLI flow. */
export function isDosuOwnedMcpServer(value: unknown): boolean {
  return projectMcpTarget(value) !== null;
}

interface SpawnedProxy {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

type SpawnProxy = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; shell: boolean; env: NodeJS.ProcessEnv },
) => SpawnedProxy;

export interface ProjectProxyDependencies {
  loadConfig?: () => Config;
  findNpx?: () => string;
  platform?: NodeJS.Platform;
  spawn?: SpawnProxy;
}

// This ID crosses a shell boundary on Windows because npx.cmd requires one.
// Keep project-controlled input narrower than cmd.exe's metacharacter set.
const SAFE_DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WINDOWS_SHELL_METACHARACTERS = /[\s"&|<>()^%!]/;

export function isSafeDeploymentID(value: unknown): value is string {
  return typeof value === "string" && SAFE_DEPLOYMENT_ID.test(value);
}

function requireSafeDeploymentID(value: unknown): string {
  if (!isSafeDeploymentID(value)) {
    throw new Error("Invalid project deployment ID. Re-run `dosu setup` in this project.");
  }
  return value;
}

function requireOneTarget(options: ProjectProxyOptions): void {
  if (Boolean(options.deploymentID) === Boolean(options.oss)) {
    throw new Error("Exactly one project MCP target is required.");
  }
}

function requireSafeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Invalid Dosu MCP endpoint. Re-run `dosu setup`.");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username ||
    endpoint.password ||
    WINDOWS_SHELL_METACHARACTERS.test(value)
  ) {
    throw new Error("Invalid Dosu MCP endpoint. Re-run `dosu setup`.");
  }
  return value;
}

/** Build the exact, secretless command written into project MCP files. */
export function buildProjectProxyCommand(cfg: Config): ProjectProxyCommand {
  const args = ["mcp", "proxy"];
  if (cfg.mode === MODE_OSS) {
    args.push("--oss");
  } else {
    args.push("--deployment", requireSafeDeploymentID(cfg.active_account?.target?.deployment_id));
  }
  return { command: "dosu", args };
}

/** Resolve runtime secrets only from the one active, private Dosu config. */
export function resolveProjectProxyRuntime(
  cfg: Config,
  options: ProjectProxyOptions,
): ProjectProxyRuntime {
  requireOneTarget(options);

  let endpoint: string;
  if (options.oss) {
    if (cfg.mode !== MODE_OSS) {
      throw new Error(
        "This project expects OSS mode, but Dosu is not configured for OSS mode. Re-run `dosu setup` in this project.",
      );
    }
    endpoint = requireSafeEndpoint(mcpBaseURL());
  } else {
    const deploymentID = requireSafeDeploymentID(options.deploymentID);
    const target = targetForDeployment(cfg, deploymentID);
    if (!target)
      throw new Error(
        "No credential is stored for this project's Dosu MCP. Re-run `dosu setup` in this project.",
      );
    endpoint = requireSafeEndpoint(mcpURL(deploymentID));
    const apiKey = target.api_key;
    if (!apiKey) {
      throw new Error("Dosu API key is missing. Re-run `dosu setup` in this project.");
    }
    return { endpoint, apiKey };
  }

  const apiKey = cfg.active_account?.target?.api_key;
  if (!apiKey) {
    throw new Error("Dosu API key is missing. Re-run `dosu setup` in this project.");
  }
  return { endpoint, apiKey };
}

/** Run the existing pinned HTTP-to-stdio bridge. */
export async function runProjectProxy(
  options: ProjectProxyOptions,
  dependencies: ProjectProxyDependencies = {},
): Promise<number> {
  const runtime = resolveProjectProxyRuntime((dependencies.loadConfig ?? loadConfig)(), options);
  const npx = (dependencies.findNpx ?? findNpx)();
  const platform = dependencies.platform ?? process.platform;
  const remote = mcpRemoteServer(runtime.endpoint, runtime.apiKey);
  const executable = platform === "win32" ? win32.basename(npx) : npx;
  const child = (dependencies.spawn ?? (nodeSpawn as unknown as SpawnProxy))(
    executable,
    remote.args,
    {
      stdio: "inherit",
      shell: platform === "win32",
      env: {
        ...process.env,
        ...(platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {}),
        PATH: npxPathEnv(npx),
        ...remote.env,
      },
    },
  );

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}
