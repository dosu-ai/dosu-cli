/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import { basename } from "node:path";
import { Client } from "../client/client";
import { executeInsights } from "../commands/insights";
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
import { runSetup } from "../setup/flow";
import { browserFallbackHint, dim } from "../setup/styles";
import { getSyncStatus } from "../sync/status";
import { buildUpdateHint, getAvailableUpdate } from "../version/update-check";
import { getVersionString, INSTALL_CHANNEL, isNpxInvocation } from "../version/version";
import { type BannerContext, renderBanner } from "./banner";
import { center, contentWidth, installCenteredLayout } from "./layout";
import { type MenuOption, menuSelect } from "./menu";
import * as p from "./prompts";
import { runSyncView } from "./sync-view";

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
  // The preAction hook already refreshed the update cache without printing;
  // the banner is where a bare `dosu` run learns about a newer version.
  const latest = getAvailableUpdate();
  // Lock-file check only (no log read): is a mining run active right now?
  let mining = false;
  try {
    mining = getSyncStatus({ readLog: () => "" }).running;
  } catch {
    // Status is cosmetic here; never block the banner on it.
  }
  return {
    version: getVersionString(),
    webAppHost,
    directory: basename(process.cwd()),
    signedIn: isAuthenticated(cfg),
    deploymentName: cfg.active_account?.target?.deployment_name,
    libraryName: cfg.active_account?.target?.library_name,
    agents,
    mining,
    ...(latest
      ? { update: { version: latest, hint: buildUpdateHint(INSTALL_CHANNEL, isNpxInvocation()) } }
      : {}),
    width: contentWidth(),
  };
}

export async function runTUI(): Promise<void> {
  const restoreLayout = installCenteredLayout();
  try {
    await runMainMenu();
  } finally {
    restoreLayout();
  }
}

const ESC = String.fromCharCode(27);
/**
 * Clear the visible screen and home the cursor, so the TUI takes over from
 * the terminal's top row (Claude Code-style) instead of rendering inline
 * below the shell prompt. Scrollback above is preserved.
 */
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;

async function runMainMenu(): Promise<void> {
  const cfg = loadConfig();
  if (process.stdout.isTTY) process.stdout.write(CLEAR_SCREEN);
  // Written via stream.write (not console.log) so the centered-layout margin
  // applies — Bun's console.log bypasses the patched process.stdout.write.
  process.stdout.write(`${renderBanner(bannerContext(cfg))}\n`);

  // Main menu
  while (true) {
    // Insights needs a fully set-up account: space, deployment, and API key.
    const insightsReady = Boolean(
      cfg.active_account?.target?.space_id &&
        cfg.active_account?.target?.deployment_id &&
        cfg.active_account?.target?.api_key,
    );
    const options: MenuOption[] = [
      { label: "Setup", value: "setup" },
      { label: "Sync status", value: "sync" },
      ...(insightsReady ? [{ label: "View insights", value: "insights" }] : []),
      { label: "Authenticate", value: "auth" },
      { label: "Clear credentials", value: "logout" },
      { label: "Exit", value: "exit" },
    ];

    const action = await menuSelect("What would you like to do?", options);

    if (action === null || action === "exit") {
      break;
    }

    switch (action) {
      case "sync":
        await runSyncView();
        break;
      case "insights":
        await executeInsights(cfg);
        break;
      case "auth":
        await handleAuthenticate(cfg);
        break;
      case "setup":
        await runSetup();
        // Reload config after setup (it may have changed deployment, api_key, etc.)
        {
          const fresh = loadConfig();
          cfg.mode = fresh.mode;
          cfg.active_account = fresh.active_account;
        }
        break;
      case "logout":
        handleLogout(cfg);
        break;
    }
  }

  process.stdout.write(`${center(dim("Goodbye!"), contentWidth())}\n\n`);
}

async function handleAuthenticate(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  if (cfg.active_account?.session.access_token) {
    const s = p.spinner();
    s.start("Verifying session...");
    try {
      const apiClient = new Client(cfg);
      const resp = await apiClient.doRequestRaw("GET", "/v1/mcp/deployments");
      if (resp.status === 200) {
        s.stop("Already authenticated.");
        return;
      }
      try {
        await apiClient.refreshToken();
        s.stop("Session refreshed.");
        return;
      } catch {
        // refresh failed, fall through to login
      }
      s.stop("Session expired.");
    } catch {
      s.stop("Verification failed.");
    }
  }

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
