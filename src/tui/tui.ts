/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { Client } from "../client/client";
import { isAuthenticated, loadConfig, MODE_OSS, saveConfig } from "../config/config";
import { runSetup } from "../setup/flow";

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

  // If not authenticated, authenticate first
  if (!isAuthenticated(cfg)) {
    await handleAuthenticate(cfg);
    if (!isAuthenticated(cfg)) return;
  }

  // Main menu
  while (true) {
    const hasMcpTarget = cfg.mode === MODE_OSS || !!cfg.deployment_id;

    const action = await p.select({
      message: "What would you like to do?",
      options: [
        {
          label: "Setup",
          value: "setup",
          hint: "Configure MCP for your AI tools",
        },
        {
          label: "Authenticate",
          value: "auth",
          hint: isAuthenticated(cfg) ? "Re-authenticate" : undefined,
        },
        {
          label: "Remove MCP",
          value: "mcp-remove",
          hint: !hasMcpTarget ? "Select deployment first" : undefined,
        },
        { label: "Clear Credentials", value: "logout" },
        { label: "Exit", value: "exit" },
      ],
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
      case "mcp-remove":
        if (!hasMcpTarget) {
          p.log.warn("Please select a deployment first.");
          continue;
        }
        if (await handleMCPRemove(cfg)) {
          p.outro("Goodbye!");
          return;
        }
        break;
      case "logout":
        handleLogout(cfg);
        break;
    }
  }

  p.outro("Goodbye!");
}

async function handleMCPRemove(_cfg: ReturnType<typeof loadConfig>): Promise<boolean> {
  const { allSetupProviders } = await import("../mcp/providers");
  const configured = allSetupProviders().filter((p) => p.isConfigured());

  if (configured.length === 0) {
    p.log.warn("No tools currently have Dosu MCP configured.");
    return false;
  }

  const options = configured.map((prov) => ({
    label: prov.name(),
    value: prov.id(),
    hint: "configured",
  }));

  const kept = await p.multiselect({
    message: "Deselect tools to remove Dosu MCP from",
    options,
    initialValues: configured.map((prov) => prov.id()),
  });

  if (p.isCancel(kept)) return false;

  const keptSet = new Set(kept as string[]);
  const toRemove = configured.filter((prov) => !keptSet.has(prov.id()));

  if (toRemove.length === 0) {
    p.log.info("No changes.");
    return false;
  }

  for (const provider of toRemove) {
    try {
      provider.remove(true);
      p.log.success(`Removed Dosu MCP from ${provider.name()}`);
    } catch (err: unknown) {
      /* v8 ignore next -- err is always Error in practice */
      p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return true;
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
    s.start("Waiting for authentication...");
    const token = await startOAuthFlow(undefined, "/cli/auth");
    s.stop("Authenticated");

    cfg.access_token = token.access_token;
    cfg.refresh_token = token.refresh_token;
    cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
    cfg.mode = token.mode === MODE_OSS ? MODE_OSS : undefined;
    saveConfig(cfg);
  } catch (err: unknown) {
    /* v8 ignore next -- err is always Error in practice */
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
