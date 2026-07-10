/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { Client } from "../client/client";
import { executeInsights } from "../commands/insights";
import { isAuthenticated, loadConfig, saveConfig } from "../config/config";
import { runSetup } from "../setup/flow";
import { browserFallbackHint } from "../setup/styles";

const LOGO = `
 /$$$$$$$
| $$__  $$
| $$  \\ $$  /$$$$$$   /$$$$$$$ /$$   /$$
| $$  | $$ /$$__  $$ /$$_____/| $$  | $$
| $$  | $$| $$  \\ $$|  $$$$$$ | $$  | $$
| $$  | $$| $$  | $$ \\____  $$| $$  | $$
| $$$$$$$/|  $$$$$$/ /$$$$$$$/|  $$$$$$/
|_______/  \\______/ |_______/  \\______/
`;

export async function runTUI(): Promise<void> {
  console.log(pc.magenta(LOGO));

  const cfg = loadConfig();

  // Main menu
  while (true) {
    const insightsReady = Boolean(cfg.space_id && cfg.deployment_id && cfg.api_key);
    const options: Array<{ label: string; value: string; hint?: string }> = [
      {
        label: "Setup",
        value: "setup",
        hint: "Configure MCP for your AI tools",
      },
    ];
    if (insightsReady) {
      options.push({
        label: "View Insights",
        value: "insights",
        hint: "Open a fun report of your space's activity",
      });
    }
    options.push(
      {
        label: "Authenticate",
        value: "auth",
        hint: isAuthenticated(cfg) ? "Re-authenticate" : undefined,
      },
      { label: "Clear Credentials", value: "logout" },
      { label: "Exit", value: "exit" },
    );

    const action = await p.select({
      message: "What would you like to do?",
      options,
    });

    if (p.isCancel(action) || action === "exit") {
      break;
    }

    switch (action) {
      case "auth":
        await handleAuthenticate(cfg);
        break;
      case "setup":
        await runSetup();
        // Reload config after setup (it may have changed deployment, api_key, etc.)
        Object.assign(cfg, loadConfig());
        break;
      case "insights":
        await executeInsights(cfg);
        break;
      case "logout":
        handleLogout(cfg);
        break;
    }
  }

  p.outro("Goodbye!");
}

async function handleAuthenticate(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  if (cfg.access_token) {
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

    cfg.access_token = token.access_token;
    cfg.refresh_token = token.refresh_token;
    cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
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
  cfg.access_token = "";
  cfg.refresh_token = "";
  cfg.expires_at = 0;
  cfg.mode = undefined;
  cfg.deployment_id = undefined;
  cfg.deployment_name = undefined;
  cfg.api_key = undefined;
  saveConfig(cfg);
  p.log.success("Credentials cleared.");
}
