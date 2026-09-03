/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import { basename } from "node:path";
import pc from "picocolors";
import {
  type Config,
  clearConfigInPlace,
  isAuthenticated,
  loadConfig,
  replaceLoginSession,
  saveConfig,
} from "../config/config";
import { getWebAppURL } from "../config/constants";
import { allSetupProviders } from "../mcp/providers";
import { dosuAgentsSectionState, inGitWorkTree } from "../setup/agents-md-step";
import { runSetup, runSwitchTarget } from "../setup/flow";
import { brand, browserFallbackHint, dim } from "../setup/styles";
import { getSyncStatus } from "../sync/status";
import { buildUpdateHint, getAvailableUpdate } from "../version/update-check";
import { getVersionString, INSTALL_CHANNEL, isNpxInvocation } from "../version/version";
import { runActivityView } from "./activity-view";
import { enterAltScreen } from "./alt-screen";
import { runAnalyticsView } from "./analytics-view";
import { type BannerContext, renderBanner } from "./banner";
import { frameTopMargin, installCenteredLayout } from "./layout";
import { type MenuOption, menuSelect } from "./menu";
import { runPagesView } from "./pages-view";
import * as p from "./prompts";

/** Gather the live machine state the welcome banner shows. */
function bannerContext(cfg: Config): BannerContext {
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
  return {
    version: getVersionString(),
    webAppHost,
    directory: basename(process.cwd()),
    signedIn: isAuthenticated(cfg),
    deploymentName: cfg.active_account?.target?.deployment_name,
    libraryName: cfg.active_account?.target?.library_name,
    // Signed out, the account row already says "run Setup"; don't repeat it.
    setupMissing: isAuthenticated(cfg) ? missingSetupSteps(cfg) : [],
    ...(inGitWorkTree() ? { repoAgentsMd: dosuAgentsSectionState() } : {}),
    agents,
    mining: isMining(),
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

/**
 * Setup steps a completed wizard always persists, by user-facing name;
 * missing ones keep Setup in the menu and flag the banner.
 */
export function missingSetupSteps(cfg: Config): string[] {
  const target = cfg.active_account?.target;
  const missing: string[] = [];
  if (!target?.space_id) missing.push("Library");
  if (!target?.deployment_id || !target?.api_key) missing.push("MCP");
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

/** Lock-file check only (no log read): is a mining run active right now? */
function isMining(): boolean {
  try {
    return getSyncStatus({ readLog: () => "" }).running;
  } catch {
    // Mining state is cosmetic in the banner and menu; never block on it.
    return false;
  }
}

/**
 * Take over the screen and draw the welcome banner; called on launch and
 * after flows that scrolled it away or changed the state it shows.
 */
function drawHome(cfg: Config): void {
  if (process.stdout.isTTY) {
    process.stdout.write(CLEAR_SCREEN);
    // Fixed top margin; vertical centering jiggled as the menu height changed.
    process.stdout.write("\n".repeat(frameTopMargin()));
  }
  // stream.write, not console.log: Bun's console.log bypasses the patched
  // stdout.write that injects the centered-layout margin.
  process.stdout.write(`${renderBanner(bannerContext(cfg))}\n`);
}

async function runMainMenu(): Promise<void> {
  const cfg = loadConfig();

  // Re-polled while the menu is open so background mining updates the label.
  // Signed out, the menu is just the login door; Setup leads until complete.
  const buildOptions = (): MenuOption[] => {
    if (!isAuthenticated(cfg)) {
      return [
        { label: "Log in / Sign up", hint: "opens your browser", value: "auth" },
        { label: "Exit", value: "exit" },
      ];
    }
    const mining = isMining();
    return [
      ...(isSetUp(cfg) ? [] : [{ label: "Setup", hint: setupHint(cfg), value: "setup" }]),
      {
        label: mining ? `Activity \u26CF\uFE0F ${brand("mining sessions...")}` : "Activity",
        value: "sync",
      },
      { label: "Analytics", value: "analytics" },
      { label: "Pages", value: "pages" },
      { label: "Settings", value: "settings" },
      { label: "Exit", value: "exit" },
    ];
  };
  const home = () => drawHome(cfg);

  home();

  // Main menu
  while (true) {
    const action = await menuSelect("What would you like to do?", buildOptions(), {
      // Repaint home when the mining lock flips so banner and label stay fresh.
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
      case "analytics":
        await runAnalyticsView();
        home();
        break;
      case "pages":
        await runPagesView();
        home();
        break;
      case "settings":
        await runSettings(cfg);
        home();
        break;
      case "auth":
        await handleAuthenticate(cfg);
        home();
        break;
      case "setup":
        await runSetup();
        // Reload config: setup may have changed deployment, api_key, etc.
        {
          const fresh = loadConfig();
          cfg.mode = fresh.mode;
          cfg.active_account = fresh.active_account;
        }
        home();
        break;
    }
  }
}

/**
 * Settings submenu: switch org/Library, rerun the wizard, or log out.
 * Library switches stay in the current org; org switches run the full chain.
 */
async function runSettings(cfg: Config): Promise<void> {
  while (true) {
    const target = cfg.active_account?.target;
    // Older configs predate org_name/library_name; fall back rather than show nothing.
    const library = target?.library_name ?? target?.deployment_name ?? "not configured";
    const action = await menuSelect("Settings", [
      { label: "Switch organization", hint: target?.org_name, value: "switch-org" },
      { label: "Switch Library", hint: library, value: "switch-library" },
      { label: "Run setup", hint: "rerun the setup wizard", value: "setup" },
      { label: "Log out", hint: "clear stored credentials", value: "logout" },
      { label: "Back", value: "back" },
    ]);
    if (action === null || action === "back") return;
    if (action === "setup") {
      await runSetup();
      // Reload so the submenu hints and banner reflect any target change.
      const fresh = loadConfig();
      cfg.mode = fresh.mode;
      cfg.active_account = fresh.active_account;
      continue;
    }
    if (action === "logout") {
      handleLogout(cfg);
      return;
    }
    if (action === "switch-org" || action === "switch-library") {
      await runSwitchTarget(action === "switch-org" ? "org" : "library");
      // Keep the in-memory config in step with the persisted new target.
      const fresh = loadConfig();
      cfg.mode = fresh.mode;
      cfg.active_account = fresh.active_account;
    }
  }
}

async function handleAuthenticate(cfg: ReturnType<typeof loadConfig>): Promise<void> {
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

export function handleLogout(cfg: ReturnType<typeof loadConfig>): void {
  if (!isAuthenticated(cfg)) {
    p.log.warn("You are not logged in.");
    return;
  }
  clearConfigInPlace(cfg);
  saveConfig(cfg);
  p.log.success("Credentials cleared.");
}
