/**
 * Setup flow — interactive wizard.
 */

import { randomUUID } from "node:crypto";
import * as p from "@clack/prompts";
import { isTRPCClientError } from "@trpc/client";
import { OAuthCallbackError } from "../auth/errors";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import type { TypedClient } from "../client/trpc";
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
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { getHookAgent } from "../hooks/agents";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { inGitWorkTree, stepUpdateAgentsMd } from "./agents-md-step";
import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";
import { stepConnectGitHubRepo } from "./github-step";
import {
  type LogsHandoffDecision,
  type LogsHandoffPlan,
  launchLogsAgent,
  offerLogsHandoff,
} from "./logs-handoff";
import { stepConfigureAgentRules } from "./rules-step";
import { browserFallbackHint, dim, formatSetupSummary, IconRemove, info } from "./styles";

export interface SetupOptions {
  deploymentID?: string;
  /** Force a specific mode, bypassing the default. "cloud" = standard flow, "oss" = public-libraries-only. */
  mode?: SetupMode | "cloud";
}

export type ConfigAction = "install" | "remove" | "skip";

interface HookResult {
  name: string;
  path: string;
  note?: string;
}

export interface ConfigResult {
  provider: SetupProvider;
  action: ConfigAction;
  error?: Error;
  /** Set when a knowledge sync hook was enabled alongside this agent's MCP install. */
  hook?: HookResult;
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

const OAUTH_ANALYTICS_REASONS = new Set([
  "access_denied",
  "bad_oauth_state",
  "invalid_request",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_response_type",
]);

function trackInBackground(tracking: Promise<void>): void {
  void tracking.catch(() => {});
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
  trackInBackground(
    trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_launch_attempted", {
      has_deployment_option: Boolean(opts.deploymentID),
      mode_option: opts.mode,
    }),
  );

  let cfg = loadConfig();

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
  trackInBackground(trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_auth_completed"));

  let apiClient = new Client(cfg);
  let cloudSetupContext: CloudSetupContext | null = null;

  if (cfg.mode !== MODE_OSS) {
    const s = p.spinner();
    s.start("Loading your workspace...");
    cloudSetupContext = await resolveCloudSetupContext(cfg);
    if (!cloudSetupContext) {
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "cloud_setup_context_failed",
        }),
      );
      s.stop("Workspace load failed");
      return;
    }
    s.stop("Workspace loaded");
  }
  trackInBackground(
    trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_started", {
      flow_kind: cloudSetupContext
        ? cloudSetupContext.finishedOnboarding
          ? "setup"
          : "onboarding"
        : "oss",
    }),
  );

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
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "web_onboarding_incomplete",
        }),
      );
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
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "cloud_setup_context_failed",
        }),
      );
      return;
    }
    if (!refreshed.finishedOnboarding) {
      // At most one trip per process — never a handshake loop. This is the
      // permanent guard for a web tier that didn't route the wizard
      // (deploy skew): tell the user, exit cleanly, let a re-run retry.
      p.log.warn(
        "Your account still needs onboarding. Finish it in the browser at the Dosu app, then re-run `dosu setup`.",
      );
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "onboarding_incomplete_after_handshake",
        }),
      );
      // The one deliberately non-zero setup exit: scripts chaining
      // `dosu setup && …` must not proceed on a half-onboarded account.
      process.exitCode = 1;
      return;
    }
    cloudSetupContext = refreshed;
  }

  // Deployment: run the picker only when nothing is locked in yet, or when
  // `--deployment` explicitly asks to switch. Everyday re-runs reuse the
  // stored deployment silently. (After an account change the handshake
  // dropped the old target, so the fresh account resolves here —
  // stepSelectDeployment auto-picks the single real MCP.)
  if (!cfg.active_account?.target?.deployment_id || opts.deploymentID) {
    const ok = await resolveDeployment(apiClient, cfg, opts);
    if (!ok) {
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
          reason: "deployment_resolution_failed",
        }),
      );
      return;
    }
  }

  // GitHub guard (cloud only): an MCP whose space has no connected repo
  // answers from nothing. Offer the interactive connect step; the user can
  // choose to continue without it, and the source lookup is fail-open, so
  // setup never blocks on this step.
  if (cfg.mode !== MODE_OSS) {
    await stepOfferGithubConnect(cfg);
  }

  // API key: `stepMintAPIKey` is idempotent — it validates an existing key
  // before minting a new one, so it's safe to call on every run.
  const apiKey = await stepMintAPIKey(apiClient, cfg);
  if (!apiKey) {
    trackInBackground(
      trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_failed", {
        reason: "api_key_failed",
      }),
    );
    return;
  }
  updateTarget(cfg, { api_key: apiKey });
  saveConfig(cfg);

  // Agent selection is the only install choice. Every successfully configured
  // agent receives the full supported bundle: MCP, rules, and skill.
  const configured = await stepConfigureMcpTools(cfg);
  if (configured === null) {
    trackInBackground(
      trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_cancelled", {
        reason: "mcp_selection_cancelled",
      }),
    );
    return;
  }

  const configuredProviders = configured.filter(
    (result) => (result.action === "install" || result.action === "skip") && !result.error,
  );
  const mcpCompleted = configuredProviders.length > 0;
  if (mcpCompleted) {
    trackInBackground(
      trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_mcp_configured", {
        provider_count: configuredProviders.length,
        providers: configuredProviders.map((result) => result.provider.id()),
      }),
    );
  }

  // Skill installation follows the same agent selection as MCP and rules.
  // Unsupported clients are left alone rather than broadening the install
  // to every agent on the machine.
  let skillCompleted = false;
  const skillProviders = configuredProviders
    .map((result) => result.provider)
    .filter((provider) => skillInstallTargetForProvider(provider.id()) !== null);
  if (skillProviders.length > 0) {
    skillCompleted = await runInstallSkill(skillProviders);
    if (skillCompleted) {
      trackInBackground(
        trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_skill_installed"),
      );
    }
  }

  // Project instructions are part of the bundle when setup runs inside a git
  // work tree and at least one agent was configured.
  let agentsMdCompleted = false;
  if (mcpCompleted && inGitWorkTree()) {
    agentsMdCompleted = await stepUpdateAgentsMd();
  }

  // Post-setup log mining (cloud mode only): replaces the old codebase-audit
  // CTA. Kickoff prefers agents the user just configured (Cursor / Claude / Codex).
  // Gated on a git work tree, like the audit CTA it replaces: the handoff gives
  // the terminal to a coding agent rooted at cwd, and `npx @dosu/cli setup` is
  // routinely run straight from $HOME or a scratch directory.
  let logsPlan: LogsHandoffPlan | null = null;
  let logsHandoff: LogsHandoffDecision | undefined;
  if (mcpCompleted && cfg.mode !== MODE_OSS && inGitWorkTree()) {
    const preferredAgents = configuredProviders.map((result) => result.provider.id());
    const offer = await offerLogsHandoff({ preferredAgents });
    logsPlan = offer.plan;
    logsHandoff = offer.decision;
  }

  if (mcpCompleted || skillCompleted || agentsMdCompleted) {
    trackInBackground(
      trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_completed", {
        completed_mcp: mcpCompleted,
        completed_skill: skillCompleted,
        completed_agents_md: agentsMdCompleted,
        completed_logs_handoff: logsHandoff === "accepted",
        ...(logsHandoff ? { logs_handoff: logsHandoff } : {}),
      }),
    );
  }

  if (cfg.mode === MODE_OSS) {
    p.outro(
      "Setup complete! Using open-source libraries only.\n\nTips: Run `dosu setup --mode cloud` to connect your own repos.",
    );
  } else {
    p.outro("\uD83C\uDF89 Setup complete!");
  }

  // Launch after the outro so the agent takes over a finished clack session.
  if (logsPlan) {
    launchLogsAgent(logsPlan);
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
  await stepConfigureAgentRules(selection, results);
  return results;
}

/**
 * Install the skill for the same providers selected during MCP setup.
 * Returns `true` on success.
 */
export async function runInstallSkill(providers: readonly SetupProvider[]): Promise<boolean> {
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
      { quiet: true },
    );
    if (result.success) {
      logger.info("setup", `Skill installed${result.sha ? ` sha=${result.sha}` : ""}`);
      const items = providers.flatMap((provider) => {
        const target = skillInstallTargetForProvider(provider.id());
        if (!target) return [];
        return [
          {
            label: provider.name(),
            path: target.path,
            status: target.symlink ? "symlink" : undefined,
          },
        ];
      });
      spinner.stop("Skill installed");
      p.log.success(formatSetupSummary(`Skill ready for ${items.length} agent(s):`, items));
      return true;
    }
    spinner.stop("Skill install failed");
    p.log.error("Failed to install skill. Run `dosu skill install` to retry.");
    return false;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Skill install failed: ${msg}`);
    spinner.stop("Skill install failed");
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
    trackInBackground(
      trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_started"),
    );
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
    if (err instanceof OAuthCallbackError) {
      p.log.error(err.userMessage);
      if (onboardingRunID) {
        trackInBackground(
          trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_failed", {
            reason: cliAuthFailureReason(err),
          }),
        );
      }
      return null;
    }
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
    if (onboardingRunID) {
      trackInBackground(
        trackCliOnboardingPreAuthEvent(onboardingRunID, "cli_onboarding_auth_failed", {
          reason: cliAuthFailureReason(err),
        }),
      );
    }
    return null;
  }
}

/** Stable, low-cardinality analytics reason. Raw OAuth/error text may contain local data. */
export function cliAuthFailureReason(err: unknown): string {
  if (!(err instanceof OAuthCallbackError)) return "unexpected_auth_error";
  const code = err.errorCode;
  return code && OAUTH_ANALYTICS_REASONS.has(code) ? code : "oauth_callback_error";
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

/**
 * When the selected MCP's space has no GitHub source in its Library yet, warn
 * and offer the interactive GitHub connect step (`stepConnectGitHubRepo`:
 * browser App install + repo multiselect). Choosing "Skip for now" prints
 * where to do it later and setup proceeds.
 *
 * Repos connect at space level, so the guard checks the space this MCP
 * serves — GitHub sources connected elsewhere in the org don't feed this MCP
 * and don't count.
 *
 * Fail-open by design: a failed lookup skips the offer silently —
 * this step is a nudge, never a gate, so setup always proceeds.
 */
async function stepOfferGithubConnect(cfg: Config): Promise<void> {
  const target = cfg.active_account?.target;
  // stepConnectGitHubRepo needs org+space context to connect anything, so
  // without it the offer could only dead-end.
  if (!target?.org_id || !target?.space_id) return;

  try {
    const { createTypedClient } = await import("../client/trpc");
    const trpc = createTypedClient(cfg);
    if (await spaceHasGithubSource(trpc, target.space_id)) return;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `GitHub source check failed, skipping offer: ${msg}`);
    return;
  }

  logger.info("setup", "Step: offer GitHub connect (no GitHub source in the MCP's Library)");
  p.log.warn("No GitHub repos are connected to this MCP yet — it can't answer from your code.");
  const connectNow = await p.confirm({
    message: "Connect a GitHub repo now?",
    active: "Connect now",
    inactive: "Skip for now",
    initialValue: true,
  });
  if (p.isCancel(connectNow) || !connectNow) {
    p.log.info(
      `Skipped. Connect later at ${info(`${getWebAppURL()}/libraries`)} or re-run ${info("dosu setup")}.`,
    );
    return;
  }
  await stepConnectGitHubRepo(cfg);
}

/**
 * The Library's attached sources (`libraries.sourcesList` — the same list the
 * web Library view shows) are the truth for "does this MCP answer from code".
 * Deployments are the wrong signal: removing a source in the web UI leaves its
 * Monitor (`github` deployment) row behind, and gating on deployments let that
 * orphan suppress the connect offer forever. Backends that predate the
 * libraries router fall back to the old deployment heuristic.
 */
async function spaceHasGithubSource(trpc: TypedClient, spaceID: string): Promise<boolean> {
  try {
    const sources = await trpc.libraries.sourcesList.query(spaceID);
    return (sources ?? []).some((source) => source.provider_slug === "github");
  } catch (err: unknown) {
    const missingProcedure =
      isTRPCClientError(err) && (err.data as { code?: string } | null)?.code === "NOT_FOUND";
    if (!missingProcedure) throw err;
    const spaceDeployments: { provider_slug?: string | null }[] | null =
      await trpc.workspaces.listForSpace.query(spaceID);
    return (spaceDeployments ?? []).some((d) => d.provider_slug === "github");
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

export function stepDetectTools(): SetupProvider[] {
  return allSetupProviders().filter((p) => p.isInstalled());
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

/**
 * Session-end knowledge sync hooks ride along with the MCP bundle: an agent
 * selected for install gets the hook enabled, an unticked agent gets it
 * removed. Not every MCP provider is hook-capable — `getHookAgent` decides.
 *
 * Fail-open: a hook config problem (e.g. an unparseable settings file) is
 * reported but never fails the agent's MCP setup.
 */
function syncSessionHook(providerID: string, action: "enable" | "disable"): HookResult | null {
  const agent = getHookAgent(providerID);
  if (!agent) return null;
  try {
    if (action === "enable") agent.enable();
    else agent.disable();
    logger.info("setup", `Knowledge sync hook ${action}d for ${providerID}`);
    const note = agent.enableNote?.();
    return { name: agent.name(), path: agent.configPath(), ...(note ? { note } : {}) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Knowledge sync hook ${action} failed for ${providerID}: ${msg}`);
    p.log.warn(`Could not ${action} the knowledge sync hook for ${agent.name()}: ${msg}`);
    return null;
  }
}

export function stepConfigureTools(cfg: Config, selection: ToolSelection): ConfigResult[] {
  const results: ConfigResult[] = [];

  for (const provider of selection.toInstall) {
    try {
      provider.install(cfg, true);
      logger.info("setup", `Configured ${provider.name()}`);
      const hook = syncSessionHook(provider.id(), "enable");
      results.push({ provider, action: "install", ...(hook ? { hook } : {}) });
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
      syncSessionHook(provider.id(), "disable");
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
    p.log.success(
      formatSetupSummary(
        `Configured ${installed.length} agent(s):`,
        installed.map((result) => ({
          label: result.provider.name(),
          path: result.provider.globalConfigPath(),
        })),
      ),
    );
  }

  // Knowledge sync hooks ride along with the MCP install; show them as their
  // own bundle item so users see exactly what was written where.
  const hooked = installed.flatMap((result) => (result.hook ? [result.hook] : []));
  if (hooked.length > 0) {
    p.log.success(
      `${formatSetupSummary(
        `Knowledge sync hooks enabled for ${hooked.length} agent(s):`,
        hooked.map((hook) => ({ label: hook.name, path: hook.path })),
      )}\n${dim(
        "Dosu scans finished agent sessions in the background. Disable anytime with 'dosu knowledge hooks disable'.",
      )}`,
    );
    for (const hook of hooked) {
      if (hook.note) p.log.info(dim(hook.note));
    }
  }

  if (removed.length > 0) {
    p.log.info(
      formatSetupSummary(
        `Removed from ${removed.length} agent(s):`,
        removed.map((result) => ({
          label: result.provider.name(),
          path: result.provider.globalConfigPath(),
        })),
        IconRemove,
      ),
    );
  }

  if (installed.length === 0 && removed.length === 0 && skipped.length > 0) {
    p.log.success("All agents already configured. No changes needed.");
  }
}
