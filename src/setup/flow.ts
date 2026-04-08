/**
 * Setup flow — interactive wizard.
 */

import * as p from "@clack/prompts";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import { type Config, loadConfig, MODE_OSS, type SetupMode, saveConfig } from "../config/config";
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
  const cfg = await stepAuthenticate(opts);
  if (!cfg) return;

  const apiClient = new Client(cfg);

  // Step 2: Branch on mode
  if (opts.deploymentID) {
    // --deployment flag provided, use specified deployment
    const d = await stepResolveDeployment(apiClient, opts.deploymentID);
    if (!d) return;
    cfg.mode = undefined;
    cfg.deployment_id = d.deployment_id;
    cfg.deployment_name = d.name;
  } else if (cfg.mode === MODE_OSS) {
    // OSS path: fetch first available deployment for API key creation only
    const deployments = await fetchDeployments(apiClient);
    if (deployments.length > 0) {
      cfg.deployment_id = deployments[0].deployment_id;
      cfg.deployment_name = deployments[0].name;
    }
  } else {
    // Standard path: select deployment interactively
    const org = await stepSelectOrg(apiClient);
    if (!org) return;
    const d = await stepSelectDeployment(apiClient, org);
    if (!d) return;
    cfg.mode = undefined;
    cfg.deployment_id = d.deployment_id;
    cfg.deployment_name = d.name;
  }

  saveConfig(cfg);

  // Step 3: API key (needed for both modes)
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
  stepShowSummary(results, cfg.mode);

  if (cfg.mode === MODE_OSS) {
    p.outro(
      "Setup complete! Using open-source libraries only.\n\nTips: Run `dosu setup` again to connect your own repos.",
    );
  } else {
    p.outro("\uD83C\uDF89 Setup complete!");
  }
}

async function stepAuthenticate(opts: SetupOptions): Promise<Config | null> {
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

        // If configured for OSS and no --deployment flag, let the user reconfigure
        if (!opts.deploymentID && cfg.mode === MODE_OSS) {
          const modeLabel = "open-source libraries only";
          const action = await p.select({
            message: `Currently configured for ${modeLabel}. What would you like to do?`,
            options: [
              { label: "Reconfigure (opens browser)", value: "reconfigure" },
              { label: "Keep current setup and update tools", value: "keep" },
            ],
          });
          if (p.isCancel(action)) return null;
          if (action === "keep") return cfg;
          // Reconfigure: open browser for mode re-selection
          return await openBrowserForSetup(cfg, opts);
        }

        return cfg;
      }
      // Any non-200 status — try refresh before giving up
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
      s.stop("Session expired");
      p.log.warn("Session expired.");
    } catch {
      s.stop("Session verification failed");
    }
  }

  // Need login
  const shouldLogin = await p.confirm({ message: "Open browser to log in?" });
  if (p.isCancel(shouldLogin) || !shouldLogin) return null;

  return await openBrowserForSetup(cfg, opts);
}

async function openBrowserForSetup(cfg: Config, opts: SetupOptions): Promise<Config | null> {
  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const s = p.spinner();
    s.start("Waiting for authentication...");
    // Use /cli/setup unless a specific deployment was already provided via --deployment flag
    const authPath = opts.deploymentID ? "/cli/auth" : "/cli/setup";
    const token = await startOAuthFlow(undefined, authPath);
    s.stop("Authenticated");

    cfg.access_token = token.access_token;
    cfg.refresh_token = token.refresh_token;
    cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
    // Sync mode from browser: OSS when signaled, clear otherwise (cloud flow)
    cfg.mode = token.mode === MODE_OSS ? MODE_OSS : undefined;
    saveConfig(cfg);
    return cfg;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchDeployments(apiClient: Client): Promise<Deployment[]> {
  try {
    return await apiClient.getDeployments();
  } catch {
    return [];
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
    /* v8 ignore next -- err is always Error in practice */
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
    /* v8 ignore next -- err is always Error in practice */
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
      message: "Select an MCP",
      options: deployments.map((d) => ({ label: d.name, value: d.deployment_id })),
    });
    if (p.isCancel(selected)) return null;
    return deployments.find((d) => d.deployment_id === selected) ?? null;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    p.log.error(`Deployment selection failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepMintAPIKey(apiClient: Client, cfg: Config): Promise<string | null> {
  if (!cfg.deployment_id) {
    p.log.error("No deployment available for API key creation");
    return null;
  }

  if (cfg.api_key) {
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const valid = await apiClient.validateAPIKey(cfg.api_key, cfg.deployment_id!);
    if (valid) {
      p.log.success(`API key\n${dim("using existing")}`);
      return cfg.api_key;
    }
    p.log.warn("Existing API key is invalid, creating a new one...");
  }

  try {
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const resp = await apiClient.createAPIKey(cfg.deployment_id!, "dosu-cli");
    p.log.success(`API key\n${dim("created")}`);
    return resp.api_key;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
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
      /* v8 ignore next -- err is always Error in practice */
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
      /* v8 ignore next -- err is always Error in practice */
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

export function stepShowSummary(results: ConfigResult[], mode?: SetupMode): void {
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
    const prompt =
      mode === MODE_OSS
        ? `What can Dosu MCP help me do in this repo? Briefly explain, then tell me the main components, request flow, and where to start.`
        : `I'm new to this codebase. Give me a 5-minute mental model: main services, request flow, where to start.`;
    p.log.message(`Try it out! Paste this into your agent:\n\n${info(prompt)}`);
  }
}
