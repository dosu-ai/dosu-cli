/**
 * Setup flow — interactive wizard.
 */

import * as p from "@clack/prompts";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import { type Config, loadConfig, saveConfig } from "../config/config";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { dim, info } from "./styles";

export interface SetupOptions {
  deploymentID?: string;
}

export type ConfigAction = "install" | "remove" | "skip";

export interface ConfigResult {
  provider: SetupProvider;
  action: ConfigAction;
  error?: Error;
}

export interface ToolSelection {
  toInstall: SetupProvider[];
  toRemove: SetupProvider[];
  skipped: SetupProvider[];
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  p.intro("Dosu CLI Setup");

  // Step 1: Authenticate
  const cfg = await stepAuthenticate();
  if (!cfg) return;

  const apiClient = new Client(cfg);

  // Step 2: Select deployment
  let deployment: Deployment;
  if (opts.deploymentID) {
    const d = await stepResolveDeployment(apiClient, opts.deploymentID);
    if (!d) return;
    deployment = d;
  } else {
    const org = await stepSelectOrg(apiClient);
    if (!org) return;
    const d = await stepSelectDeployment(apiClient, org);
    if (!d) return;
    deployment = d;
  }

  cfg.deployment_id = deployment.deployment_id;
  cfg.deployment_name = deployment.name;
  saveConfig(cfg);

  // Step 3: API key
  const apiKey = await stepMintAPIKey(apiClient, cfg);
  if (!apiKey) return;
  cfg.api_key = apiKey;
  saveConfig(cfg);

  // Step 4: Detect and configure tools
  const detected = stepDetectTools();
  if (detected.length === 0) {
    p.log.warn(
      `No supported AI tools detected on your system.\nRun ${info("dosu mcp add <tool>")} to manually configure a tool.`,
    );
    return;
  }

  const selection = await stepSelectTools(detected);
  if (!selection) return;

  const results = stepConfigureTools(cfg, selection);
  stepShowSummary(results);

  p.outro("\uD83C\uDF89 Setup complete!");
}

async function stepAuthenticate(): Promise<Config | null> {
  const cfg = loadConfig();

  // If we have a token, verify it against the backend first
  if (cfg.access_token) {
    const s = p.spinner();
    s.start("Verifying session...");
    try {
      const apiClient = new Client(cfg);
      const resp = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
      if (resp.status === 200) {
        s.stop("Authenticated");
        return cfg;
      }
      // Token invalid — try refresh
      if (resp.status === 401 || resp.status === 403 || resp.status === 500) {
        try {
          await apiClient.refreshToken();
          const resp2 = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
          if (resp2.status === 200) {
            s.stop("Authenticated");
            return cfg;
          }
        } catch {
          // refresh failed, fall through to login
        }
      }
      s.stop("Session expired");
      p.log.warn("Session expired.");
    } catch {
      s.stop("Session verification failed");
    }
  }

  // Need login
  const shouldLogin = await p.confirm({ message: "Open browser to log in?" });
  if (p.isCancel(shouldLogin) || !shouldLogin) return null;

  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const s = p.spinner();
    s.start("Waiting for authentication...");
    const token = await startOAuthFlow();
    s.stop("Authenticated");

    cfg.access_token = token.access_token;
    cfg.refresh_token = token.refresh_token;
    cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
    saveConfig(cfg);
    return cfg;
  } catch (err: unknown) {
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepSelectOrg(apiClient: Client): Promise<Org | null> {
  try {
    const orgs = await apiClient.getOrgs();
    if (orgs.length === 0) {
      p.log.error("No organizations found for your account");
      return null;
    }
    if (orgs.length === 1) {
      p.log.success(`Organization\n${dim(orgs[0].name)}`);
      return orgs[0];
    }
    const selected = await p.select({
      message: "Select an organization",
      options: orgs.map((o) => ({ label: o.name, value: o.org_id })),
    });
    if (p.isCancel(selected)) return null;
    return orgs.find((o) => o.org_id === selected) ?? null;
  } catch (err: unknown) {
    if (err instanceof SessionExpiredError) {
      p.log.warn(`Session expired. Please run ${info("dosu setup")} again.`);
      return null;
    }
    p.log.error(
      `Organization selection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function stepResolveDeployment(apiClient: Client, id: string): Promise<Deployment | null> {
  try {
    const deployments = await apiClient.getDeployments();
    const d = deployments.find((d) => d.deployment_id === id);
    if (!d) {
      p.log.error(`Deployment ${id} not found`);
      return null;
    }
    p.log.success(`Using deployment\n${dim(d.name)}`);
    return d;
  } catch (err: unknown) {
    p.log.error(
      `Failed to resolve deployment: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function stepSelectDeployment(apiClient: Client, org: Org): Promise<Deployment | null> {
  try {
    const allDeployments = await apiClient.getDeployments();
    const deployments = allDeployments.filter((d) => d.org_id === org.org_id);

    if (deployments.length === 0) {
      p.log.error(`No deployments found for ${org.name}`);
      return null;
    }
    if (deployments.length === 1) {
      p.log.success(`Using deployment\n${dim(deployments[0].name)}`);
      return deployments[0];
    }
    const selected = await p.select({
      message: "Select a deployment",
      options: deployments.map((d) => ({ label: d.name, value: d.deployment_id })),
    });
    if (p.isCancel(selected)) return null;
    return deployments.find((d) => d.deployment_id === selected) ?? null;
  } catch (err: unknown) {
    p.log.error(`Deployment selection failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepMintAPIKey(apiClient: Client, cfg: Config): Promise<string | null> {
  if (cfg.api_key) {
    const valid = await apiClient.validateAPIKey(cfg.api_key, cfg.deployment_id ?? "");
    if (valid) {
      p.log.success(`API key\n${dim("using existing")}`);
      return cfg.api_key;
    }
    p.log.warn("Existing API key is invalid, creating a new one...");
  }

  try {
    const resp = await apiClient.createAPIKey(cfg.deployment_id ?? "", "dosu-cli");
    p.log.success(`API key\n${dim("created")}`);
    return resp.api_key;
  } catch (err: unknown) {
    p.log.error(`API key creation failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function isStdioOnly(p: SetupProvider): boolean {
  return p.id() === "claude-desktop";
}

export function stepDetectTools(): SetupProvider[] {
  return allSetupProviders().filter((p) => p.isInstalled() && !isStdioOnly(p));
}

async function stepSelectTools(detected: SetupProvider[]): Promise<ToolSelection | null> {
  const configuredMap = new Map<string, boolean>();
  for (const p of detected) {
    configuredMap.set(p.id(), p.isConfigured());
  }

  const options = detected.map((p) => {
    const configured = configuredMap.get(p.id()) ?? false;
    return {
      label: configured ? `${p.name()} ${dim("(already configured)")}` : p.name(),
      value: p.id(),
      hint: configured ? "configured" : undefined,
    };
  });

  const preselected = detected.filter((p) => configuredMap.get(p.id())).map((p) => p.id());

  const selected = await p.multiselect({
    message: "Select tools to configure",
    options,
    initialValues: preselected,
  });

  if (p.isCancel(selected)) return null;

  const selectedSet = new Set(selected as string[]);
  const result: ToolSelection = { toInstall: [], toRemove: [], skipped: [] };

  for (const provider of detected) {
    const isSelected = selectedSet.has(provider.id());
    const isConfigured = configuredMap.get(provider.id()) ?? false;

    if (isSelected && !isConfigured) result.toInstall.push(provider);
    else if (isSelected && isConfigured) result.skipped.push(provider);
    else if (!isSelected && isConfigured) result.toRemove.push(provider);
  }

  return result;
}

export function stepConfigureTools(cfg: Config, selection: ToolSelection): ConfigResult[] {
  const results: ConfigResult[] = [];

  for (const provider of selection.toInstall) {
    try {
      provider.install(cfg, true);
      results.push({ provider, action: "install" });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      p.log.error(`Failed to configure ${provider.name()}: ${error.message}`);
      results.push({ provider, action: "install", error });
    }
  }

  for (const provider of selection.toRemove) {
    try {
      provider.remove(true);
      results.push({ provider, action: "remove" });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      p.log.error(`Failed to remove ${provider.name()}: ${error.message}`);
      results.push({ provider, action: "remove", error });
    }
  }

  for (const provider of selection.skipped) {
    results.push({ provider, action: "skip" });
  }

  return results;
}

export function stepShowSummary(results: ConfigResult[]): void {
  const installed = results.filter((r) => r.action === "install" && !r.error);
  const removed = results.filter((r) => r.action === "remove" && !r.error);
  const skipped = results.filter((r) => r.action === "skip");

  if (installed.length > 0) {
    const lines = installed
      .map((r) => `+ ${r.provider.name()}\n  ${dim(r.provider.globalConfigPath())}`)
      .join("\n");
    p.log.success(`Configured ${installed.length} tool(s):\n${lines}`);
  }

  if (removed.length > 0) {
    const lines = removed
      .map((r) => `- ${r.provider.name()}\n  ${dim(r.provider.globalConfigPath())}`)
      .join("\n");
    p.log.info(`Removed from ${removed.length} tool(s):\n${lines}`);
  }

  if (installed.length === 0 && removed.length === 0 && skipped.length > 0) {
    p.log.success("All tools already configured. No changes needed.");
  }

  if (installed.length > 0 || skipped.length > 0) {
    p.log.message(
      `Try it out! Paste this into your agent:\n\n` +
        info(
          `Use Dosu to search our team's documentation and answer: what are the main components of our system?`,
        ),
    );
  }
}
