/**
 * Setup flow — interactive wizard.
 */

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import { installSkill, skillInstallTargetForProvider } from "../commands/skill";
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
import {
  type ProjectFileMutationHooks,
  type ProjectFileMutationReceipt,
  removeProjectFile,
  writeProjectFile,
} from "../mcp/config-helpers";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { recordProjectProxyEndpoint } from "../mcp/project-proxy";
import { preflightProjectProxy } from "../mcp/project-proxy-preflight";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { type ProviderId, resolveProjectProof } from "../migration";
import { fetchDosuRule } from "../rules/installer";
import { VERSION } from "../version/version";
import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";
import { launchAuditAgent, offerAuditHandoff } from "./audit-handoff";
import {
  installProjectInstructions,
  providerUsesProjectInstructions,
  removeProjectInstructionAdapters,
} from "./project-instructions";
import { assertSafeProjectPath } from "./project-path";
import { requireProjectRoot } from "./project-root";
import { runProjectScopeMigration } from "./project-scope-migration";
import {
  type ProjectPinnedTargetResolution,
  type RequestedProjectTarget,
  resolveProjectPinnedTarget,
} from "./project-target";
import { browserFallbackHint, dim, formatSetupSummary, IconRemove, info } from "./styles";

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

interface CloudSetupContext {
  profileUserID: string;
  /**
   * Analytics + handshake trigger only — never a flow decider. The CLI's
   * view of this flag can be stale or belong to the wrong account (the
   * 2026-08-05 twin-account deadlock); a wrong value here costs at most one
   * redundant `/cli/auth` roundtrip, never a wrong irreversible branch. The
   * browser side owns the real onboarding routing.
   */
  finishedOnboarding: boolean;
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
  let projectRoot: string;
  try {
    projectRoot = requireProjectRoot();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(message);
    process.exitCode = 1;
    return;
  }
  let cfg = loadConfig();
  const setupProviders = allSetupProviders();
  const initialRequestedTarget = requestedProjectTarget(opts, cfg);
  // First pass is read-only and happens before authentication: reject every
  // foreign/invalid entry and repositories whose existing exact pins already
  // disagree. Explicit retargeting gets a second, selection-aware check just
  // before any project file can be written.
  const projectTarget = resolveProjectPinnedTarget(setupProviders, projectRoot);
  if (!projectTarget.ok) {
    p.log.error(projectTargetFailureMessage(projectTarget));
    process.exitCode = 1;
    return;
  }

  await trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_launch_attempted", {
    has_deployment_option: Boolean(opts.deploymentID),
    mode_option: opts.mode,
  });

  applyModeOverride(cfg, opts);

  // --deployment implies Cloud; otherwise default to Cloud unless --mode oss.
  if (opts.deploymentID) {
    cfg.mode = undefined;
    saveConfig(cfg);
  }

  // Authenticate — always runs so we can verify/refresh tokens. In cloud
  // mode the browser hop carries `intent=setup`, so a first-run user
  // completes the onboarding wizard inside that same trip.
  const authed = await stepAuthenticate(cfg, onboardingRunID);
  if (!authed) return;
  cfg = authed.cfg;
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
      return;
    }
    s.stop("Workspace loaded");
  }
  await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_started", {
    flow_kind: cloudSetupContext
      ? cloudSetupContext.finishedOnboarding
        ? "setup"
        : "onboarding"
      : "oss",
  });

  // The CLI-side flag only TRIGGERS one browser handshake — the browser
  // decides whether the wizard is actually needed (it knows who is really
  // signed in there). `--deployment` stays an explicit escape hatch that
  // must never be overridden.
  const needsHandshake =
    cfg.mode !== MODE_OSS &&
    cloudSetupContext !== null &&
    !cloudSetupContext.finishedOnboarding &&
    !opts.deploymentID;

  if (needsHandshake) {
    const handshook = await stepSetupHandshake(cfg, onboardingRunID);
    if (!handshook) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "web_onboarding_incomplete",
      });
      return;
    }
    // The browser may have handed back a different account — that is the
    // point: it knows who is really signed in. Re-resolve with the returned
    // session; never reuse anything across an authentication boundary.
    apiClient = new Client(cfg);
    const refreshed = await resolveCloudSetupContext(cfg);
    if (refreshed === null) {
      // Context load failed (it already printed the real error) — this is a
      // transient/API problem, not an onboarding state.
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "cloud_setup_context_failed",
      });
      return;
    }
    if (!refreshed.finishedOnboarding) {
      // At most one trip per process — never a handshake loop. This is the
      // permanent guard for a web tier that didn't route the wizard
      // (deploy skew): tell the user, exit cleanly, let a re-run retry.
      p.log.warn(
        "Your account still needs onboarding. Finish it in the browser at the Dosu app, then re-run `dosu setup`.",
      );
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "onboarding_incomplete_after_handshake",
      });
      // The one deliberately non-zero setup exit: scripts chaining
      // `dosu setup && …` must not proceed on a half-onboarded account.
      process.exitCode = 1;
      return;
    }
    cloudSetupContext = refreshed;
  }

  const detectedProviders = stepDetectTools(setupProviders);
  let projectDeploymentResolved = false;
  if (
    !opts.deploymentID &&
    opts.mode !== "oss" &&
    (opts.mode !== "cloud" ||
      initialRequestedTarget?.mode !== "cloud" ||
      !initialRequestedTarget.deploymentID)
  ) {
    // Existing pins were inspected before authentication, including clients
    // not installed on this machine. A Cloud request with no explicit ID may
    // reuse the repository's one proven Cloud pin; an explicit ID was already
    // checked for equality and is resolved by the normal explicit path below.
    if (projectTarget.target?.oss && !opts.mode) {
      cfg.mode = MODE_OSS;
    } else if (projectTarget.target?.deploymentID) {
      const ok = await resolveDeployment(apiClient, cfg, {
        ...opts,
        deploymentID: projectTarget.target.deploymentID,
      });
      if (!ok) {
        await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "project_deployment_unavailable",
        });
        return;
      }
      projectDeploymentResolved = true;
    }
  }

  // Deployment: run the picker only when nothing is locked in yet, or when
  // `--deployment` explicitly asks to switch. Everyday re-runs reuse the
  // stored deployment silently. (After an account change the handshake
  // dropped the old target, so the fresh account resolves here —
  // stepSelectDeployment auto-picks the single real MCP.)
  if (
    !projectDeploymentResolved &&
    (!cfg.active_account?.target?.deployment_id || opts.deploymentID)
  ) {
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
  recordProjectProxyEndpoint(cfg);
  saveConfig(cfg);

  // Agent selection is the only install choice. Every successfully configured
  // agent receives the full supported bundle: MCP, rules, and skill.
  const configuration = await stepConfigureMcpTools(
    cfg,
    projectRoot,
    Boolean(opts.deploymentID || opts.mode),
    detectedProviders,
    setupProviders,
    opts.deploymentID || opts.mode ? configuredProjectTarget(cfg) : undefined,
  );
  if (configuration === null) {
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_cancelled", {
      reason: "mcp_selection_cancelled",
    });
    return;
  }
  if (!configuration.ok) {
    process.exitCode = 1;
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
      reason: configuration.reason,
    });
    return;
  }
  const configured = configuration.results;
  const runtimeVerified = configuration.runtimeVerified;

  const mcpConfiguredThisRun = configured.some(
    (result) => result.action === "install" && !result.error,
  );
  const configuredProviders = configured.filter(
    (result) => result.action === "install" && !result.error,
  );
  const mcpCompleted = configuredProviders.length > 0;
  if (mcpCompleted) {
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_mcp_configured", {
      provider_count: configuredProviders.length,
      providers: configuredProviders.map((result) => result.provider.id()),
    });
  }

  // Skill installation follows the same agent selection as MCP and rules.
  // Unsupported clients are left alone rather than broadening the install
  // to every agent on the machine.
  let skillCompleted = false;
  const skillProviders = configuredProviders
    .map((result) => result.provider)
    .filter((provider) => skillInstallTargetForProvider(provider.id()) !== null);
  if (skillProviders.length > 0) {
    skillCompleted = await runInstallSkill(skillProviders, projectRoot);
    if (skillCompleted) {
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_skill_installed");
    }
  }

  // Project instructions are part of the bundle when setup runs inside a git
  // work tree and at least one agent was configured.
  let agentsMdCompleted = false;
  let instructionContent = "";
  const instructionProviderIDs = configuredProviders
    .map((result) => result.provider.id())
    .filter(providerUsesProjectInstructions);
  if (instructionProviderIDs.length > 0) {
    try {
      instructionContent = await fetchDosuRule();
      const projectInstructions = installProjectInstructions({
        projectRoot,
        providerIDs: instructionProviderIDs,
        content: instructionContent,
      });
      agentsMdCompleted = true;
      p.log.success(
        formatSetupSummary("Project instructions ready:", [
          { path: projectInstructions.agentsMd.path },
          ...projectInstructions.adapters.map((adapter) => ({ path: adapter.path })),
        ]),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("setup", `Project instruction install failed: ${message}`);
      p.log.error(`Could not configure project instructions: ${message}`);
    }
  }

  const projectBundleIncomplete =
    configured.some((result) => Boolean(result.error)) ||
    (skillProviders.length > 0 && !skillCompleted) ||
    (instructionProviderIDs.length > 0 && !agentsMdCompleted);
  if (projectBundleIncomplete) {
    p.log.error(
      "Project setup is incomplete. Legacy global configuration was preserved; fix the error above and re-run `dosu setup`.",
    );
    process.exitCode = 1;
    await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
      reason: "project_bundle_incomplete",
    });
    return;
  }

  if (configuredProviders.length > 0) {
    const project = resolveProjectProof(projectRoot);
    if (!project.ok) {
      p.log.error(
        "Could not re-verify the Git project before legacy cleanup. Project files remain installed and global configuration was preserved.",
      );
      process.exitCode = 1;
      return;
    }
    const providerIDs = configuredProviders.map((result) => result.provider.id()) as ProviderId[];
    const proxy =
      cfg.mode === MODE_OSS
        ? ({ packageVersion: VERSION, oss: true } as const)
        : {
            packageVersion: VERSION,
            deploymentID: cfg.active_account?.target?.deployment_id as string,
          };
    const migration = runProjectScopeMigration({
      project: project.proof,
      providerIDs,
      proxy,
      instructionContent,
      runtimeVerified,
    });
    for (const warning of migration.warnings) logger.warn("setup", warning);
    if (!migration.ok) {
      const cleanupProgress =
        migration.counts.removed > 0
          ? `${migration.counts.removed} proven global item(s) were already backed up and removed before cleanup stopped.`
          : "No global item was removed.";
      p.log.error(
        `Project setup succeeded, but safe legacy cleanup could not finish (${migration.reason}). ` +
          `${cleanupProgress} Nothing ambiguous was deleted. Recovery receipts: ${migration.receiptRoot}`,
      );
      process.exitCode = 1;
      await trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "legacy_migration_failed",
      });
      return;
    }
    if (migration.counts.removed > 0) {
      p.log.success(
        `Migrated ${migration.counts.removed} legacy global item(s). Recovery receipts: ${migration.receiptRoot}`,
      );
    }
    if (migration.counts.preserved > 0) {
      p.log.warn(
        `Preserved ${migration.counts.preserved} ambiguous global item(s); nothing unproven was deleted. Receipts: ${migration.receiptRoot}`,
      );
    }
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

function requestedProjectTarget(
  opts: SetupOptions,
  cfg: Config,
): RequestedProjectTarget | undefined {
  if (opts.deploymentID) return { mode: "cloud", deploymentID: opts.deploymentID };
  if (opts.mode === "oss") return { mode: "oss" };
  if (opts.mode === "cloud") {
    return {
      mode: "cloud",
      deploymentID: cfg.active_account?.target?.deployment_id,
    };
  }
  return undefined;
}

function configuredProjectTarget(cfg: Config): RequestedProjectTarget {
  return cfg.mode === MODE_OSS
    ? { mode: "oss" }
    : {
        mode: "cloud",
        deploymentID: cfg.active_account?.target?.deployment_id,
      };
}

function projectTargetFailureMessage(
  result: Extract<ProjectPinnedTargetResolution, { ok: false }>,
): string {
  const locations = result.paths.join(", ");
  if (result.reason === "ambiguous_project_config") {
    return (
      `Cannot safely use the project's Dosu MCP config because these entries are foreign or invalid: ${locations}. ` +
      "No project file was changed; inspect or remove those entries, then retry."
    );
  }
  if (result.reason === "requested_project_target_conflict") {
    return (
      `The requested Dosu target conflicts with existing project clients (${result.providers.join(", ")}): ${locations}. ` +
      "Make every listed client use the same target before retrying; no project file was changed."
    );
  }
  return (
    `This project has Dosu agent configs pointing at different MCPs (${result.providers.join(", ")}): ${locations}. ` +
    "Make every listed client use the same target before retrying; no project file was changed."
  );
}

/**
 * Runs MCP tool detection → selection → configuration as a single unit.
 * Returns the ConfigResult array on success, or null if the user cancelled.
 * An empty detection pool is treated as success (nothing to do).
 */
async function stepConfigureMcpTools(
  cfg: Config,
  projectRoot: string,
  allowProjectRetarget = false,
  detected: SetupProvider[] = stepDetectTools(),
  allProviders: readonly SetupProvider[] = detected,
  requestedTarget?: RequestedProjectTarget,
): Promise<
  | { ok: true; results: ConfigResult[]; runtimeVerified: boolean }
  | {
      ok: false;
      reason: "project_proxy_preflight_failed" | "project_target_conflict";
    }
  | null
> {
  if (detected.length === 0) {
    p.log.warn(
      `No supported AI agents detected on your system.\nRun ${info("dosu mcp add <agent>")} to manually configure an agent.`,
    );
    return { ok: true, results: [], runtimeVerified: false };
  }
  const selection = await stepSelectTools(detected, projectRoot);
  if (!selection) return null;
  if (allowProjectRetarget && requestedTarget && selection.toInstall.length > 0) {
    const targetCheck = resolveProjectPinnedTarget(
      allProviders,
      projectRoot,
      requestedTarget,
      selection.toInstall.map((provider) => provider.id()),
    );
    if (!targetCheck.ok) {
      p.log.error(projectTargetFailureMessage(targetCheck));
      return { ok: false, reason: "project_target_conflict" };
    }
  }
  let runtimeVerified = false;
  if (selection.toInstall.length > 0) {
    const preflight = await preflightProjectProxy(cfg, projectRoot);
    if (!preflight.ok) {
      p.log.error(
        `Could not start the project MCP (${preflight.reason}). No project files or legacy globals were changed.`,
      );
      return { ok: false, reason: "project_proxy_preflight_failed" };
    }
    runtimeVerified = true;
  }
  const results = stepConfigureTools(cfg, selection, projectRoot, allowProjectRetarget);
  stepShowSummary(results, projectRoot);
  // MCP writes/removals are one transaction. A shared-path skip (Claude while
  // Copilot retains .mcp.json) must not trigger adapter cleanup if any later
  // provider failed and caused the MCP batch to roll back.
  if (results.every((result) => !result.error)) {
    const deselectedProviders = new Set(selection.toRemove.map((provider) => provider.id()));
    const removedProviders = results
      .filter(
        (result) =>
          result.action === "remove" ||
          (result.action === "skip" && deselectedProviders.has(result.provider.id())),
      )
      .map((result) => result.provider.id());
    removeProjectInstructionAdapters(projectRoot, removedProviders);
  }
  return { ok: true, results, runtimeVerified };
}

/**
 * Install the skill for the same providers selected during MCP setup.
 * Returns `true` on success.
 */
export async function runInstallSkill(
  providers: readonly SetupProvider[],
  projectRoot?: string,
): Promise<boolean> {
  logger.info("setup", "Step: install skill");
  const spinner = p.spinner();
  const agentLabel = providers.length === 1 ? "agent" : "agents";
  spinner.start(`Installing skill for ${providers.length} ${agentLabel}`);
  try {
    // Interactive setup owns the summary UI. Keep the nested skills installer
    // quiet so its progress screens do not interrupt the standardized setup
    // results below. The standalone `dosu skill install` command remains
    // verbose.
    const result = await installSkill(
      providers.map((provider) => provider.id()),
      { quiet: true, projectRoot },
    );
    if (result.success) {
      logger.info("setup", `Skill installed${result.sha ? ` sha=${result.sha}` : ""}`);
      const items = providers.flatMap((provider) => {
        const target = skillInstallTargetForProvider(provider.id(), projectRoot);
        if (!target) return [];
        return [
          {
            label: provider.name(),
            path: target.path,
            status: target.symlink ? "symlink" : undefined,
          },
        ];
      });
      spinner.clear();
      p.log.success(formatSetupSummary(`Skill ready for ${items.length} agent(s):`, items));
      return true;
    }
    spinner.clear();
    p.log.error("Failed to install skill. Run `dosu skill install` to retry.");
    return false;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Skill install failed: ${msg}`);
    spinner.clear();
    p.log.error(`Skill install failed: ${msg}`);
    return false;
  }
}

interface AuthenticatedSetup {
  cfg: Config;
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
    // Cloud mode declares `intent=setup`: the web side routes a first-run
    // *browser* user through the onboarding wizard inside this same trip, so
    // the window must be handshake-sized. OSS users may never onboard — no
    // intent, plain auth timeout.
    const isCloud = cfg.mode !== MODE_OSS;
    const result = await startOAuthFlow(
      undefined,
      "/cli/auth",
      {
        ...(isCloud ? { intent: "setup" } : {}),
        ...(onboardingRunID ? { onboarding_run_id: onboardingRunID } : {}),
      },
      undefined,
      {
        waitWithoutBrowser: true,
        ...(isCloud ? { timeoutMs: SETUP_HANDSHAKE_TIMEOUT_MS } : {}),
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
    // Show WHICH account authenticated — a stale or twin-account session is
    // caught by eye here long before it can misroute anything. (SSO PKCE
    // callbacks carry no email; fall back to the generic word.)
    s.stop(token.email ? `Authenticated as ${token.email}` : "Authenticated");
    logger.info("setup", "Browser auth completed");

    replaceLoginSession(cfg, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    });
    saveConfig(cfg);
    return { cfg };
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
 * The setup handshake may contain the whole onboarding wizard — including a
 * GitHub App install that can sit on an org-admin approval — so it gets a
 * far longer window than a plain auth roundtrip.
 */
const SETUP_HANDSHAKE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * One browser handshake against the ONE protocol endpoint, `/cli/auth`.
 *
 * `intent=setup` tells the web side to route the *browser* user through the
 * onboarding wizard first when that user still needs it; either way the
 * callback comes back with a freshly minted session for whoever is really
 * signed in there — possibly a different account than the CLI held (the
 * caller re-resolves everything after). The CLI never deep-links a web
 * product page: the 2026-08-05 deadlock began with a wizard URL whose
 * middleware owed the CLI nothing.
 *
 * Returns `true` once the browser handed a session back, `false` on
 * timeout/failure.
 */
async function stepSetupHandshake(cfg: Config, onboardingRunID: string): Promise<boolean> {
  logger.info("setup", "Step: setup handshake");
  p.log.info("Almost there — finish setting up in the browser and we'll pick up from here.");
  const s = p.spinner();
  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const result = await startOAuthFlow(
      undefined,
      "/cli/auth",
      { intent: "setup", onboarding_run_id: onboardingRunID },
      undefined,
      {
        waitWithoutBrowser: true,
        successVariant: "onboarding",
        timeoutMs: SETUP_HANDSHAKE_TIMEOUT_MS,
        onAuthURL: (url) => {
          p.log.message(browserFallbackHint(url));
          s.start("Waiting for the browser...");
        },
      },
    );
    /* v8 ignore next 4 -- unreachable with waitWithoutBrowser */
    if (!result.browserOpened) {
      s.stop("Could not open a browser");
      return false;
    }
    // The browser may hand back a session for a different account. Replace
    // the account aggregate: same-account auth keeps its target, while an
    // account change drops the old target before resolving the new one.
    replaceLoginSession(cfg, {
      access_token: result.token.access_token,
      refresh_token: result.token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + result.token.expires_in,
    });
    saveConfig(cfg);
    s.stop(
      result.token.email ? `Authenticated as ${result.token.email}` : "Browser setup finished",
    );
    logger.info("setup", "Setup handshake completed");
    return true;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Setup handshake did not complete: ${msg}`);
    s.stop("Setup not completed");
    // An `?error=` callback IS an answer — surface the browser's real reason
    // instead of pretending we heard nothing.
    const { OAuthCallbackError } = await import("../auth/errors");
    if (err instanceof OAuthCallbackError) {
      p.log.error(err.userMessage);
      return false;
    }
    p.log.warn(
      "Didn't hear back from the browser. If it opened the Dosu app instead of the setup " +
        "wizard, your CLI and browser may be signed in to different accounts — run " +
        "`dosu logout`, then retry. Otherwise finish in the browser and re-run `dosu setup`.",
    );
    return false;
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

    return {
      profileUserID: profile.user_id,
      finishedOnboarding: profile.finished_onboarding === true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to resolve cloud setup context: ${msg}`);
    p.log.error(`Could not load your onboarding state: ${msg}`);
    return null;
  }
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
      logger.warn("setup", `Deployment ${id} is not accessible to the current account`);
      p.log.error(
        "This MCP is not accessible to the current Dosu account.\n" +
          "Make sure you are logged in to the correct account. Run `dosu logout`, then try again.",
      );
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
    // The onboarding wizard creates one repo-deployment per connected repo,
    // so a freshly onboarded org always has several deployments — but only
    // one real MCP. Never show users a picker full of their own repo names
    // when the answer is unambiguous.
    const mcpDeployments = deployments.filter((d) => d.provider_slug === MCP_PROVIDER_SLUG);
    if (mcpDeployments.length === 1) {
      logger.info("setup", `Selected deployment: ${mcpDeployments[0].name} (auto, single MCP)`);
      p.log.success(`Using MCP\n${dim(mcpDeployments[0].name)}`);
      return mcpDeployments[0];
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

export function stepDetectTools(
  providers: readonly SetupProvider[] = allSetupProviders(),
): SetupProvider[] {
  return providers.filter((provider) => provider.supportsLocal() && provider.isInstalled());
}

async function stepSelectTools(
  detected: SetupProvider[],
  projectRoot: string,
): Promise<ToolSelection | null> {
  const projectConfiguredMap = new Map<string, boolean>();
  const legacyGlobalMap = new Map<string, boolean>();
  for (const p of detected) {
    projectConfiguredMap.set(p.id(), p.isProjectConfigured(projectRoot));
    legacyGlobalMap.set(p.id(), p.isConfigured());
  }

  const options = detected.map((p) => {
    const projectConfigured = projectConfiguredMap.get(p.id()) ?? false;
    const legacyGlobal = legacyGlobalMap.get(p.id()) ?? false;
    return {
      label: p.name(),
      value: p.id(),
      hint: projectConfigured
        ? "configured here — untick to remove the project MCP"
        : legacyGlobal
          ? "legacy global config — selected to migrate"
          : undefined,
    };
  });

  const preselected = detected
    .filter(
      (provider) => projectConfiguredMap.get(provider.id()) || legacyGlobalMap.get(provider.id()),
    )
    .map((provider) => provider.id());

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
    const isProjectConfigured = projectConfiguredMap.get(provider.id()) ?? false;

    if (isSelected) result.toInstall.push(provider);
    else if (isProjectConfigured) result.toRemove.push(provider);
  }

  return result;
}

type ProjectConfigFileState =
  | { kind: "absent" }
  | {
      kind: "file";
      content: string;
      mode: number;
    };

interface ProjectConfigSnapshot {
  before: ProjectConfigFileState;
  /** Last exact state observed immediately after one of this batch's provider calls. */
  output?: ProjectConfigFileState;
  /** Actual writer preimage diverged from the batch view; whole-file rollback would lose edits. */
  rollbackConflict?: boolean;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Capture an exact project-config state without following a target symlink.
 * Metadata checks around the byte read reject a torn preimage.
 */
function captureProjectConfigState(
  projectRoot: string,
  configPath: string,
): ProjectConfigFileState {
  assertSafeProjectPath(projectRoot, configPath);
  try {
    const before = lstatSync(configPath, { bigint: true });
    if (!before.isFile()) throw new Error(`Project config is not a regular file: ${configPath}`);
    const content = readFileSync(configPath, "utf8");
    const after = lstatSync(configPath, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error(`Project config changed while it was being read: ${configPath}`);
    }
    return { kind: "file", content, mode: Number(after.mode & 0o777n) };
  } catch (error: unknown) {
    if (errnoCode(error) === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

function sameProjectConfigState(
  left: ProjectConfigFileState,
  right: ProjectConfigFileState,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  return left.mode === right.mode && left.content === right.content;
}

function rememberProjectConfigOutput(
  snapshot: ProjectConfigSnapshot,
  state: ProjectConfigFileState,
): void {
  const previous = snapshot.output ?? snapshot.before;
  if (!sameProjectConfigState(previous, state)) snapshot.output = state;
}

function receiptState(content: string | null, mode: number | null): ProjectConfigFileState | null {
  if (content === null) return mode === null ? { kind: "absent" } : null;
  return mode === null ? null : { kind: "file", content, mode };
}

function receiptProvesMutation(
  receipt: ProjectFileMutationReceipt | undefined,
  path: string,
  expectedBefore: ProjectConfigFileState,
  observedAfter: ProjectConfigFileState,
): boolean {
  if (!receipt || resolve(receipt.path) !== path) return false;
  const actualBefore = receiptState(receipt.beforeContent, receipt.beforeMode);
  const actualAfter = receiptState(receipt.afterContent, receipt.afterMode);
  return Boolean(
    actualBefore &&
      actualAfter &&
      sameProjectConfigState(actualBefore, expectedBefore) &&
      sameProjectConfigState(actualAfter, observedAfter),
  );
}

interface ProjectConfigRollback {
  restored: Set<string>;
  conflicts: Set<string>;
}

function rollbackProjectConfigs(
  projectRoot: string,
  snapshots: ReadonlyMap<string, ProjectConfigSnapshot>,
  changedPaths: readonly string[],
  mutationHooks?: ProjectFileMutationHooks,
): ProjectConfigRollback {
  const restored = new Set<string>();
  const conflicts = new Set<string>();

  for (const path of [...changedPaths].reverse()) {
    const snapshot = snapshots.get(path);
    if (!snapshot?.output) continue;
    if (snapshot.rollbackConflict) {
      conflicts.add(path);
      p.log.warn(`Kept ${path} because it changed inside a provider operation.`);
      continue;
    }
    try {
      const current = captureProjectConfigState(projectRoot, path);
      if (!sameProjectConfigState(current, snapshot.output)) {
        conflicts.add(path);
        p.log.warn(`Kept ${path} because it changed while setup was rolling back.`);
        continue;
      }

      if (snapshot.before.kind === "absent") {
        if (current.kind === "file") removeProjectFile(path, current.content, mutationHooks);
      } else {
        writeProjectFile(
          path,
          snapshot.before.content,
          current.kind === "file" ? current.content : null,
          mutationHooks,
        );
      }
      restored.add(path);
    } catch (error: unknown) {
      conflicts.add(path);
      const message = error instanceof Error ? error.message : String(error);
      logger.error("setup", `Could not safely roll back ${path}: ${message}`);
      p.log.warn(`Could not safely roll back ${path}: ${message}`);
    }
  }

  return { restored, conflicts };
}

function configOperationError(provider: SetupProvider, action: "install" | "remove", error: Error) {
  const verb = action === "install" ? "configure" : "remove";
  logger.error(
    "setup",
    `${action === "install" ? "Config" : "Remove"} failed for ${provider.name()}: ${error.stack ?? error.message}`,
  );
  p.log.error(`Failed to ${verb} ${provider.name()}: ${error.message}`);
}

export function stepConfigureTools(
  cfg: Config,
  selection: ToolSelection,
  projectRoot: string,
  allowProjectRetarget = false,
  rollbackHooks?: ProjectFileMutationHooks,
): ConfigResult[] {
  const results: ConfigResult[] = [];

  type ProjectConfigOperation = {
    provider: SetupProvider;
    action: "install" | "remove" | "skip";
    path: string | null;
  };

  const operations: ProjectConfigOperation[] = [];
  const addOperation = (provider: SetupProvider, action: "install" | "remove"): boolean => {
    try {
      const path = provider.projectConfigPath(projectRoot);
      operations.push({ provider, action, path: path ? resolve(path) : null });
      return true;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      configOperationError(provider, action, error);
      results.push({ provider, action, error });
      return false;
    }
  };

  for (const provider of selection.toInstall) {
    if (!addOperation(provider, "install")) return results;
  }
  const installedPaths = new Set(
    operations.map((operation) => operation.path).filter((path): path is string => path !== null),
  );
  for (const provider of selection.toRemove) {
    try {
      const path = provider.projectConfigPath(projectRoot);
      const normalizedPath = path ? resolve(path) : null;
      if (normalizedPath && installedPaths.has(normalizedPath)) {
        operations.push({ provider, action: "skip", path: normalizedPath });
      } else {
        operations.push({ provider, action: "remove", path: normalizedPath });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      configOperationError(provider, "remove", error);
      results.push({ provider, action: "remove", error });
      return results;
    }
  }

  // Capture every unique project config before the first provider can write.
  // Claude and Copilot intentionally share .mcp.json, so path-keying is part
  // of the transaction contract rather than an optimization.
  const snapshots = new Map<string, ProjectConfigSnapshot>();
  for (const operation of operations) {
    if (operation.action === "skip" || !operation.path || snapshots.has(operation.path)) continue;
    try {
      snapshots.set(operation.path, {
        before: captureProjectConfigState(projectRoot, operation.path),
      });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      configOperationError(operation.provider, operation.action, error);
      results.push({ provider: operation.provider, action: operation.action, error });
      return results;
    }
  }

  const changedPaths: string[] = [];
  let failedProvider: SetupProvider | null = null;

  for (const operation of operations) {
    if (operation.action === "skip") {
      results.push({ provider: operation.provider, action: "skip" });
      continue;
    }
    let providerCompleted = false;
    try {
      let expectedBefore: ProjectConfigFileState | undefined;
      if (operation.path) {
        const snapshot = snapshots.get(operation.path);
        if (snapshot) {
          const current = captureProjectConfigState(projectRoot, operation.path);
          const expected = snapshot.output ?? snapshot.before;
          if (!sameProjectConfigState(current, expected)) {
            throw new Error(
              `Project config changed after setup started; refusing to overwrite ${operation.path}`,
            );
          }
          expectedBefore = expected;
        }
      }
      let receipt: ProjectFileMutationReceipt | undefined;
      if (operation.action === "install") {
        receipt = operation.provider.install(cfg, false, { projectRoot, allowProjectRetarget });
        logger.info("setup", `Configured ${operation.provider.name()}`);
      } else {
        receipt = operation.provider.remove(false, { projectRoot });
        logger.info("setup", `Removed ${operation.provider.name()}`);
      }
      providerCompleted = true;
      if (operation.path) {
        const snapshot = snapshots.get(operation.path);
        if (snapshot) {
          const observedAfter = captureProjectConfigState(projectRoot, operation.path);
          const previousOutput = snapshot.output;
          rememberProjectConfigOutput(snapshot, observedAfter);
          if (!previousOutput && snapshot.output) changedPaths.push(operation.path);
          if (
            snapshot.output &&
            expectedBefore &&
            !receiptProvesMutation(receipt, operation.path, expectedBefore, observedAfter)
          ) {
            snapshot.rollbackConflict = true;
          }
        }
      }
      results.push({ provider: operation.provider, action: operation.action });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      failedProvider = operation.provider;
      configOperationError(operation.provider, operation.action, error);
      results.push({ provider: operation.provider, action: operation.action, error });
      if (providerCompleted && operation.path) {
        p.log.warn(
          `Could not prove the completed output at ${operation.path}; preserving it for safety.`,
        );
      }
      break;
    }
  }

  if (failedProvider) {
    const rollback = rollbackProjectConfigs(projectRoot, snapshots, changedPaths, rollbackHooks);
    for (const result of results) {
      if (result.error || result.action === "skip") continue;
      const path = result.provider.projectConfigPath(projectRoot);
      const normalizedPath = path ? resolve(path) : null;
      const rollbackStatus = normalizedPath
        ? rollback.restored.has(normalizedPath)
          ? "rolled back"
          : rollback.conflicts.has(normalizedPath)
            ? "not rolled back because the project file changed concurrently"
            : "cancelled"
        : "cancelled";
      result.error = new Error(
        `${result.provider.name()} was ${rollbackStatus} after ${failedProvider.name()} failed`,
      );
    }
  }

  for (const provider of selection.skipped) {
    results.push({ provider, action: "skip" });
  }

  return results;
}

export function stepShowSummary(
  results: ConfigResult[],
  projectRoot: string = process.cwd(),
): void {
  const installed = results.filter((r) => r.action === "install" && !r.error);
  const removed = results.filter((r) => r.action === "remove" && !r.error);
  const skipped = results.filter((r) => r.action === "skip");

  if (installed.length > 0) {
    p.log.success(
      formatSetupSummary(
        `Configured ${installed.length} agent(s):`,
        installed.map((result) => ({
          label: result.provider.name(),
          path: result.provider.projectConfigPath(projectRoot) ?? "unsupported",
        })),
      ),
    );
  }

  if (removed.length > 0) {
    p.log.info(
      formatSetupSummary(
        `Removed from ${removed.length} agent(s):`,
        removed.map((result) => ({
          label: result.provider.name(),
          path: result.provider.projectConfigPath(projectRoot) ?? "unsupported",
        })),
        IconRemove,
      ),
    );
  }

  if (installed.length === 0 && removed.length === 0 && skipped.length > 0) {
    p.log.success("All agents already configured. No changes needed.");
  }
}
