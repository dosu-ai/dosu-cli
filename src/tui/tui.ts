/**
 * TUI entry point.
 *
 * The TUI launches when `dosu` is run without arguments.
 */

import * as p from "@clack/prompts";
import pc from "picocolors";
import { Client } from "../client/client";
import { isAuthenticated, loadConfig, saveConfig } from "../config/config";
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

  // If not authenticated, open setup immediately
  if (!isAuthenticated(cfg)) {
    await runSetup();
    return;
  }

  // Main menu
  while (true) {
    const hasDeployment = !!cfg.deployment_id;

    const action = await p.select({
      message: "What would you like to do?",
      options: [
        {
          label: "Authenticate",
          value: "setup",
          hint: isAuthenticated(cfg) ? "Re-authenticate" : undefined,
        },
        {
          label: "Choose Deployment",
          value: "deployments",
          hint: !isAuthenticated(cfg) ? "Login first" : undefined,
        },
        {
          label: "Add MCP",
          value: "mcp-add",
          hint: !hasDeployment ? "Select deployment first" : undefined,
        },
        {
          label: "Remove MCP",
          value: "mcp-remove",
          hint: !hasDeployment ? "Select deployment first" : undefined,
        },
        { label: "Clear Credentials", value: "logout" },
        { label: "Exit", value: "exit" },
      ],
    });

    if (p.isCancel(action) || action === "exit") {
      break;
    }

    switch (action) {
      case "setup":
        await runSetup();
        break;
      case "deployments":
        await handleDeployments(cfg);
        break;
      case "mcp-add":
        if (!hasDeployment) {
          p.log.warn("Please select a deployment first.");
          continue;
        }
        await handleMCPAdd(cfg);
        break;
      case "mcp-remove":
        if (!hasDeployment) {
          p.log.warn("Please select a deployment first.");
          continue;
        }
        await handleMCPRemove(cfg);
        break;
      case "logout":
        handleLogout(cfg);
        break;
    }
  }

  p.outro("Goodbye!");
}

async function handleDeployments(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  if (!isAuthenticated(cfg)) {
    p.log.warn("Please authenticate first.");
    return;
  }

  const client = new Client(cfg);
  try {
    const deployments = await client.getDeployments();
    if (deployments.length === 0) {
      p.log.warn("No deployments found.");
      return;
    }

    const selected = await p.select({
      message: "Select a deployment",
      options: deployments.map((d) => ({
        label: `${d.name} ${pc.dim(`(${d.org_name})`)}`,
        value: d.deployment_id,
      })),
    });

    if (p.isCancel(selected)) return;

    const deployment = deployments.find((d) => d.deployment_id === selected);
    if (deployment) {
      cfg.deployment_id = deployment.deployment_id;
      cfg.deployment_name = deployment.name;
      saveConfig(cfg);
      p.log.success(`Selected: ${deployment.name}`);
    }
  } catch (err: unknown) {
    p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleMCPAdd(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const { allProviders } = await import("../mcp/providers");
  const providers = allProviders();

  const selected = await p.select({
    message: "Select tool to add MCP to",
    options: providers.map((p) => ({
      label: p.name(),
      value: p.id(),
      hint: p.supportsLocal() ? "local + global" : "global only",
    })),
  });

  if (p.isCancel(selected)) return;

  const provider = providers.find((p) => p.id() === selected);
  if (!provider) return;

  try {
    provider.install(cfg, true);
    p.log.success(`Added Dosu MCP to ${provider.name()}`);
  } catch (err: unknown) {
    p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleMCPRemove(_cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const { allProviders } = await import("../mcp/providers");
  const providers = allProviders();

  const selected = await p.select({
    message: "Select tool to remove MCP from",
    options: providers
      .filter((p) => p.id() !== "manual")
      .map((p) => ({
        label: p.name(),
        value: p.id(),
      })),
  });

  if (p.isCancel(selected)) return;

  const provider = providers.find((p) => p.id() === selected);
  if (!provider) return;

  try {
    provider.remove(true);
    p.log.success(`Removed Dosu MCP from ${provider.name()}`);
  } catch (err: unknown) {
    p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
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
  cfg.deployment_id = undefined;
  cfg.deployment_name = undefined;
  cfg.api_key = undefined;
  saveConfig(cfg);
  p.log.success("Credentials cleared.");
}
