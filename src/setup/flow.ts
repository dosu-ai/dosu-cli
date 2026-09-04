/**
 * Setup flow — interactive wizard.
 */

import { randomUUID } from "node:crypto";
import { isTRPCClientError } from "@trpc/client";
import pc from "picocolors";
import { OAuthCallbackError } from "../auth/errors";
import { Client, type Deployment, type Org, SessionExpiredError } from "../client/client";
import type { TypedClient } from "../client/trpc";
import { installSkill, skillInstallTargetForProvider } from "../commands/skill";
import {
  bindAccountIdentity,
  type Config,
  isAuthenticated,
  loadConfig,
  MODE_OSS,
  replaceLoginSession,
  type SetupMode,
  saveConfig,
  updateTarget,
} from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import type { CliLibrary } from "../generated/dosu-api-types";
import { getHookAgent } from "../hooks/agents";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { spawnDetachedSelf } from "../sync/detach";
import { runKnowledgeSync } from "../sync/sync";
import { runActivityView } from "../tui/activity-view";
import { installCenteredLayout } from "../tui/layout";
import * as p from "../tui/prompts";
import { inGitWorkTree, stepUpdateAgentsMd } from "./agents-md-step";
import { trackCliOnboardingEvent, trackCliOnboardingPreAuthEvent } from "./analytics";
import { stepConnectGitHubRepo } from "./github-step";
import { stepConfigureAgentRules } from "./rules-step";
import {
  brand,
  brandBadge,
  browserFallbackHint,
  dim,
  formatSetupSummary,
  IconRemove,
  info,
} from "./styles";

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
  // Center the wizard in wide terminals; a no-op inside the TUI (which
  // already installed the layout) and in non-TTY contexts.
  const restoreLayout = installCenteredLayout();
  try {
    await runSetupFlow(opts);
  } finally {
    restoreLayout();
  }
}

async function runSetupFlow(opts: SetupOptions = {}): Promise<void> {
  const onboardingRunID = randomUUID();
  logger.info(
    "setup",
    `Setup flow started${opts.deploymentID ? ` deployment=${opts.deploymentID}` : ""}${
      opts.mode ? ` mode=${opts.mode}` : ""
    }`,
  );
  p.intro(`${brandBadge("dosu")} setup`);
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

  // Library (cloud only): show which Library the MCP answers from, and
  // persist its name so the welcome banner can display it. Fail-open — a
  // missing name never blocks setup.
  if (cfg.mode !== MODE_OSS) {
    await stepShowLibrary(cfg);
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

  if (mcpCompleted || skillCompleted || agentsMdCompleted) {
    trackInBackground(
      trackCliOnboardingEvent(cfg, onboardingRunID, "cli_onboarding_completed", {
        completed_mcp: mcpCompleted,
        completed_skill: skillCompleted,
        completed_agents_md: agentsMdCompleted,
      }),
    );
  }

  // Backfill offer: the hooks installed above only fire on FUTURE sessions,
  // so a fresh install would otherwise wait for new activity before Dosu
  // learns anything. Offer to mine the existing backlog now — with consent,
  // never automatically.
  if (mcpCompleted && cfg.mode !== MODE_OSS) {
    await stepOfferInitialSync(cfg);
  }

  if (cfg.mode === MODE_OSS) {
    p.outro(
      "Setup complete! Using open-source libraries only.\n\nTips: Run `dosu setup --mode cloud` to connect your own repos.",
    );
  } else {
    p.outro(setupOutroMessage(mcpCompleted));
  }
}

/**
 * Closing message for cloud setup. Knowledge syncs automatically via the
 * session-end hooks installed with the MCP bundle, so the outro points at
 * usage, not further setup chores.
 */
function setupOutroMessage(mcpCompleted: boolean): string {
  if (!mcpCompleted) return `${brand("\u2714")} Setup complete!`;
  const steps = [
    `${brand("1.")} Restart your AI agent so it picks up the Dosu MCP server`,
    `${brand("2.")} Ask it something, like ${info('"What does Dosu know about this repo?"')}`,
    `${brand("3.")} Dosu keeps learning from your finished agent sessions automatically`,
  ];
  return `${brand("\u2714")} You're all set!\n\n${steps.join("\n")}`;
}

/**
 * Offer to mine the existing session backlog right after the bundle is
 * installed. Uses the bootstrap scope (the entire local session history —
 * the hooks' rolling 30-day window would miss history that predates it).
 * The scan is gate-and-report only (no miner, no tokens); the prompt
 * appears only when there is actually something to mine, so everyday
 * re-runs of `dosu setup` stay quiet once the watermark has caught up. On
 * consent the sync runs fully detached and drains the whole backlog, so
 * setup never blocks on a gateway run.
 */
export async function stepOfferInitialSync(cfg: Config): Promise<void> {
  const target = cfg.active_account?.target;
  // Without an API key + deployment the detached run couldn't mine anyway.
  if (!target?.api_key || !target.deployment_id) return;

  logger.info("setup", "Step: offer initial knowledge sync");
  const s = p.spinner();
  s.start("Checking for recent agent sessions...");
  const outcome = await runKnowledgeSync({ bootstrap: true });
  if (outcome.status !== "backlog" || outcome.readySessions === 0) {
    s.stop("No unmined agent sessions found. Dosu will learn as you work.");
    return;
  }
  const n = outcome.readySessions;
  s.stop(`Found ${n} unmined agent session${n === 1 ? "" : "s"} on this machine.`);

  const mineNow = await p.confirm({
    message: `Mine ${n === 1 ? "it" : "them"} for team knowledge now? (runs in the background)`,
    active: "Mine now \u26CF\uFE0F",
    inactive: "Skip",
    initialValue: true,
  });
  if (p.isCancel(mineNow) || !mineNow) {
    p.log.info(
      `Skipped. Dosu picks sessions up in the background as you work, or run ${info("dosu knowledge sync")} anytime.`,
    );
    return;
  }

  if (spawnDetachedSelf(["knowledge", "sync", "--quiet", "--bootstrap"])) {
    p.log.success(
      "\u26CF\uFE0F Currently mining... Dosu is distilling your past sessions into team knowledge, a few at a time in the background.",
    );
    const watch = await p.confirm({
      message: "What next?",
      active: "Watch it work",
      inactive: "Go to home",
      initialValue: true,
    });
    if (!p.isCancel(watch) && watch) await runActivityView();
  } else {
    p.log.warn(`Could not start the background sync. Run ${info("dosu knowledge sync")} manually.`);
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
    org_name: d.org_name,
    space_id: d.space_id,
    // The Library belongs to the deployment's space; a stale name from a
    // previous deployment must never survive a switch.
    library_name: undefined,
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
  p.log.info("Almost there. Finish setting up in the browser and we'll pick up from here.");
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
        "wizard, your CLI and browser may be signed in to different accounts: run " +
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
  p.log.warn("No GitHub repos are connected to this MCP yet, so it can't answer from your code.");
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
/**
 * Show which Library (space) the selected MCP answers from and persist its
 * name for the welcome banner. The lookup is fail-open: on any error it
 * falls back to a previously stored name, or stays silent.
 */
async function stepShowLibrary(cfg: Config): Promise<void> {
  const target = cfg.active_account?.target;
  if (!target?.space_id) return;

  let name = target.library_name;
  try {
    const { createTypedClient } = await import("../client/trpc");
    const library = await createTypedClient(cfg).libraries.info.query(target.space_id);
    if (library?.name) {
      name = library.name;
      if (name !== target.library_name) {
        updateTarget(cfg, { library_name: name });
        saveConfig(cfg);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Library lookup failed, showing stored name if any: ${msg}`);
  }
  if (name) p.log.success(`Library ${dim(`\u00B7 ${name}`)}`);
}

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
  const d = await stepSelectDeployment(apiClient, cfg, org);
  if (!d) return false;
  cfg.mode = undefined;
  applyDeployment(cfg, d);
  return true;
}

/** What the settings switch re-picks: the whole org chain, or just the Library/MCP within it. */
export type SwitchScope = "org" | "library";

/**
 * Settings flow: re-pick the org / Library / MCP for an already-configured
 * install. Reuses the setup pickers, then refreshes everything derived from
 * the target — the API key and the Dosu MCP entries of agents that are
 * already configured (their config files embed the deployment URL and API
 * key, so a switch must rewrite them or they'd silently keep answering from
 * the previous Library). Unlike setup it never touches agent selection,
 * hooks, rules, skills, or mining.
 *
 * `scope` "library" keeps the current org and only re-picks the Library/MCP
 * inside it; "org" runs the full chain starting from the org picker.
 */
export async function runSwitchTarget(scope: SwitchScope = "org"): Promise<void> {
  const cfg = loadConfig();
  if (cfg.mode === MODE_OSS) {
    p.log.warn(
      `OSS mode uses public libraries only. Run ${info("dosu setup --mode cloud")} to connect an organization.`,
    );
    return;
  }
  if (!isAuthenticated(cfg)) {
    p.log.warn(`Not signed in. Run ${info("dosu setup")} to authenticate first.`);
    return;
  }
  logger.info("setup", `Switch target flow started (scope: ${scope})`);

  const apiClient = new Client(cfg);
  const org =
    scope === "library" ? await currentOrg(apiClient, cfg) : await stepSelectOrg(apiClient);
  if (!org) return;
  // An explicit Library switch always shows the Library list, even when only
  // one qualifies — a silent auto-pick would look like the menu did nothing.
  const d = await stepSelectDeployment(apiClient, cfg, org, {
    alwaysAskLibrary: scope === "library",
  });
  if (!d) return;
  applyDeployment(cfg, d);
  saveConfig(cfg);
  await stepShowLibrary(cfg);

  // Keys are scoped to the deployment: validate the stored one against the
  // new target and mint a replacement when it doesn't fit.
  const apiKey = await stepMintAPIKey(apiClient, cfg);
  if (!apiKey) return;
  updateTarget(cfg, { api_key: apiKey });
  saveConfig(cfg);

  const configured = allSetupProviders().filter((provider) => {
    try {
      return provider.isInstalled() && provider.isConfigured();
    } catch {
      return false;
    }
  });
  for (const provider of configured) {
    try {
      provider.install(cfg, true);
      logger.info("setup", `Switch: updated ${provider.name()}`);
      p.log.success(`${provider.name()} ${dim("\u00B7 updated")}`);
    } catch (err: unknown) {
      /* v8 ignore next -- err is always Error in practice */
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error("setup", `Switch: update failed for ${provider.name()}: ${error.message}`);
      p.log.error(`Failed to update ${provider.name()}: ${error.message}`);
    }
  }
  if (configured.length > 0) {
    p.log.info("Restart your AI agents so they pick up the new MCP target.");
  }
}

/**
 * The org the active target lives in, resolved by the stored org_id so a
 * Library-only switch never re-asks which org. Falls back to the org picker
 * when nothing is stored or the stored org is no longer accessible (e.g.
 * the user was removed from it).
 */
async function currentOrg(apiClient: Client, cfg: Config): Promise<Org | null> {
  const orgID = cfg.active_account?.target?.org_id;
  if (orgID) {
    try {
      const org = (await apiClient.getOrgs()).find((o) => o.org_id === orgID);
      if (org) {
        p.log.success(`Organization ${dim(`\u00B7 ${org.name}`)}`);
        return org;
      }
      logger.warn("setup", `Stored org ${orgID} not in the account's org list; asking`);
    } catch {
      // The picker path below surfaces list failures with proper messaging.
    }
  }
  return stepSelectOrg(apiClient);
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
      p.log.success(`Organization ${dim(`\u00B7 ${orgs[0].name}`)}`);
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
    p.log.success(`MCP ${dim(`\u00B7 ${d.name}`)}`);
    return d;
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    p.log.error(`Failed to resolve MCP: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Sentinel: the user cancelled the Library picker (distinct from "no narrowing"). */
const LIBRARY_SELECT_CANCELLED = Symbol("library-select-cancelled");

/**
 * When the org's deployments span more than one Library, ask which Library
 * the MCP should answer from — listed by name, the same names the web
 * Library switcher shows — and return it so the deployment choice can be
 * narrowed to that Library's space. Libraries without an MCP deployment are
 * offered too, marked "no MCP yet": selecting one hands off to the create
 * flow in stepSelectDeployment instead of dead-ending. Fail-open: if the
 * libraries router is unavailable (old backend) or everything lives in one
 * Library, return null and keep the previous behavior.
 */
async function stepSelectLibrary(
  cfg: Config,
  org: Org,
  deployments: Deployment[],
  opts: { alwaysAsk?: boolean } = {},
): Promise<CliLibrary | null | typeof LIBRARY_SELECT_CANCELLED> {
  let libraries: CliLibrary[];
  try {
    const { createTypedClient } = await import("../client/trpc");
    libraries = await createTypedClient(cfg).libraries.list.query(org.org_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Library list failed, skipping Library selection: ${msg}`);
    // An explicit switch must never fall through silently: say why the list
    // is missing before the flow continues with the MCP picker.
    if (opts.alwaysAsk) p.log.warn("Could not list Libraries; picking by MCP instead.");
    return null;
  }

  const all = libraries ?? [];
  const spacesWithDeployments = new Set(deployments.map((d) => d.space_id));
  const candidates = all.filter((l) => spacesWithDeployments.has(l.id));
  if (all.length === 0) {
    if (opts.alwaysAsk) p.log.warn("No Libraries found; picking by MCP instead.");
    return null;
  }
  // Setup auto-picks when at most one Library has an MCP, to stay quiet; the
  // explicit "Switch Library" flow always shows the full list — including
  // Libraries without an MCP, so the user can create one for them.
  if (candidates.length <= 1 && !opts.alwaysAsk) return null;

  const selected = await p.select({
    message: "Select a Library",
    options: all.map((l) => ({
      label: l.name,
      value: l.id,
      hint: spacesWithDeployments.has(l.id)
        ? l.description || undefined
        : "no MCP yet \u00B7 select to create one",
    })),
  });
  if (p.isCancel(selected)) return LIBRARY_SELECT_CANCELLED;
  const library = all.find((l) => l.id === selected) ?? null;
  if (library) logger.info("setup", `Selected library: ${library.name}`);
  return library;
}

/**
 * Create an MCP deployment for a Library that has none yet, so selecting it
 * in the picker doesn't dead-end. Mirrors the web MCP wizard's payload
 * (`MCPDeploymentWizard.tsx` in the dosu repo): the backend mints the
 * `mcp_deployment_id` itself for `dosu_mcp` creates, no target required.
 * Returns null (with the error surfaced) on any failure.
 */
async function createMcpForLibrary(
  cfg: Config,
  org: Org,
  library: CliLibrary,
): Promise<Deployment | null> {
  const spin = p.spinner();
  spin.start(`Creating MCP for ${library.name}`);
  try {
    const { createTypedClient } = await import("../client/trpc");
    const created = await createTypedClient(cfg).workspaces.create.mutate({
      org_id: org.org_id,
      space_id: library.id,
      provider_slug: MCP_PROVIDER_SLUG,
      name: `${library.name} MCP Server`,
      description: "",
      enabled: true,
      config: {},
      metadata: {
        app: { deployment_mode: "normal", setup_mode: "manual" },
        provider_slug: MCP_PROVIDER_SLUG,
      },
    });
    if (!created) {
      spin.stop("MCP creation failed", 1);
      p.log.error("The backend did not return the created MCP. Try again.");
      return null;
    }
    spin.stop(`MCP created ${dim(`\u00B7 ${created.name}`)}`);
    logger.info("setup", `Created MCP deployment ${created.deployment_id} for ${library.name}`);
    return {
      deployment_id: created.deployment_id,
      name: created.name,
      description: created.description,
      provider_slug: created.provider_slug,
      enabled: created.enabled,
      org_id: created.org_id,
      org_name: org.name,
      space_id: created.space_id,
    };
  } catch (err: unknown) {
    spin.stop("MCP creation failed", 1);
    p.log.error(`Could not create MCP: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function stepSelectDeployment(
  apiClient: Client,
  cfg: Config,
  org: Org,
  opts: { alwaysAskLibrary?: boolean } = {},
): Promise<Deployment | null> {
  try {
    const allDeployments = await apiClient.getDeployments();
    const orgDeployments = allDeployments.filter((d) => d.org_id === org.org_id);

    // Zero deployments is fatal only when the Library picker can't offer to
    // create one (quiet setup path); the explicit Library flow continues so
    // an MCP-less Library can get its first deployment created below.
    if (orgDeployments.length === 0 && !opts.alwaysAskLibrary) {
      p.log.error(`No MCPs found for ${org.name}`);
      return null;
    }
    if (orgDeployments.length === 1 && !opts.alwaysAskLibrary) {
      logger.info("setup", `Selected deployment: ${orgDeployments[0].name} (auto, only one)`);
      p.log.success(`MCP ${dim(`\u00B7 ${orgDeployments[0].name}`)}`);
      return orgDeployments[0];
    }

    // Library-first: when the org's MCPs span several Libraries, ask which
    // Library to answer from and narrow the choice to it.
    const library = await stepSelectLibrary(cfg, org, orgDeployments, {
      alwaysAsk: opts.alwaysAskLibrary,
    });
    if (library === LIBRARY_SELECT_CANCELLED) return null;
    const deployments = library
      ? orgDeployments.filter((d) => d.space_id === library.id)
      : orgDeployments;

    // The picker offers Libraries without an MCP; landing here with an empty
    // list means the user chose one, so offer to create its deployment now.
    if (library && deployments.length === 0) {
      const ok = await p.confirm({
        message: `${library.name} has no MCP yet. Create one now?`,
      });
      if (p.isCancel(ok) || !ok) return null;
      return await createMcpForLibrary(cfg, org, library);
    }
    if (deployments.length === 0) {
      p.log.error(`No MCPs found for ${org.name}`);
      return null;
    }

    if (deployments.length === 1) {
      logger.info("setup", `Selected deployment: ${deployments[0].name} (auto, only one)`);
      p.log.success(`MCP ${dim(`\u00B7 ${deployments[0].name}`)}`);
      return deployments[0];
    }
    // The onboarding wizard creates one repo-deployment per connected repo,
    // so a freshly onboarded org always has several deployments — but only
    // one real MCP. Never show users a picker full of their own repo names
    // when the answer is unambiguous.
    const mcpDeployments = deployments.filter((d) => d.provider_slug === MCP_PROVIDER_SLUG);
    if (mcpDeployments.length === 1) {
      logger.info("setup", `Selected deployment: ${mcpDeployments[0].name} (auto, single MCP)`);
      p.log.success(`MCP ${dim(`\u00B7 ${mcpDeployments[0].name}`)}`);
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
      p.log.success(`API key ${dim("\u00B7 using existing")}`);
      return target.api_key;
    }
    p.log.warn("Existing API key is invalid, creating a new one...");
  }

  try {
    const resp = await apiClient.createAPIKey(deploymentID, "dosu-cli");
    logger.info("setup", "API key created");
    p.log.success(`API key ${dim("\u00B7 created")}`);
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

  const options = detected.map((p) => ({ label: p.name(), value: p.id() }));
  const preselected = detected.filter((p) => configuredMap.get(p.id())).map((p) => p.id());

  const selected = await p.multiselect({
    message: "Select agents",
    options,
    initialValues: preselected,
    // Each row previews the action confirming would take for that agent.
    statusFor: (id, picked) => {
      if (configuredMap.get(id)) return picked ? dim("configured") : pc.yellow("will remove");
      return picked ? brand("will configure") : undefined;
    },
    summary: (picked) => {
      const pickedSet = new Set(picked);
      const toConfigure = picked.filter((id) => !configuredMap.get(id)).length;
      const toRemove = preselected.filter((id) => !pickedSet.has(id)).length;
      const parts: string[] = [];
      if (toConfigure > 0) parts.push(`configure ${toConfigure}`);
      if (toRemove > 0) parts.push(`remove ${toRemove}`);
      return parts.length > 0 ? parts.join(" \u00B7 ") : "no changes";
    },
    // Nothing picked and nothing configured to remove = a no-op confirm;
    // require a pick. An empty pick with configured agents means remove all.
    validate: (picked) =>
      picked.length === 0 && preselected.length === 0
        ? "Select at least one agent (space toggles)."
        : undefined,
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
