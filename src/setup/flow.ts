/**
 * Setup flow — interactive wizard.
 */

import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import type { CallbackServer } from "../auth/server";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import type { TypedClient } from "../client/trpc";
import { installSkill } from "../commands/skill";
import {
  bindAccountIdentity,
  type Config,
  loadConfig,
  MODE_OSS,
  replaceLoginSession,
  type SetupMode,
  saveConfig,
  updateTarget,
} from "../config/config";
import { logger } from "../debug/logger";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { inGitWorkTree, stepUpdateAgentsMd } from "./agents-md-step";
import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";
import { launchAuditAgent, offerAuditHandoff } from "./audit-handoff";
import { browserFallbackHint, dim, info } from "./styles";

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
  updateAgentsMd: boolean;
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

interface CliOnboardingProfile {
  user_id?: string | null;
  finished_onboarding?: boolean | null;
  // The server also returns `cli_onboarding_enabled` (a dead feature flag);
  // the CLI deliberately no longer reads it.
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  const onboardingRunID = randomUUID();
  logger.info(
    "setup",
    `Setup flow started${opts.deploymentID ? ` deployment=${opts.deploymentID}` : ""}${
      opts.mode ? ` mode=${opts.mode}` : ""
    }`,
  );
  p.intro("Dosu CLI Setup");
  await trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_launch_attempted", {
    has_deployment_option: Boolean(opts.deploymentID),
    mode_option: opts.mode,
  });

  let cfg = loadConfig();

  applyModeOverride(cfg, opts);

  // --deployment implies Cloud; otherwise default to Cloud unless --mode oss.
  if (opts.deploymentID) {
    cfg.mode = undefined;
    saveConfig(cfg);
  }

  // Authenticate — always runs so we can verify/refresh tokens. When the
  // browser was involved, `authTab` steers that same tab onward (into the
  // web onboarding wizard) instead of opening a second one.
  const authed = await stepAuthenticate(cfg, onboardingRunID);
  if (!authed) return;
  cfg = authed.cfg;
  const authTab = authed.authTab;
  const releaseAuthTab = () => {
    authTab?.setNext(null);
    authTab?.close();
  };
  await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_auth_completed");

  let apiClient = new Client(cfg);
  let cloudSetupContext: CloudSetupContext | null = null;

  if (cfg.mode !== MODE_OSS) {
    const s = p.spinner();
    s.start("Loading your workspace...");
    cloudSetupContext = await resolveCloudSetupContext(cfg);
    if (!cloudSetupContext) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "cloud_setup_context_failed",
      });
      s.stop("Workspace load failed");
      releaseAuthTab();
      return;
    }
    s.stop("Workspace loaded");
  }
  await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_started", {
    flow_kind: cloudSetupContext?.kind ?? "oss",
  });

  // First-run web onboarding applies to cloud-mode users who haven't
  // finished onboarding — unless they passed `--deployment`, which is an
  // explicit "just wire me to this deployment" escape hatch that must never
  // be silently overridden by the onboarding auto-bind.
  const firstRunOnboarding =
    cfg.mode !== MODE_OSS && cloudSetupContext?.kind === "onboarding" && !opts.deploymentID;

  // Only the first-run web-onboarding handoff can steer the auth tab; every
  // other path lets the success page settle where it is.
  if (!firstRunOnboarding) {
    releaseAuthTab();
  }

  // Deployment: first-run onboarding binds the user's default deployment.
  // Otherwise we only run the interactive picker when we don't already have
  // a deployment id locked in, OR when the caller passed `--deployment` to
  // explicitly switch. Everyday re-runs reuse the stored deployment silently.
  if (firstRunOnboarding && cloudSetupContext) {
    // First-run: repo connection + docs import live in the web onboarding
    // wizard (the one code path we trust). Hand the browser over, wait for
    // the wizard to finish, then bind the deployment context it left behind.
    const onboarded = await stepWebOnboarding(cfg, onboardingRunID, authTab);
    if (!onboarded) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "web_onboarding_incomplete",
      });
      return;
    }
    // The browser may have completed onboarding under a different account.
    // Resolve the target again with the returned session; never reuse the
    // pre-handoff organization or client across an authentication boundary.
    apiClient = new Client(cfg);
    const targetOrg = await resolveCurrentOnboardingTargetOrg(cfg);
    const ok = await bindOnboardingDeployment(apiClient, cfg, targetOrg);
    if (!ok) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "onboarding_deployment_failed",
      });
      return;
    }
  } else if (!cfg.active_account?.target?.deployment_id || opts.deploymentID) {
    const ok = await resolveDeployment(apiClient, cfg, opts);
    if (!ok) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "deployment_resolution_failed",
      });
      return;
    }
  }

  // API key: `stepMintAPIKey` is idempotent — it validates an existing key
  // before minting a new one, so it's safe to call on every run.
  const apiKey = await stepMintAPIKey(apiClient, cfg);
  if (!apiKey) {
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
      reason: "api_key_failed",
    });
    return;
  }
  updateTarget(cfg, { api_key: apiKey });
  saveConfig(cfg);

  // One-shot confirm: MCP + skill are always listed (user picks what to
  // (re)run). Repo connection + docs import happen in the web onboarding
  // wizard, so the CLI no longer offers them here.
  const choices = await stepOneShotConfirm(inGitWorkTree());
  if (!choices) {
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_cancelled", {
      reason: "options_cancelled",
    });
    return;
  }
  await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_options_selected", {
    configure_mcp: choices.configureMcp,
    install_skill: choices.installSkill,
    update_agents_md: choices.updateAgentsMd,
  });

  // MCP tools. Track whether at least one agent ended up with Dosu MCP
  // configured (newly installed or previously installed) so we only offer
  // the audit handoff when there's actually an agent that can use Dosu.
  let mcpConfiguredThisRun = false;
  let mcpCompleted = false;
  let skillCompleted = false;
  if (choices.configureMcp) {
    const configured = await stepConfigureMcpTools(cfg);
    if (configured === null) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_cancelled", {
        reason: "mcp_selection_cancelled",
      });
      return;
    }
    mcpConfiguredThisRun = configured.some((r) => r.action === "install" || r.action === "skip");
    const configuredProviders = configured.filter(
      (r) => (r.action === "install" || r.action === "skip") && !r.error,
    );
    mcpCompleted = configuredProviders.length > 0;
    if (mcpCompleted) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_mcp_configured", {
        provider_count: configuredProviders.length,
        providers: configuredProviders.map((r) => r.provider.id()),
      });
    }
  }

  // Dosu skill
  if (choices.installSkill) {
    skillCompleted = await runInstallSkill();
    if (skillCompleted) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_skill_installed");
    }
  }

  // AGENTS.md — prompt coding agents to use the Dosu MCP tools. Only offered
  // (and run) when the cwd is a git work tree. Tracked via the
  // `completed_agents_md` property on cli_onboarding_completed — the backend
  // event enum has no dedicated event for this step.
  let agentsMdCompleted = false;
  if (choices.updateAgentsMd) {
    agentsMdCompleted = stepUpdateAgentsMd();
  }

  // Codebase audit handoff (cloud mode only — it acts on the user's own
  // repo): offer to launch Claude Code with the audit prompt so there's no
  // gap between finishing setup and seeing what Dosu can generate.
  let handoffToAudit = false;
  if (mcpConfiguredThisRun && cfg.mode !== MODE_OSS) {
    handoffToAudit = await offerAuditHandoff();
  }

  if (mcpCompleted || skillCompleted || agentsMdCompleted) {
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_completed", {
      completed_mcp: mcpCompleted,
      completed_skill: skillCompleted,
      completed_agents_md: agentsMdCompleted,
    });
  }

  if (cfg.mode === MODE_OSS) {
    p.outro(
      "Setup complete! Using open-source libraries only.\n\nTips: Run `dosu setup --mode cloud` to connect your own repos.",
    );
  } else {
    p.outro("\uD83C\uDF89 Setup complete!");
  }

  // Launch after the outro so Claude Code takes over a finished clack session.
  if (handoffToAudit) {
    launchAuditAgent();
  }
}

/**
 * Copy the four deployment fields onto cfg. Caller decides whether to also
 * clear `cfg.mode` (Cloud paths do; the OSS auto-pick path doesn't).
 */
function applyDeployment(cfg: Config, d: Deployment): void {
  updateTarget(cfg, {
    deployment_id: d.deployment_id,
    deployment_name: d.name,
    org_id: d.org_id,
    space_id: d.space_id,
  });
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
 * time (add a new agent, reinstall the skill). Repo connection + docs
 * import happen in the web onboarding wizard, not here.
 */
async function stepOneShotConfirm(offerAgentsMd: boolean): Promise<OneShotChoices | null> {
  type Item = { value: keyof OneShotChoices; label: string };
  const items: Item[] = [
    { value: "configureMcp", label: "Install Dosu MCP" },
    { value: "installSkill", label: "Install Dosu skill" },
  ];
  if (offerAgentsMd) {
    items.push({ value: "updateAgentsMd", label: "Add Dosu instructions to AGENTS.md" });
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
    updateAgentsMd: chosen.has("updateAgentsMd"),
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

interface AuthenticatedSetup {
  cfg: Config;
  /**
   * Present when this run authenticated via the browser: the still-open
   * callback server whose success page polls /next, letting the setup flow
   * steer that same tab onward (web onboarding) instead of opening another.
   */
  authTab?: CallbackServer;
}

async function stepAuthenticate(
  existingCfg?: Config,
  onboardingRunID?: string,
): Promise<AuthenticatedSetup | null> {
  logger.info("setup", "Step: authenticate");
  const cfg = existingCfg ?? loadConfig();

  if (cfg.active_account?.session.access_token) {
    const s = p.spinner();
    s.start("Verifying session...");
    try {
      const apiClient = new Client(cfg);
      const resp = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
      if (resp.status === 200) {
        logger.info("setup", `Session verified, status=${resp.status}`);
        s.stop("Authenticated");
        return { cfg };
      }
      try {
        logger.debug("setup", "Attempting token refresh");
        await apiClient.refreshToken();
        const resp2 = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
        if (resp2.status === 200) {
          s.stop("Authenticated");
          return { cfg };
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

  if (onboardingRunID) {
    await trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_started");
  }
  return await openBrowserForSetup(cfg, onboardingRunID);
}

async function openBrowserForSetup(
  cfg: Config,
  onboardingRunID?: string,
): Promise<AuthenticatedSetup | null> {
  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const s = p.spinner();
    const result = await startOAuthFlow(
      undefined,
      "/cli/auth",
      onboardingRunID ? { onboarding_run_id: onboardingRunID } : {},
      undefined,
      {
        waitWithoutBrowser: true,
        // Keep the callback server alive so the success page's tab can be
        // steered into the web onboarding wizard for first-run users.
        holdNext: true,
        onAuthURL: (url) => {
          p.log.message(browserFallbackHint(url));
          s.start("Waiting for authentication...");
        },
      },
    );
    /* v8 ignore next 4 -- unreachable with waitWithoutBrowser */
    if (!result.browserOpened) {
      s.stop("Could not open a browser");
      return null;
    }
    const token = result.token;
    s.stop("Authenticated");
    logger.info("setup", "Browser auth completed");

    replaceLoginSession(cfg, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    });
    saveConfig(cfg);
    return { cfg, authTab: result.server };
  } catch (err: unknown) {
    /* v8 ignore next 2 -- err is always Error in practice */
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error("setup", `Auth failed: ${msg}`);
    const { OAuthCallbackError } = await import("../auth/errors");
    if (err instanceof OAuthCallbackError) {
      p.log.error(err.userMessage);
      if (onboardingRunID) {
        await trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_failed", {
          reason: err.errorCode ?? err.errorDescription ?? "oauth_callback_error",
        });
      }
      return null;
    }
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    if (onboardingRunID) {
      await trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

/**
 * First-run onboarding handoff: repo connection + docs import happen in the
 * web onboarding wizard, not the terminal. Opens the browser at
 * `/onboarding/connections?source=cli&callback=…` — the wizard detects the
 * CLI flow, skips its "set up the CLI" step, marks onboarding finished on
 * the server, and redirects back to the local callback with a freshly
 * minted CLI session (same payload shape as the auth callback, so
 * `startOAuthFlow` provides the listener, browser open, and timeout).
 *
 * Returns `true` once the wizard handed back, `false` on timeout/failure
 * (with a hint to finish in the browser and re-run `dosu setup`).
 *
 * When `authTab` is present (this run authenticated via the browser), the
 * auth success page is steered straight into the wizard via `setNext` — one
 * tab for the whole journey. Without it, a fresh tab is opened.
 */
async function stepWebOnboarding(
  cfg: Config,
  onboardingRunID: string,
  authTab?: CallbackServer,
): Promise<boolean> {
  logger.info("setup", "Step: web onboarding handoff");
  p.log.info("Almost there — connect your repos in the browser and we'll pick up from here.");
  const s = p.spinner();
  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const result = await startOAuthFlow(
      undefined,
      "/onboarding/connections",
      { source: "cli", onboarding_run_id: onboardingRunID },
      undefined,
      {
        waitWithoutBrowser: true,
        suppressBrowserOpen: Boolean(authTab),
        successVariant: "onboarding",
        onAuthURL: (url) => {
          authTab?.setNext(url);
          p.log.message(browserFallbackHint(url));
          s.start("Waiting for onboarding to finish in the browser...");
        },
      },
    );
    /* v8 ignore next 4 -- unreachable with waitWithoutBrowser */
    if (!result.browserOpened) {
      s.stop("Could not open a browser");
      return false;
    }
    // The wizard may hand back a session for a different browser account.
    // Replace the account aggregate: same-account auth keeps its target, while
    // an account change drops the old target before resolving the new one.
    replaceLoginSession(cfg, {
      access_token: result.token.access_token,
      refresh_token: result.token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + result.token.expires_in,
    });
    saveConfig(cfg);
    s.stop("Onboarding finished in the browser");
    logger.info("setup", "Web onboarding handoff completed");
    return true;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Web onboarding handoff did not complete: ${msg}`);
    s.stop("Onboarding not completed");
    p.log.warn(
      "Didn't hear back from the browser. Finish onboarding there, then re-run `dosu setup`.",
    );
    return false;
  } finally {
    // The auth tab either navigated into the wizard already or was closed by
    // the user; either way its server has served its purpose.
    authTab?.close();
  }
}

async function resolveCloudSetupContext(cfg: Config): Promise<CloudSetupContext | null> {
  try {
    const { createTypedClient } = await import("../client/trpc");
    const trpc = createTypedClient(cfg);
    const profile: CliOnboardingProfile | null = await trpc.user.getCliOnboardingContext.query();

    if (!profile?.user_id) {
      p.log.error("Could not load your profile.");
      return null;
    }
    bindAccountIdentity(cfg, profile.user_id);
    saveConfig(cfg);

    // First-run detection is driven purely by `finished_onboarding`. The old
    // `cli_onboarding_enabled` flag gated a terminal-local onboarding path
    // that no longer exists — first-run users now finish onboarding in the
    // web wizard via `stepWebOnboarding`.
    if (profile.finished_onboarding === true) {
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

async function resolveOnboardingTargetOrg(trpc: TypedClient): Promise<OwnedOrg | null> {
  const accessibleOrgs: OwnedOrg[] = await trpc.organization.getOrganizations.query();
  const ownerOrg = accessibleOrgs.find((org) => org.user_role === "OWNER");
  if (ownerOrg) {
    return ownerOrg;
  }
  return accessibleOrgs[0] ?? null;
}

async function resolveCurrentOnboardingTargetOrg(cfg: Config): Promise<OwnedOrg | null> {
  try {
    const { createTypedClient } = await import("../client/trpc");
    const trpc = createTypedClient(cfg);
    const profile: CliOnboardingProfile | null = await trpc.user.getCliOnboardingContext.query();
    if (!profile?.user_id) return null;
    bindAccountIdentity(cfg, profile.user_id);
    saveConfig(cfg);
    return await resolveOnboardingTargetOrg(trpc);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to resolve post-onboarding organization: ${msg}`);
    p.log.error(`Could not determine your onboarding organization: ${msg}`);
    return null;
  }
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
  applyDeployment(cfg, deployment);
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
    orgDeployments.find((deployment) => deployment.provider_slug === MCP_PROVIDER_SLUG) ??
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
    applyDeployment(cfg, d);
    return true;
  }
  if (cfg.mode === MODE_OSS) {
    const deployments = await fetchDeployments(apiClient);
    if (deployments.length > 0) {
      applyDeployment(cfg, deployments[0]);
    }
    return true;
  }
  const org = await stepSelectOrg(apiClient);
  if (!org) return false;
  const d = await stepSelectDeployment(apiClient, org);
  if (!d) return false;
  cfg.mode = undefined;
  applyDeployment(cfg, d);
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
  const target = cfg.active_account?.target;
  const deploymentID = target?.deployment_id;
  if (!deploymentID) {
    p.log.error("No MCP available for API key creation");
    return null;
  }

  if (target.api_key) {
    const valid = await apiClient.validateAPIKey(target.api_key, deploymentID);
    logger.debug("setup", `Existing API key valid=${valid}`);
    if (valid) {
      p.log.success(`API key\n${dim("using existing")}`);
      return target.api_key;
    }
    p.log.warn("Existing API key is invalid, creating a new one...");
  }

  try {
    const resp = await apiClient.createAPIKey(deploymentID, "dosu-cli");
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
      hint: configured ? "configured — untick to remove" : undefined,
    };
  });

  const preselected = detected.filter((p) => configuredMap.get(p.id())).map((p) => p.id());

  const selected = await p.multiselect({
    message: "Select agents — tick to configure, untick to remove",
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
