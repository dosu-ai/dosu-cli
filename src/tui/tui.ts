/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import { basename } from "node:path";
import { Client } from "../client/client";
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
import { getVersionString } from "../version/version";
import { type BannerContext, renderBanner } from "./banner";
import { center, contentWidth, installCenteredLayout } from "./layout";
import { type MenuOption, menuSelect } from "./menu";
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
  return {
    version: getVersionString(),
    webAppHost,
    directory: basename(process.cwd()),
    signedIn: isAuthenticated(cfg),
    deploymentName: cfg.active_account?.target?.deployment_name,
    libraryName: cfg.active_account?.target?.library_name,
    agents,
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

async function runMainMenu(): Promise<void> {
  const cfg = loadConfig();
  // Written via stream.write (not console.log) so the centered-layout margin
  // applies — Bun's console.log bypasses the patched process.stdout.write.
  process.stdout.write(`${renderBanner(bannerContext(cfg))}\n`);

  // Main menu
  while (true) {
    const options: MenuOption[] = [
      {
        label: "Setup",
        value: "setup",
        hint: "Connect Dosu to your AI agents",
      },
      {
        label: "Authenticate",
        value: "auth",
        hint: isAuthenticated(cfg) ? "Re-authenticate" : undefined,
      },
      { label: "Clear credentials", value: "logout" },
      { label: "Exit", value: "exit" },
    ];

    const action = await menuSelect("What would you like to do?", options);

    if (action === null || action === "exit") {
      break;
    }

    switch (action) {
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
