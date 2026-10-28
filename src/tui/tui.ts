/** TUI entry point; launches when `dosu` is run without arguments. */

import { basename } from "node:path";
import pc from "picocolors";
import { Client, SessionExpiredError } from "../client/client";
import {
  type Config,
  clearConfigInPlace,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  replaceLoginSession,
  saveConfig,
} from "../config/config";
import { getWebAppURL } from "../config/constants";
import { configuredTargets } from "../config/targets";
import { getHookAgent } from "../hooks/agents";
import { allSetupProviders } from "../mcp/providers";
import { createProjectDirResolver } from "../sessions/project-dir";
import { displayRepo } from "../sessions/repo";
import { scanAgentSessions } from "../sessions/scan";
import { runSetup, runSwitchTarget } from "../setup/flow";
import { brand, browserFallbackHint, dim } from "../setup/styles";
import { loadSyncState, saveRepoFilter, studyRepoFilter } from "../sync/state";
import { getSyncStatus } from "../sync/status";
import { buildUpdateHint, getAvailableUpdate } from "../version/update-check";
import { getVersionString, INSTALL_CHANNEL, isNpxInvocation } from "../version/version";
import { runActivityView } from "./activity-view";
import { enterAltScreen } from "./alt-screen";
import { type BannerContext, renderBanner } from "./banner";
import { frameTopMargin, installCenteredLayout } from "./layout";
import { type MenuOption, menuSelect } from "./menu";
import * as p from "./prompts";

/** Session state the banner and menu key off. `expired` means the tokens on disk are past
 * their lifetime *and* the server refused to refresh them, so only a new login helps. */
interface SessionState {
  expired: boolean;
}

/** Bring an expired access token up to date before drawing anything, so the banner reflects
 * the server's verdict rather than whatever token happens to be on disk. Network or disk
 * hiccups leave the session as-is: the views retry the refresh on demand. */
async function probeSession(cfg: Config): Promise<SessionState> {
  if (!isAuthenticated(cfg) || !isTokenExpired(cfg)) return { expired: false };
  try {
    await new Client(cfg).refreshToken();
    return { expired: false };
  } catch (err: unknown) {
    return { expired: err instanceof SessionExpiredError };
  }
}

/** The bucket sessions ship to, when the default target is one; Dosu otherwise. */
function sessionStorage(cfg: Config): string | undefined {
  const target = configuredTargets(cfg).find((t) => t.name === cfg.default_target);
  return target && /^(s3|r2):\/\//.test(target.url) ? target.url : undefined;
}

/** Gather the live machine state the welcome banner shows. */
function bannerContext(cfg: Config, session: SessionState): BannerContext {
  let webAppHost = "app.dosu.dev";
  try {
    webAppHost = new URL(getWebAppURL()).host;
  } catch {
    // keep the default host when no web app URL is baked in
  }
  const agents = allSetupProviders()
    .filter((provider) => {
      try {
        return provider.isInstalled() && provider.isConfigured();
      } catch {
        return false;
      }
    })
    .map((provider) => provider.name());
  // The preAction hook already refreshed the update cache without printing.
  const latest = getAvailableUpdate();
  const storage = sessionStorage(cfg);
  return {
    version: getVersionString(),
    webAppHost,
    directory: basename(process.cwd()),
    signedIn: isAuthenticated(cfg),
    sessionExpired: session.expired,
    deploymentName: cfg.active_account?.target?.deployment_name,
    libraryName: cfg.active_account?.target?.library_name,
    // Signed out or expired, the account row already names the next step; don't repeat it.
    setupMissing: isAuthenticated(cfg) && !session.expired ? missingSetupSteps(cfg) : [],
    ...(storage ? { storage } : {}),
    agents,
    syncing: isSyncing(),
    ...(latest
      ? { update: { version: latest, hint: buildUpdateHint(INSTALL_CHANNEL, isNpxInvocation()) } }
      : {}),
  };
}

export async function runTUI(): Promise<void> {
  const restoreLayout = installCenteredLayout();
  // The whole session lives in the alternate screen buffer (vim style), so
  // the shell's scrollback stays untouched.
  const leaveAltScreen = process.stdout.isTTY ? enterAltScreen(process.stdout) : () => {};
  try {
    await runMainMenu();
  } finally {
    leaveAltScreen();
    // Printed after leaving the alternate screen so it lands in the shell.
    process.stdout.write(`${dim("Goodbye!")}\n\n`);
    restoreLayout();
  }
}

const ESC = String.fromCharCode(27);
/** Clear the visible screen and home the cursor; scrollback is preserved. */
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

/** Installed agents on this machine, split by whether Dosu is configured. */
function agentSetupIncomplete(): boolean {
  const installed = allSetupProviders().filter((provider) => {
    try {
      return provider.isInstalled();
    } catch {
      return false;
    }
  });
  // No supported agent on this machine: nothing to configure, don't block.
  if (installed.length === 0) return false;
  return !installed.some((provider) => {
    try {
      return provider.isConfigured();
    } catch {
      return false;
    }
  });
}

/** A configured, hook-capable agent whose session-end hook is missing. */
function hooksIncomplete(): boolean {
  return allSetupProviders().some((provider) => {
    try {
      if (!provider.isInstalled() || !provider.isConfigured()) return false;
      const hook = getHookAgent(provider.id());
      return hook ? !hook.isEnabled() : false;
    } catch {
      return false;
    }
  });
}

/** Setup steps a completed wizard persists; missing ones keep the TUI in setup mode. */
function missingSetupSteps(cfg: Config): string[] {
  const target = cfg.active_account?.target;
  const missing: string[] = [];
  if (!target?.space_id) missing.push("Library");
  if (!target?.deployment_id || !target?.api_key) missing.push("MCP");
  if (agentSetupIncomplete()) missing.push("agents");
  else if (hooksIncomplete()) missing.push("hooks");
  return missing;
}

/** Complete target (Library + MCP + key): Setup moves into Settings. */
function isSetUp(cfg: Config): boolean {
  return isAuthenticated(cfg) && missingSetupSteps(cfg).length === 0;
}

/** The Setup row's warning hint: why it's still at the top of the menu. */
function setupHint(cfg: Config): string {
  const started = Boolean(cfg.active_account?.target);
  return pc.yellow(
    started ? `incomplete \u00B7 missing ${missingSetupSteps(cfg).join(" + ")}` : "not set up yet",
  );
}

/** Lock-file check only (no log read): is a sync run shipping right now? */
function isSyncing(): boolean {
  try {
    return getSyncStatus({ readLog: () => "" }).running;
  } catch {
    // Syncing state is cosmetic in the banner and menu; never block on it.
    return false;
  }
}

/** Take over the screen and draw the banner, on launch and after flows that scrolled it away. */
function drawHome(cfg: Config, session: SessionState): void {
  if (process.stdout.isTTY) {
    process.stdout.write(CLEAR_SCREEN);
    // Fixed top margin; vertical centering jiggled as the menu height changed.
    process.stdout.write("\n".repeat(frameTopMargin()));
  }
  // stream.write, not console.log: Bun's console.log bypasses the patched
  // stdout.write that injects the centered-layout margin.
  process.stdout.write(`${renderBanner(bannerContext(cfg, session))}\n`);
}

/** Setup and target switches persist a new config; keep the in-memory one in step. */
function reload(cfg: Config): void {
  const fresh = loadConfig();
  cfg.mode = fresh.mode;
  cfg.active_account = fresh.active_account;
  cfg.targets = fresh.targets;
  cfg.default_target = fresh.default_target;
}

async function runMainMenu(): Promise<void> {
  const cfg = loadConfig();
  // Refresh mutates cfg in place, so a successful probe also leaves fresh tokens for the views.
  const session = await probeSession(cfg);

  const runSetupAndReload = async (): Promise<void> => {
    await runSetup();
    reload(cfg);
  };

  // Re-polled while the menu is open so a background sync updates the label.
  // Signed out (or expired), the menu is just the login door; Setup leads until complete.
  const buildOptions = (): MenuOption[] => {
    if (session.expired) {
      return [
        {
          label: "log in again",
          hint: "(session expired \u00B7 opens your browser)",
          value: "auth",
        },
        { label: "exit", value: "exit" },
      ];
    }
    if (!isAuthenticated(cfg)) {
      return [
        { label: "log in / sign up", hint: "(opens your browser)", value: "auth" },
        { label: "exit", value: "exit" },
      ];
    }
    // Setup mode: until the wizard completes (target + a configured agent),
    // the other screens have nothing to show, so the menu is Setup or leave.
    if (!isSetUp(cfg)) {
      return [
        { label: "setup", hint: setupHint(cfg), value: "setup" },
        { label: "exit", value: "exit" },
      ];
    }
    const syncing = isSyncing();
    return [
      {
        label: syncing ? `activity \uD83D\uDCDA ${brand("shipping sessions...")}` : "activity",
        value: "sync",
      },
      { label: "settings", value: "settings" },
      { label: "exit", value: "exit" },
    ];
  };
  const home = () => drawHome(cfg, session);

  home();

  // Signed in without a complete target, every menu row is a dead end — go
  // straight into the wizard. Cancelling out still lands on the menu.
  if (isAuthenticated(cfg) && !session.expired && !isSetUp(cfg)) {
    await runSetupAndReload();
    home();
  }

  // Main menu
  while (true) {
    const action = await menuSelect("What would you like to do?", buildOptions(), {
      // Repaint home when the sync lock flips so banner and label stay fresh.
      refresh: { options: buildOptions, redrawScreen: home },
    });

    if (action === null || action === "exit") {
      break;
    }

    // Views share our alternate screen, so repaint home after each flow.
    switch (action) {
      case "sync":
        await runActivityView();
        home();
        break;
      case "settings":
        await runSettings(cfg);
        home();
        break;
      case "auth":
        await handleAuthenticate(cfg);
        // A completed login replaced the session; a cancelled one leaves it expired.
        session.expired = session.expired && isTokenExpired(cfg);
        home();
        // A fresh login without a target flows straight into the wizard too.
        if (isAuthenticated(cfg) && !isSetUp(cfg)) {
          await runSetupAndReload();
          home();
        }
        break;
      case "setup":
        await runSetupAndReload();
        home();
        break;
    }
  }
}

/** Settings submenu: switch org/Library, scope syncing, pick session storage, rerun the
 * wizard, or log out. Library switches stay in the current org; org switches run the full
 * chain. */
async function runSettings(cfg: Config): Promise<void> {
  while (true) {
    const target = cfg.active_account?.target;
    // Older configs predate org_name/library_name; fall back rather than show nothing.
    const library = target?.library_name ?? target?.deployment_name ?? "not configured";
    const sync = loadSyncState();
    const filter = sync.repo_filter;
    // Name the picked repos while they fit; count only when they don't.
    const scope = !filter
      ? sync.project_filter?.length
        ? `${sync.project_filter.length} folders (legacy)`
        : "all repos"
      : filter.length === 0
        ? "no repos"
        : filter.length <= 2
          ? filter.map(displayRepo).join(", ")
          : `${filter.length} repos`;
    const action = await menuSelect("settings", [
      { label: "switch organization", hint: target?.org_name, value: "switch-org" },
      { label: "switch library", hint: library, value: "switch-library" },
      { label: "sync scope", hint: scope, value: "projects" },
      { label: "session storage", hint: sessionStorage(cfg) ?? "Dosu", value: "storage" },
      { label: "run setup", hint: "rerun the setup wizard", value: "setup" },
      { label: "log out", hint: "clear stored credentials", value: "logout" },
      { label: "back", value: "back" },
    ]);
    if (action === null || action === "back") return;
    if (action === "projects") {
      await runSyncScopeSetting();
      continue;
    }
    if (action === "storage") {
      // Setup's storage step alone: it re-asks even when a bucket is already in place.
      await runSetup({ storage: true });
      reload(cfg);
      continue;
    }
    if (action === "setup") {
      await runSetup();
      // Reload so the submenu hints and banner reflect any target change.
      reload(cfg);
      continue;
    }
    if (action === "logout") {
      handleLogout(cfg);
      return;
    }
    if (action === "switch-org" || action === "switch-library") {
      await runSwitchTarget(action === "switch-org" ? "org" : "library");
      // Keep the in-memory config in step with the persisted new target.
      reload(cfg);
    }
  }
}

/** Repos the local sessions ran in plus the current scope, most sessions first; sessions
 * outside a git repo have no repo to pick, and are shipped only when every repo is. */
function discoverSessionRepos(current: readonly string[] | null): string[] {
  const counts = new Map<string, number>();
  try {
    const resolver = createProjectDirResolver();
    for (const session of scanAgentSessions({})) {
      const repo = resolver.resolveRepo(session);
      if (repo) counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    resolver.flush();
  } catch {
    // An unreadable session store just yields an empty picker.
  }
  // A picked repo whose sessions have all aged out must stay removable.
  for (const repo of current ?? []) if (!counts.has(repo)) counts.set(repo, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([repo]) => repo);
}

/** Scope syncing to selected repos; picking everything clears the filter so new repos ship
 * too. */
async function runSyncScopeSetting(): Promise<void> {
  const state = loadSyncState();
  const current = studyRepoFilter(state, () => scanAgentSessions({}), createProjectDirResolver());
  const repos = discoverSessionRepos(current);
  if (repos.length === 0) {
    p.log.info("No agent sessions inside a git repo found yet; nothing to scope.");
    return;
  }
  const selected = await p.multiselect({
    message: "Ship sessions from which repos?",
    options: repos.map((repo) => ({ label: displayRepo(repo), hint: repo, value: repo })),
    initialValues: current ?? repos,
    summary: (picked) =>
      picked.length === repos.length
        ? "all repos \u00B7 new ones included automatically"
        : `${picked.length} of ${repos.length} repos`,
    validate: (picked) => (picked.length === 0 ? "Select at least one repo." : undefined),
  });
  if (p.isCancel(selected)) return;

  // saveRepoFilter reloads right before writing: a background sync may have advanced the state.
  const all = selected.length === repos.length;
  saveRepoFilter(all ? null : [...selected]);
  const scope = all ? "all repos" : (selected as string[]).map(displayRepo).join(", ");
  p.log.success(`Sync scope ${dim(`\u00B7 ${scope}`)}`);
}

async function handleAuthenticate(cfg: Config): Promise<void> {
  // The menu only offers this when signed out: straight to the browser login.
  const shouldLogin = await p.confirm({ message: "Open browser to log in?" });
  if (p.isCancel(shouldLogin) || !shouldLogin) return;

  try {
    const { startOAuthFlow } = await import("../auth/flow");
    const s = p.spinner();
    const result = await startOAuthFlow(undefined, "/cli/auth", {}, (url) => {
      p.log.message(browserFallbackHint(url));
      s.start("Waiting for authentication...");
    });
    if (!result.browserOpened) {
      s.stop("Could not open a browser");
      p.log.error("Run 'dosu login --no-browser' from the terminal to authenticate over SSH.");
      return;
    }
    const token = result.token;
    s.stop("Authenticated");

    replaceLoginSession(cfg, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
    });
    saveConfig(cfg);
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
    const { OAuthCallbackError } = await import("../auth/errors");
    if (err instanceof OAuthCallbackError) {
      p.log.error(err.userMessage);
      return;
    }
    p.log.error(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function handleLogout(cfg: Config): void {
  if (!isAuthenticated(cfg)) {
    p.log.warn("You are not logged in.");
    return;
  }
  clearConfigInPlace(cfg);
  saveConfig(cfg);
  p.log.success("Credentials cleared.");
}
