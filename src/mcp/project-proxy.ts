import { spawn as nodeSpawn } from "node:child_process";
import { win32 } from "node:path";
import type { Config } from "../config/config";
import { getConfigUserID, loadConfig, MODE_OSS, updateTarget } from "../config/config";
import { VERSION } from "../version/version";
import { mcpBaseURL, mcpRemoteServer, mcpURL } from "./config-helpers";
import { findNpx, npxPathEnv } from "./detect";
import {
  type KillProcessGroup,
  type SpawnTreeKiller,
  terminatePosixProcessTree,
  terminateWindowsProcessTree,
} from "./process-tree";
import {
  readProjectMcpCredential,
  type StoredProjectMcpCredential,
  saveProjectMcpCredential,
} from "./project-credential-store";

export interface ProjectProxyCommand {
  command: string;
  args: string[];
}

export interface ProjectProxyOptions {
  deploymentID?: string;
  oss?: boolean;
}

export interface ProjectProxyRuntime {
  endpoint: string;
  apiKey: string;
}

function credentialKey(opts: ProjectProxyOptions): string {
  if (Boolean(opts.deploymentID) === Boolean(opts.oss)) {
    throw new Error("Exactly one project MCP target is required. Re-run `dosu setup`.");
  }
  return opts.oss ? "oss" : `deployment:${requireSafeProjectDeploymentID(opts.deploymentID)}`;
}

interface SpawnedProcess {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): SpawnedProcess;
  once(event: "close", listener: (code: number | null) => void): SpawnedProcess;
  kill(signal: NodeJS.Signals): boolean;
}

type ProxySignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface SignalSource {
  once(event: ProxySignal, listener: () => void): unknown;
  removeListener(event: ProxySignal, listener: () => void): unknown;
}

type SpawnProxy = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; shell: boolean; detached: boolean },
) => SpawnedProcess;

export interface ProjectProxyDependencies {
  loadConfig?: () => Config;
  spawn?: SpawnProxy;
  signalSource?: SignalSource;
  platform?: NodeJS.Platform;
  findNpx?: () => string;
  spawnTreeKiller?: SpawnTreeKiller;
  killProcessGroup?: KillProcessGroup;
  killGraceMs?: number;
  shutdownDeadlineMs?: number;
  readCredential?: (input: {
    userID: string;
    targetKey: string;
  }) => StoredProjectMcpCredential | undefined;
}

export interface ProjectProxyRecordDependencies {
  saveCredential?: typeof saveProjectMcpCredential;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsProjectSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProjectSecretField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/_/g, "-");
    return normalized === "x-dosu-api-key" || containsProjectSecretField(child);
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactProjectProxyShape(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.command)) {
    return (
      hasExactKeys(value, ["type", "command", "enabled"]) &&
      value.type === "local" &&
      value.enabled === true
    );
  }
  if (hasExactKeys(value, ["command", "args"])) return true;
  if (hasExactKeys(value, ["type", "command", "args"])) return value.type === "stdio";
  if (hasExactKeys(value, ["command", "args", "env"])) {
    return isRecord(value.env) && Object.keys(value.env).length === 0;
  }
  return false;
}

function projectProxyParts(value: Record<string, unknown>): string[] | null {
  if (Array.isArray(value.command)) {
    if (value.command.some((part) => typeof part !== "string")) return null;
    return value.command as string[];
  }
  if (typeof value.command !== "string") return null;
  if (!Array.isArray(value.args) || value.args.some((part) => typeof part !== "string")) {
    return null;
  }
  return [value.command, ...(value.args as string[])];
}

function optionsFromParts(
  parts: readonly string[],
  packageSpec: string | RegExp,
): ProjectProxyOptions | null {
  const expectedPackage = parts[2];
  const packageMatches =
    typeof packageSpec === "string"
      ? expectedPackage === packageSpec
      : typeof expectedPackage === "string" && packageSpec.test(expectedPackage);
  const prefixMatches =
    parts[0] === "npx" &&
    parts[1] === "-y" &&
    packageMatches &&
    parts[3] === "mcp" &&
    parts[4] === "proxy";
  if (!prefixMatches) return null;
  const tail = parts.slice(5);
  if (tail.length === 1 && tail[0] === "--oss") return { oss: true };
  if (tail.length === 2 && tail[0] === "--deployment" && isSafeProjectDeploymentID(tail[1])) {
    return { deploymentID: tail[1] };
  }
  return null;
}

// Project deployment IDs cross a shell boundary on Windows because Node cannot
// execute npx.cmd directly. Keep the accepted syntax deliberately narrower
// than cmd.exe's metacharacter set before an ID can enter a checked-in command.
const SAFE_PROJECT_DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function isSafeProjectDeploymentID(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROJECT_DEPLOYMENT_ID.test(value);
}

function requireSafeProjectDeploymentID(value: unknown): string {
  if (!isSafeProjectDeploymentID(value)) {
    throw new Error("Invalid project deployment ID. Re-run `dosu setup`.");
  }
  return value;
}

/** Parse only the exact, current, secretless command emitted into project files. */
export function projectProxyOptionsFromEntry(value: unknown): ProjectProxyOptions | null {
  if (!isRecord(value) || !hasExactProjectProxyShape(value) || containsProjectSecretField(value)) {
    return null;
  }
  const parts = projectProxyParts(value);
  if (!parts) return null;
  return optionsFromParts(parts, `@dosu/cli@${VERSION}`);
}

/** Parse an exact secretless project proxy emitted by any released Dosu CLI version. */
export function ownedProjectProxyOptionsFromEntry(value: unknown): ProjectProxyOptions | null {
  if (!isRecord(value) || !hasExactProjectProxyShape(value) || containsProjectSecretField(value)) {
    return null;
  }
  const parts = projectProxyParts(value);
  if (!parts) return null;
  return optionsFromParts(parts, /^@dosu\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
}

export function isProjectProxyEntry(value: unknown): boolean {
  return projectProxyOptionsFromEntry(value) !== null;
}

function hasProviderProjectShape(providerID: string, value: Record<string, unknown>): boolean {
  switch (providerID) {
    case "gemini":
    case "antigravity":
    case "mcporter":
    case "codex":
      return hasExactKeys(value, ["command", "args"]);
    case "zed":
      return (
        hasExactKeys(value, ["command", "args", "env"]) &&
        isRecord(value.env) &&
        Object.keys(value.env).length === 0
      );
    case "opencode":
      return (
        hasExactKeys(value, ["type", "command", "enabled"]) &&
        value.type === "local" &&
        value.enabled === true
      );
    default:
      return hasExactKeys(value, ["type", "command", "args"]) && value.type === "stdio";
  }
}

export function isProjectProxyEntryForProvider(providerID: string, value: unknown): boolean {
  return (
    isRecord(value) &&
    hasProviderProjectShape(providerID, value) &&
    projectProxyOptionsFromEntry(value) !== null
  );
}

export function ownedProjectProxyOptionsForProvider(
  providerID: string,
  value: unknown,
): ProjectProxyOptions | null {
  return isRecord(value) && hasProviderProjectShape(providerID, value)
    ? ownedProjectProxyOptionsFromEntry(value)
    : null;
}

export function sameProjectProxyTarget(
  left: ProjectProxyOptions,
  right: ProjectProxyOptions,
): boolean {
  return left.oss === true
    ? right.oss === true
    : right.oss !== true && left.deploymentID === right.deploymentID;
}

// Only released production URLs prove that a historical HTTP entry belongs to
// Dosu. A matching path/header on localhost, staging, or a third-party origin
// is user-owned and must never be removed automatically.
const RELEASED_DOSU_MCP_ORIGIN = "https://api.dosu.dev";

function hasDosuMcpPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === RELEASED_DOSU_MCP_ORIGIN &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      (/^\/v1\/mcp$/.test(parsed.pathname) ||
        /^\/v1\/mcp\/deployments\/[^/]+$/.test(parsed.pathname))
    );
  } catch {
    return false;
  }
}

function hasBaseDosuMcpPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === RELEASED_DOSU_MCP_ORIGIN &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === "/v1/mcp"
    );
  } catch {
    return false;
  }
}

function hasExactDosuHeaders(value: Record<string, unknown>): boolean {
  const headers = isRecord(value.headers) ? value.headers : undefined;
  return Boolean(
    headers &&
      hasExactKeys(headers, ["X-Dosu-API-Key"]) &&
      typeof headers["X-Dosu-API-Key"] === "string" &&
      headers["X-Dosu-API-Key"].length > 0,
  );
}

function isStandardHttpEntry(value: Record<string, unknown>, baseOnly = false): boolean {
  return (
    hasExactKeys(value, ["type", "url", "headers"]) &&
    value.type === "http" &&
    hasExactDosuHeaders(value) &&
    (baseOnly ? hasBaseDosuMcpPath(value.url) : hasDosuMcpPath(value.url))
  );
}

/** Recognize entries written by released Dosu CLIs or by this project proxy. */
export function isDosuMcpEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isProjectProxyEntry(value)) return true;
  const parts = projectProxyParts(value);
  if (
    hasExactProjectProxyShape(value) &&
    !containsProjectSecretField(value) &&
    parts &&
    optionsFromParts(parts, /^@dosu\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  ) {
    return true;
  }

  const headers = isRecord(value.headers) ? value.headers : undefined;
  if (
    !headers ||
    !hasExactKeys(headers, ["X-Dosu-API-Key"]) ||
    typeof headers["X-Dosu-API-Key"] !== "string" ||
    headers["X-Dosu-API-Key"].length === 0
  ) {
    return false;
  }
  if (hasExactKeys(value, ["type", "url", "headers"])) {
    return value.type === "http" && hasDosuMcpPath(value.url);
  }
  if (hasExactKeys(value, ["url", "headers"])) return hasDosuMcpPath(value.url);
  if (hasExactKeys(value, ["type", "disabled", "url", "headers"])) {
    return value.type === "streamableHttp" && value.disabled === false && hasDosuMcpPath(value.url);
  }
  if (hasExactKeys(value, ["type", "enabled", "url", "headers"])) {
    return value.type === "remote" && value.enabled === true && hasDosuMcpPath(value.url);
  }
  if (hasExactKeys(value, ["source", "type", "url", "headers"])) {
    return value.source === "custom" && value.type === "http" && hasDosuMcpPath(value.url);
  }
  if (hasExactKeys(value, ["serverUrl", "headers"])) return hasDosuMcpPath(value.serverUrl);
  if (hasExactKeys(value, ["type", "url", "tools", "headers"])) {
    return (
      value.type === "http" &&
      hasDosuMcpPath(value.url) &&
      Array.isArray(value.tools) &&
      value.tools.length === 1 &&
      value.tools[0] === "*"
    );
  }
  return false;
}

/** Provider-specific ownership used before replacing or removing a project entry. */
export function isDosuMcpEntryForProvider(providerID: string, value: unknown): boolean {
  if (!isRecord(value)) return false;

  const parts = projectProxyParts(value);
  if (
    hasProviderProjectShape(providerID, value) &&
    !containsProjectSecretField(value) &&
    parts &&
    optionsFromParts(parts, /^@dosu\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  ) {
    return true;
  }

  switch (providerID) {
    case "claude":
    case "vscode":
    case "gemini":
    case "factory":
    case "mcporter":
      return isStandardHttpEntry(value);
    case "cursor":
      return (
        (hasExactKeys(value, ["url", "headers"]) &&
          hasExactDosuHeaders(value) &&
          hasDosuMcpPath(value.url)) ||
        isStandardHttpEntry(value, true)
      );
    case "opencode":
      return (
        (hasExactKeys(value, ["type", "enabled", "url", "headers"]) &&
          value.type === "remote" &&
          value.enabled === true &&
          hasExactDosuHeaders(value) &&
          hasDosuMcpPath(value.url)) ||
        isStandardHttpEntry(value, true)
      );
    case "zed":
      return (
        (hasExactKeys(value, ["source", "type", "url", "headers"]) &&
          value.source === "custom" &&
          value.type === "http" &&
          hasExactDosuHeaders(value) &&
          hasDosuMcpPath(value.url)) ||
        isStandardHttpEntry(value, true)
      );
    case "antigravity":
      return (
        (hasExactKeys(value, ["serverUrl", "headers"]) &&
          hasExactDosuHeaders(value) &&
          hasDosuMcpPath(value.serverUrl)) ||
        isStandardHttpEntry(value, true)
      );
    case "copilot":
      return (
        hasExactKeys(value, ["type", "url", "tools", "headers"]) &&
        value.type === "http" &&
        hasExactDosuHeaders(value) &&
        hasDosuMcpPath(value.url) &&
        Array.isArray(value.tools) &&
        value.tools.length === 1 &&
        value.tools[0] === "*"
      );
    default:
      return false;
  }
}

/**
 * Build the checked-in command. It contains a deployment identifier, but no endpoint or secret;
 * both are resolved from the user's private Dosu config when the agent starts the MCP server.
 */
export function buildProjectProxyCommand(cfg: Config): ProjectProxyCommand {
  // Fail during setup, before writing a config that cannot start.
  findNpx();
  const args = ["-y", `@dosu/cli@${VERSION}`, "mcp", "proxy"];
  if (cfg.mode === MODE_OSS) {
    args.push("--oss");
  } else {
    const deploymentID = requireSafeProjectDeploymentID(cfg.active_account?.target?.deployment_id);
    args.push("--deployment", deploymentID);
  }
  return { command: "npx", args };
}

/** Persist the endpoint beside the API key in the private user config before project files refer to it. */
export function recordProjectProxyEndpoint(
  cfg: Config,
  deps: ProjectProxyRecordDependencies = {},
): void {
  const deploymentID = cfg.active_account?.target?.deployment_id;
  if (cfg.mode !== MODE_OSS && !deploymentID) throw new Error("deployment ID is required");
  const apiKey = cfg.active_account?.target?.api_key;
  if (!apiKey) throw new Error("API key is required");
  const key = credentialKey(
    cfg.mode === MODE_OSS ? { oss: true } : { deploymentID: deploymentID as string },
  );
  const endpoint = cfg.mode === MODE_OSS ? mcpBaseURL() : mcpURL(deploymentID as string);
  updateTarget(cfg, {
    mcp_endpoint: endpoint,
  });
  const userID = getConfigUserID(cfg);
  if (!userID) throw new Error("authenticated account identity is required");
  (deps.saveCredential ?? saveProjectMcpCredential)({
    userID,
    targetKey: key,
    credential: { endpoint, api_key: apiKey },
  });
}

function validateStoredEndpoint(endpoint: string, deploymentID?: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Invalid MCP endpoint in Dosu user config. Re-run `dosu setup`.");
  }

  const expectedPath = deploymentID
    ? `/v1/mcp/deployments/${encodeURIComponent(deploymentID)}`
    : "/v1/mcp";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Invalid MCP endpoint in Dosu user config. Re-run `dosu setup`.");
  }
  if (
    parsed.username ||
    parsed.password ||
    /[\s"&|<>()^%!]/.test(endpoint) ||
    parsed.pathname !== expectedPath ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Invalid MCP endpoint in Dosu user config. Re-run `dosu setup`.");
  }
}

/** Resolve secret runtime state without trusting any endpoint supplied by a project file. */
export function resolveProjectProxyRuntime(
  cfg: Config,
  opts: ProjectProxyOptions,
  readCredential: ProjectProxyDependencies["readCredential"] = readProjectMcpCredential,
): ProjectProxyRuntime {
  const key = credentialKey(opts);
  const target = cfg.active_account?.target;
  const userID = getConfigUserID(cfg);
  const stored = userID ? readCredential?.({ userID, targetKey: key }) : undefined;
  const canUseActiveTarget = opts.oss
    ? cfg.mode === MODE_OSS
    : Boolean(opts.deploymentID && target?.deployment_id === opts.deploymentID);
  const endpoint = stored?.endpoint ?? (canUseActiveTarget ? target?.mcp_endpoint : undefined);
  if (!endpoint) {
    throw new Error(
      "This project's Dosu credentials are missing. Re-run `dosu setup` in the project.",
    );
  }
  validateStoredEndpoint(endpoint, opts.oss ? undefined : opts.deploymentID);

  const apiKey = stored?.api_key ?? (canUseActiveTarget ? target?.api_key : undefined);
  if (!apiKey) throw new Error("Dosu API key is missing. Re-run `dosu setup` in the project.");
  return { endpoint, apiKey };
}

/** Run the pinned HTTP-to-stdio bridge used by project configuration entries. */
export async function runProjectProxy(
  opts: ProjectProxyOptions,
  deps: ProjectProxyDependencies = {},
): Promise<number> {
  const runtime = resolveProjectProxyRuntime(
    (deps.loadConfig ?? loadConfig)(),
    opts,
    deps.readCredential,
  );
  const npx = (deps.findNpx ?? findNpx)();
  const platform = deps.platform ?? process.platform;
  const remote = mcpRemoteServer(runtime.endpoint, runtime.apiKey);
  // Node's shell mode concatenates the executable and arguments without
  // quoting the executable. Use the basename on Windows and prepend the
  // already-verified directory to PATH so `C:\\Program Files\\...` works.
  const executable = platform === "win32" ? win32.basename(npx) : npx;
  const child = (deps.spawn ?? (nodeSpawn as unknown as SpawnProxy))(executable, remote.args, {
    stdio: "inherit",
    // On Windows npm exposes npx as npx.cmd. Node documents that .cmd files
    // cannot be launched directly; they must run through a shell.
    shell: platform === "win32",
    detached: platform !== "win32",
    env: {
      ...process.env,
      PATH: npxPathEnv(npx),
      ...remote.env,
    },
  });

  return await new Promise<number>((resolve, reject) => {
    const signalSource = deps.signalSource ?? (process as SignalSource);
    const signals: readonly ProxySignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forwarders = new Map<ProxySignal, () => void>();
    let settled = false;
    let shuttingDown = false;
    const cleanup = () => {
      for (const [signal, listener] of forwarders) {
        signalSource.removeListener(signal, listener);
      }
      forwarders.clear();
    };
    const settleResolve = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    for (const signal of signals) {
      const forward = () => {
        if (platform !== "win32") {
          if (shuttingDown) return;
          shuttingDown = true;
          void terminatePosixProcessTree(child, {
            killProcessGroup: deps.killProcessGroup,
            killGraceMs: deps.killGraceMs,
            shutdownDeadlineMs: deps.shutdownDeadlineMs,
          }).then((status) => settleResolve(status === "terminated" ? 0 : 1));
          return;
        }
        if (shuttingDown) return;
        shuttingDown = true;
        void terminateWindowsProcessTree(child, {
          spawnTreeKiller: deps.spawnTreeKiller,
          shutdownDeadlineMs: deps.shutdownDeadlineMs,
        }).then((status) => settleResolve(status === "terminated" ? 0 : 1));
      };
      forwarders.set(signal, forward);
      signalSource.once(signal, forward);
    }

    child.once("error", (error) => {
      if (shuttingDown) return;
      settleReject(error);
    });
    child.once("close", (code) => {
      if (shuttingDown) return;
      settleResolve(code ?? 1);
    });
  });
}
