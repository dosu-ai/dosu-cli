/**
 * Setup flow — interactive wizard.
 *
 * Equivalent to Go's internal/setup/flow.go + steps.go
 */

import * as p from "@clack/prompts";
import { loadConfig, saveConfig, type Config } from "../config/config";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import {
  allSetupProviders,
  type SetupProvider,
} from "../mcp/providers";
import { printSuccess, printError, printWarning, info, dim, printBox } from "./styles";

export interface SetupOptions {
  deploymentID?: string;
}

type ConfigAction = "install" | "remove" | "skip";

interface ConfigResult {
  provider: SetupProvider;
  action: ConfigAction;
  error?: Error;
}

interface ToolSelection {
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
    printWarning("No supported AI tools detected on your system.");
    console.log(`  Run ${info("dosu mcp add <tool>")} to manually configure a tool.`);
    return;
  }

  const selection = await stepSelectTools(detected);
  if (!selection) return;

  const results = stepConfigureTools(cfg, selection);
  stepShowSummary(results);

  p.outro("Setup complete!");
}

async function stepAuthenticate(): Promise<Config | null> {
  const cfg = loadConfig();
  // For now, just check if already authenticated
  if (cfg.access_token) {
    printSuccess("Authenticated");
    return cfg;
  }

  const shouldLogin = await p.confirm({ message: "You need to log in. Open browser?" });
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
  } catch (err: any) {
    printError(`Authentication failed: ${err.message}`);
    return null;
  }
}

async function stepSelectOrg(apiClient: Client): Promise<Org | null> {
  try {
    const orgs = await apiClient.getOrgs();
    if (orgs.length === 0) {
      printError("No organizations found for your account");
      return null;
    }
    if (orgs.length === 1) {
      printSuccess(`Organization: ${orgs[0].name}`);
      return orgs[0];
    }
    const selected = await p.select({
      message: "Select an organization",
      options: orgs.map((o) => ({ label: o.name, value: o.org_id })),
    });
    if (p.isCancel(selected)) return null;
    return orgs.find((o) => o.org_id === selected) ?? null;
  } catch (err: any) {
    if (err instanceof SessionExpiredError) {
      printWarning("Session expired. Please run " + info("dosu setup") + " again.");
      return null;
    }
    printError(`Organization selection failed: ${err.message}`);
    return null;
  }
}

async function stepResolveDeployment(apiClient: Client, id: string): Promise<Deployment | null> {
  try {
    const deployments = await apiClient.getDeployments();
    const d = deployments.find((d) => d.deployment_id === id);
    if (!d) {
      printError(`Deployment ${id} not found`);
      return null;
    }
    printSuccess(`Using deployment: ${d.name}`);
    return d;
  } catch (err: any) {
    printError(`Failed to resolve deployment: ${err.message}`);
    return null;
  }
}

async function stepSelectDeployment(apiClient: Client, org: Org): Promise<Deployment | null> {
  try {
    const allDeployments = await apiClient.getDeployments();
    const deployments = allDeployments.filter((d) => d.org_id === org.org_id);

    if (deployments.length === 0) {
      printError(`No deployments found for ${org.name}`);
      return null;
    }
    if (deployments.length === 1) {
      printSuccess(`Using deployment: ${deployments[0].name}`);
      return deployments[0];
    }
    const selected = await p.select({
      message: "Select a deployment",
      options: deployments.map((d) => ({ label: d.name, value: d.deployment_id })),
    });
    if (p.isCancel(selected)) return null;
    return deployments.find((d) => d.deployment_id === selected) ?? null;
  } catch (err: any) {
    printError(`Deployment selection failed: ${err.message}`);
    return null;
  }
}

async function stepMintAPIKey(apiClient: Client, cfg: Config): Promise<string | null> {
  if (cfg.api_key) {
    const valid = await apiClient.validateAPIKey(cfg.api_key, cfg.deployment_id!);
    if (valid) {
      printSuccess("API key: " + dim("using existing"));
      return cfg.api_key;
    }
    printWarning("Existing API key is invalid, creating a new one...");
  }

  try {
    const resp = await apiClient.createAPIKey(cfg.deployment_id!, "dosu-cli");
    printSuccess("API key created");
    return resp.api_key;
  } catch (err: any) {
    printError(`API key creation failed: ${err.message}`);
    return null;
  }
}

function isStdioOnly(p: SetupProvider): boolean {
  return p.id() === "claude-desktop";
}

function stepDetectTools(): SetupProvider[] {
  return allSetupProviders().filter((p) => p.isInstalled() && !isStdioOnly(p));
}

async function stepSelectTools(detected: SetupProvider[]): Promise<ToolSelection | null> {
  const configuredMap = new Map<string, boolean>();
  for (const p of detected) {
    configuredMap.set(p.id(), p.isConfigured());
  }

  const options = detected.map((p) => {
    const configured = configuredMap.get(p.id())!;
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
    const isConfigured = configuredMap.get(provider.id())!;

    if (isSelected && !isConfigured) result.toInstall.push(provider);
    else if (isSelected && isConfigured) result.skipped.push(provider);
    else if (!isSelected && isConfigured) result.toRemove.push(provider);
  }

  return result;
}

function stepConfigureTools(cfg: Config, selection: ToolSelection): ConfigResult[] {
  const results: ConfigResult[] = [];

  for (const provider of selection.toInstall) {
    try {
      provider.install(cfg, true);
      results.push({ provider, action: "install" });
    } catch (err: any) {
      printError(`Failed to configure ${provider.name()}: ${err.message}`);
      results.push({ provider, action: "install", error: err });
    }
  }

  for (const provider of selection.toRemove) {
    try {
      provider.remove(true);
      results.push({ provider, action: "remove" });
    } catch (err: any) {
      printError(`Failed to remove ${provider.name()}: ${err.message}`);
      results.push({ provider, action: "remove", error: err });
    }
  }

  for (const provider of selection.skipped) {
    results.push({ provider, action: "skip" });
  }

  return results;
}

function stepShowSummary(results: ConfigResult[]): void {
  const installed = results.filter((r) => r.action === "install" && !r.error);
  const removed = results.filter((r) => r.action === "remove" && !r.error);
  const skipped = results.filter((r) => r.action === "skip");

  console.log();

  if (installed.length > 0) {
    console.log(`\uD83C\uDF89 Configured ${installed.length} tool(s):`);
    for (const r of installed) {
      console.log(`  + ${r.provider.name()}`);
      console.log(`    ${dim(r.provider.globalConfigPath())}`);
    }
    console.log();
  }

  if (removed.length > 0) {
    console.log(`\uD83D\uDDD1\uFE0F  Removed from ${removed.length} tool(s):`);
    for (const r of removed) {
      console.log(`  - ${r.provider.name()}`);
      console.log(`    ${dim(r.provider.globalConfigPath())}`);
    }
    console.log();
  }

  if (installed.length === 0 && removed.length === 0 && skipped.length > 0) {
    console.log(`\uD83C\uDF89 All tools already configured. No changes needed.`);
    console.log();
  }

  if (installed.length > 0 || skipped.length > 0) {
    console.log("Try it out! Paste this into your agent:\n");
    printBox(
      "Use Dosu to search our team's documentation and answer:",
      "what are the main components of our system?",
    );
    console.log();
  }
}
