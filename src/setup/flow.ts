/**
 * Setup flow — interactive wizard.
 */

import * as p from "@clack/prompts";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import { installSkill } from "../commands/skill";
import { type Config, loadConfig, MODE_OSS, type SetupMode, saveConfig } from "../config/config";
import { logger } from "../debug/logger";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { dim, info } from "./styles";

export interface SetupOptions {
  deploymentID?: string;
  /** Force a specific mode, bypassing the default. "cloud" = standard flow, "oss" = public-libraries-only. */
  mode?: SetupMode | "cloud";
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

interface OneShotChoices {
  configureMcp: boolean;
  installSkill: boolean;
  connectGitHub: boolean;
}

type SetupFlowKind = "onboarding" | "setup";

interface CloudSetupContext {
  kind: SetupFlowKind;
  profileUserID: string;
  targetOrg?: OwnedOrg;
}

interface OwnedOrg {
  org_id: string;
  name: string;
  user_role?: string | null;
}

// `@dosu/api-types` trails a few app routers; use a narrow local cast in setup.
// biome-ignore lint/suspicious/noExplicitAny: see note above
type TrpcAny = any;

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  logger.info(
    "setup",
    `Setup flow started${opts.deploymentID ? ` deployment=${opts.deploymentID}` : ""}${
      opts.mode ? ` mode=${opts.mode}` : ""
    }`,
  );
  p.intro("Dosu CLI Setup");

  let cfg = loadConfig();

  applyModeOverride(cfg, opts);

  // --deployment implies Cloud; otherwise default to Cloud unless --mode oss.
  if (opts.deploymentID) {
    cfg.mode = undefined;
    saveConfig(cfg);
  }

  // Authenticate — always runs so we can verify/refresh tokens.
  const authedCfg = await stepAuthenticate(cfg);
  if (!authedCfg) return;
  cfg = authedCfg;

  const apiClient = new Client(cfg);
  let cloudSetupContext: CloudSetupContext | null = null;

  if (cfg.mode !== MODE_OSS) {
    // resolveCloudSetupContext fans out 1–3 tRPC calls (profile +
    // organization lookup) which can each take a few hundred ms. Without
    // a spinner the post-Authenticated gap looks like a freeze.
    const s = p.spinner();
    s.start("Loading your workspace...");
    cloudSetupContext = await resolveCloudSetupContext(cfg);
    if (!cloudSetupContext) {
      s.stop("Workspace load failed");
      return;
    }
    s.stop("Workspace loaded");
  }

  // Deployment: first-run onboarding binds the user's default deployment.
  // Otherwise we only run the interactive picker when we don't already have
  // a deployment id locked in, OR when the caller passed `--deployment` to
  // explicitly switch. Everyday re-runs reuse the stored deployment silently.
  if (cfg.mode !== MODE_OSS && cloudSetupContext?.kind === "onboarding") {
    const ok = await bindOnboardingDeployment(apiClient, cfg, cloudSetupContext.targetOrg ?? null);
    if (!ok) return;
  } else if (!cfg.deployment_id || opts.deploymentID) {
    const ok = await resolveDeployment(apiClient, cfg, opts);
    if (!ok) return;
  }

  // API key: `stepMintAPIKey` is idempotent — it validates an existing key
  // before minting a new one, so it's safe to call on every run.
  const apiKey = await stepMintAPIKey(apiClient, cfg);
  if (!apiKey) return;
  cfg.api_key = apiKey;
  saveConfig(cfg);

  // One-shot confirm: MCP + skill are always listed (user picks what to
  // (re)run); GitHub docs import only shows during first-run onboarding.
  const choices = await stepOneShotConfirm({
    includeGitHub: cloudSetupContext?.kind === "onboarding",
  });
  if (!choices) return;

  // MCP tools. Track whether at least one agent ended up with Dosu MCP
  // configured (newly installed or previously installed) so we only nudge
  // the user with the "Try it out" prompt when there's actually an agent
  // they can paste it into.
  let mcpConfiguredThisRun = false;
  if (choices.configureMcp) {
    const configured = await stepConfigureMcpTools(cfg);
    if (configured === null) return;
    mcpConfiguredThisRun = configured.some((r) => r.action === "install" || r.action === "skip");
  }

  // Dosu skill
  if (choices.installSkill) {
    await runInstallSkill();
  }

  let githubOnboardingDone = !choices.connectGitHub;
  if (choices.connectGitHub && cloudSetupContext?.kind === "onboarding") {
    const { stepConnectGitHubRepo } = await import("./github-step");
    const connectResult = await stepConnectGitHubRepo(cfg);
    if (!connectResult.advance) return;
    if (connectResult.space_id && !cfg.space_id) {
      cfg.space_id = connectResult.space_id;
      saveConfig(cfg);
    }

    const { stepImportGitHubDocs } = await import("./github-doc-import-step");
    const importResult = await stepImportGitHubDocs(cfg, {
      waitForFreshDocs: Boolean(connectResult.deployment_id),
      expectedDataSourceIds: connectResult.created_data_source_ids,
    });
    if (!importResult.advance) return;
    githubOnboardingDone = true;
  }

  const shouldCompleteRemoteOnboarding =
    cloudSetupContext?.kind === "onboarding" && githubOnboardingDone;

  if (shouldCompleteRemoteOnboarding && cloudSetupContext) {
    const profileUserID = cloudSetupContext.profileUserID;
    try {
      const { createTypedClient } = await import("../client/trpc");
      const trpc = createTypedClient(cfg) as TrpcAny;
      await trpc.user.updateProfile.mutate({
        user_id: profileUserID,
        finished_onboarding: true,
      });
      logger.info("setup", "Server onboarding marked complete");
    } catch (err) {
      logger.warn(
        "setup",
        `completeOnboarding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      p.log.warn(
        "Could not mark onboarding complete on the server — you can retry later by running `dosu setup` again.",
      );
    }
  }

  if (mcpConfiguredThisRun) {
    showTryItOutPrompt(cfg.mode);
  }

  if (cfg.mode === MODE_OSS) {
    p.outro(
      "Setup complete! Using open-source libraries only.\n\nTips: Run `dosu setup --mode cloud` to connect your own repos.",
    );
  } else {
    p.outro("\uD83C\uDF89 Setup complete!");
  }
}

/**
 * Apply a user-supplied --mode flag against the current config.
 */
function applyModeOverride(cfg: Config, opts: SetupOptions): void {
  if (!opts.mode) return;
  const newMode = opts.mode === "oss" ? MODE_OSS : undefined;
  const oldMode = cfg.mode;
  cfg.mode = newMode;
  if (oldMode === MODE_OSS && newMode === undefined) {
    logger.info("setup", "Mode switched OSS → Cloud");
  }
  saveConfig(cfg);
}

/**
 * One-shot confirmation: a single multiselect listing everything Dosu will
 * set up. All items default checked; user hits Enter to do it all, or
 * unticks specific items.
 *
 * MCP + skill are always listed so users can re-run either step at any
 * time (add a new agent, reinstall the skill). GitHub docs import only
 * shows during first-run cloud onboarding.
 */
async function stepOneShotConfirm(opts: {
  includeGitHub: boolean;
}): Promise<OneShotChoices | null> {
  type Item = { value: keyof OneShotChoices; label: string };
  const items: Item[] = [
    { value: "configureMcp", label: "Install Dosu MCP" },
    { value: "installSkill", label: "Install Dosu skill" },
  ];
  if (opts.includeGitHub) {
    items.push({
      value: "connectGitHub",
      label: `Import docs from GitHub ${dim("(Keep them up to date)")}`,
    });
  }

  const selected = await p.multiselect({
    message: "Dosu will set these up — press Enter to accept, space to toggle",
    options: items.map((it) => ({ value: it.value, label: it.label })),
    initialValues: items.map((it) => it.value),
    required: false,
  });

  if (p.isCancel(selected)) {
    logger.info("setup", "One-shot confirm cancelled");
    return null;
  }

  const chosen = new Set(selected as Array<keyof OneShotChoices>);
  return {
    configureMcp: chosen.has("configureMcp"),
    installSkill: chosen.has("installSkill"),
    connectGitHub: chosen.has("connectGitHub"),
  };
}

/**
 * Runs MCP tool detection → selection → configuration as a single unit.
 * Returns the ConfigResult array on success, or null if the user cancelled.
 * An empty detection pool is treated as success (nothing to do).
 */
async function stepConfigureMcpTools(cfg: Config): Promise<ConfigResult[] | null> {
  const detected = stepDetectTools();
  if (detected.length === 0) {
    p.log.warn(
      `No supported AI agents detected on your system.\nRun ${info("dosu mcp add <agent>")} to manually configure an agent.`,
    );
    return [];
  }
  const selection = await stepSelectTools(detected);
  if (!selection) return null;
  const results = stepConfigureTools(cfg, selection);
  stepShowSummary(results);
  return results;
}

/**
 * Run the skill install (no prompt). The upfront one-shot confirm already
 * decided whether to run this. Returns `true` on success.
 */
export async function runInstallSkill(): Promise<boolean> {
  logger.info("setup", "Step: install skill");
  try {
    const result = await installSkill();
    if (result.success) {
      logger.info("setup", `Skill installed${result.sha ? ` sha=${result.sha}` : ""}`);
      p.log.success("Skill installed");
      return true;
    }
    p.log.error("Failed to install skill. Run `dosu skill install` to retry.");
    return false;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Skill install failed: ${msg}`);
    p.log.error(`Skill install failed: ${msg}`);
    return false;
  }
}

async function stepAuthenticate(existingCfg?: Config): Promise<Config | null> {
  logger.info("setup", "Step: authenticate");
  const cfg = existingCfg ?? loadConfig();

  if (cfg.access_token) {
    const s = p.spinner();
    s.start("Verifying session...");
    try {
      const apiClient = new Client(cfg);
      const resp = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
      if (resp.status === 200) {
        logger.info("setup", `Session verified, status=${resp.status}`);
        s.stop("Authenticated");
        return cfg;
      }
      try {
        logger.debug("setup", "Attempting token refresh");
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
      logger.warn("setup", "Session expired");
      p.log.warn("Session expired.");
    } catch {
      s.stop("Session verification failed");
    }
  }

  const shouldLogin = await p.confirm({ message: "Open browser to log in?" });
  if (p.isCancel(shouldLogin) || !shouldLogin) return null;

  return await openBrowserForSetup(cfg);
}

async function openBrowserForSetup(cfg: Config): Promise<Config | null> {
  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const s = p.spinner();
    s.start("Waiting for authentication...");
    const token = await startOAuthFlow(undefined, "/cli/auth");
    s.stop("Authenticated");
    logger.info("setup", "Browser auth completed");

    cfg.access_token = token.access_token;
    cfg.refresh_token = token.refresh_token;
    cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
    saveConfig(cfg);
    return cfg;
  } catch (err: unknown) {
    /* v8 ignore next 2 -- err is always Error in practice */
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error("setup", `Auth failed: ${msg}`);
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function resolveCloudSetupContext(cfg: Config): Promise<CloudSetupContext | null> {
  try {
    const { createTypedClient } = await import("../client/trpc");
    const trpc = createTypedClient(cfg) as TrpcAny;
    const profile = (await trpc.user.getCliOnboardingContext.query()) as {
      user_id?: string;
      finished_onboarding?: boolean | null;
      cli_onboarding_enabled?: boolean | null;
    } | null;

    if (!profile?.user_id) {
      p.log.error("Could not load your profile.");
      return null;
    }

    if (profile.finished_onboarding === true || profile.cli_onboarding_enabled !== true) {
      return {
        kind: "setup",
        profileUserID: profile.user_id,
      };
    }

    const targetOrg = await resolveOnboardingTargetOrg(trpc);
    if (!targetOrg) {
      p.log.error("Could not determine your onboarding organization.");
      return null;
    }

    logger.info("setup", `First-run onboarding detected for org ${targetOrg.org_id}`);
    return {
      kind: "onboarding",
      profileUserID: profile.user_id,
      targetOrg,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to resolve cloud setup context: ${msg}`);
    p.log.error(`Could not load your onboarding state: ${msg}`);
    return null;
  }
}

async function resolveOnboardingTargetOrg(trpc: TrpcAny): Promise<OwnedOrg | null> {
  const ownerOrgs = (await trpc.organization.getOrganizations.query({
    userRole: "OWNER",
    exact: true,
  })) as OwnedOrg[];
  if (ownerOrgs.length > 0) {
    return ownerOrgs[0];
  }

  const accessibleOrgs = (await trpc.organization.getOrganizations.query()) as OwnedOrg[];
  return accessibleOrgs[0] ?? null;
}

async function bindOnboardingDeployment(
  apiClient: Client,
  cfg: Config,
  targetOrg: OwnedOrg | null,
): Promise<boolean> {
  if (!targetOrg) {
    p.log.error("Could not determine your onboarding organization.");
    return false;
  }

  const deployment = await resolveOnboardingDeployment(apiClient, targetOrg);
  if (!deployment) {
    p.log.error(`No MCP found for ${targetOrg.name}.`);
    return false;
  }

  cfg.mode = undefined;
  cfg.deployment_id = deployment.deployment_id;
  cfg.deployment_name = deployment.name;
  cfg.org_id = deployment.org_id;
  cfg.space_id = deployment.space_id;
  logger.info(
    "setup",
    `Bound onboarding context org=${targetOrg.org_id} deployment=${deployment.deployment_id}`,
  );
  p.log.success(`Organization\n${dim(targetOrg.name)}`);
  return true;
}

async function resolveOnboardingDeployment(
  apiClient: Client,
  targetOrg: OwnedOrg,
): Promise<Deployment | null> {
  const deployments = await fetchDeployments(apiClient);
  const orgDeployments = deployments.filter((deployment) => deployment.org_id === targetOrg.org_id);
  return (
    orgDeployments.find((deployment) => deployment.provider_slug === "dosu_mcp") ??
    orgDeployments[0] ??
    null
  );
}

/**
 * Resolves the deployment according to the three branches:
 *   - --deployment flag → use that specific deployment
 *   - OSS mode → auto-pick the first deployment (used only for API-key issuance)
 *   - standard → interactive org + deployment select
 */
async function resolveDeployment(
  apiClient: Client,
  cfg: Config,
  opts: SetupOptions,
): Promise<boolean> {
  if (opts.deploymentID) {
    const d = await stepResolveDeployment(apiClient, opts.deploymentID);
    if (!d) return false;
    cfg.mode = undefined;
    cfg.deployment_id = d.deployment_id;
    cfg.deployment_name = d.name;
    cfg.org_id = d.org_id;
    cfg.space_id = d.space_id;
    return true;
  }
  if (cfg.mode === MODE_OSS) {
    const deployments = await fetchDeployments(apiClient);
    if (deployments.length > 0) {
      cfg.deployment_id = deployments[0].deployment_id;
      cfg.deployment_name = deployments[0].name;
      cfg.org_id = deployments[0].org_id;
      cfg.space_id = deployments[0].space_id;
    }
    return true;
  }
  const org = await stepSelectOrg(apiClient);
  if (!org) return false;
  const d = await stepSelectDeployment(apiClient, org);
  if (!d) return false;
  cfg.mode = undefined;
  cfg.deployment_id = d.deployment_id;
  cfg.deployment_name = d.name;
  cfg.org_id = d.org_id;
  cfg.space_id = d.space_id;
  return true;
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
      logger.info("setup", `Selected org: ${orgs[0].name} (auto, only one)`);
      p.log.success(`Organization\n${dim(orgs[0].name)}`);
      return orgs[0];
    }
    const selected = await p.select({
      message: "Select an organization",
      options: orgs.map((o) => ({ label: o.name, value: o.org_id })),
    });
    if (p.isCancel(selected)) return null;
    const org = orgs.find((o) => o.org_id === selected) ?? null;
    if (org) logger.info("setup", `Selected org: ${org.name}`);
    return org;
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
      logger.warn("setup", `Deployment ${id} not found`);
      p.log.error(`MCP ${id} not found`);
      return null;
    }
    logger.info("setup", `Resolved deployment: ${d.name}`);
    p.log.success(`Using MCP\n${dim(d.name)}`);
    return d;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    p.log.error(`Failed to resolve MCP: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepSelectDeployment(apiClient: Client, org: Org): Promise<Deployment | null> {
  try {
    const allDeployments = await apiClient.getDeployments();
    const deployments = allDeployments.filter((d) => d.org_id === org.org_id);

    if (deployments.length === 0) {
      p.log.error(`No MCPs found for ${org.name}`);
      return null;
    }
    if (deployments.length === 1) {
      logger.info("setup", `Selected deployment: ${deployments[0].name} (auto, only one)`);
      p.log.success(`Using MCP\n${dim(deployments[0].name)}`);
      return deployments[0];
    }
    const selected = await p.select({
      message: "Select an MCP",
      options: deployments.map((d) => ({ label: d.name, value: d.deployment_id })),
    });
    if (p.isCancel(selected)) return null;
    const d = deployments.find((d) => d.deployment_id === selected) ?? null;
    if (d) logger.info("setup", `Selected deployment: ${d.name}`);
    return d;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    p.log.error(`MCP selection failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepMintAPIKey(apiClient: Client, cfg: Config): Promise<string | null> {
  if (!cfg.deployment_id) {
    p.log.error("No MCP available for API key creation");
    return null;
  }

  if (cfg.api_key) {
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const valid = await apiClient.validateAPIKey(cfg.api_key, cfg.deployment_id!);
    logger.debug("setup", `Existing API key valid=${valid}`);
    if (valid) {
      p.log.success(`API key\n${dim("using existing")}`);
      return cfg.api_key;
    }
    p.log.warn("Existing API key is invalid, creating a new one...");
  }

  try {
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const resp = await apiClient.createAPIKey(cfg.deployment_id!, "dosu-cli");
    logger.info("setup", "API key created");
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
      label: p.name(),
      value: p.id(),
      hint: configured ? "configured" : undefined,
    };
  });

  const preselected = detected.filter((p) => configuredMap.get(p.id())).map((p) => p.id());

  const selected = await p.multiselect({
    message: "Select agents to configure or update",
    options,
    initialValues: preselected,
  });

  if (p.isCancel(selected)) return null;

  const selectedSet = new Set(selected as string[]);
  const result: ToolSelection = { toInstall: [], toRemove: [], skipped: [] };

  for (const provider of detected) {
    const isSelected = selectedSet.has(provider.id());
    const isConfigured = configuredMap.get(provider.id()) ?? false;

    if (isSelected) result.toInstall.push(provider);
    else if (isConfigured) result.toRemove.push(provider);
  }

  return result;
}

export function stepConfigureTools(cfg: Config, selection: ToolSelection): ConfigResult[] {
  const results: ConfigResult[] = [];

  for (const provider of selection.toInstall) {
    try {
      provider.install(cfg, true);
      logger.info("setup", `Configured ${provider.name()}`);
      results.push({ provider, action: "install" });
    } catch (err: unknown) {
      /* v8 ignore next -- err is always Error in practice */
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        "setup",
        `Config failed for ${provider.name()}: ${error.stack ?? error.message}`,
      );
      p.log.error(`Failed to configure ${provider.name()}: ${error.message}`);
      results.push({ provider, action: "install", error });
    }
  }

  for (const provider of selection.toRemove) {
    try {
      provider.remove(true);
      logger.info("setup", `Removed ${provider.name()}`);
      results.push({ provider, action: "remove" });
    } catch (err: unknown) {
      /* v8 ignore next -- err is always Error in practice */
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        "setup",
        `Remove failed for ${provider.name()}: ${error.stack ?? error.message}`,
      );
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
    p.log.success(`Configured ${installed.length} agent(s):\n${lines}`);
  }

  if (removed.length > 0) {
    const lines = removed
      .map((r) => `- ${r.provider.name()}\n  ${dim(r.provider.globalConfigPath())}`)
      .join("\n");
    p.log.info(`Removed from ${removed.length} agent(s):\n${lines}`);
  }

  if (installed.length === 0 && removed.length === 0 && skipped.length > 0) {
    p.log.success("All agents already configured. No changes needed.");
  }
}

/**
 * Post-setup nudge: a ready-to-paste prompt so the user can immediately try
 * Dosu in their configured AI agent. Rendered at the very end of the flow
 * (right before outro) so it's the last actionable thing they see — not
 * buried right after the MCP configuration step. The call site is responsible
 * for only invoking this when MCP was actually (re)configured this run, so
 * users who skip MCP don't get a tip they can't act on.
 */
export function showTryItOutPrompt(mode?: SetupMode): void {
  const prompt =
    mode === MODE_OSS
      ? `What can Dosu help me with? Pick an open source library related to my project and explain how it works.`
      : `Please use Dosu to host my AGENTS.md`;
  p.log.message(`Try it out! Paste this into your agent:\n\n${info(prompt)}`);
}
