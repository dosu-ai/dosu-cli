/**
 * CLI command definitions using Commander.
 */

import { Command } from "commander";
import {
  getConfigPath,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  saveConfig,
} from "../config/config";
import { allProviders, getProvider, type Provider } from "../mcp/providers";
import { getVersionString } from "../version/version";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("dosu")
    .description("Dosu CLI - Manage MCP servers for AI tools")
    .version(getVersionString(), "-v, --version")
    .action(async () => {
      // Default: launch TUI when no subcommand given
      const { runTUI } = await import("../tui/tui");
      await runTUI();
    });

  // login
  program
    .command("login")
    .description("Authenticate with Dosu via OAuth")
    .action(async () => {
      const cfg = loadConfig();
      if (isAuthenticated(cfg) && !isTokenExpired(cfg)) {
        console.log("You are already logged in.");
        console.log("Run 'dosu logout' first to re-authenticate.");
        return;
      }

      console.log("Opening browser for authentication...");
      const { startOAuthFlow } = await import("../auth/flow");
      const token = await startOAuthFlow();

      cfg.access_token = token.access_token;
      cfg.refresh_token = token.refresh_token;
      cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
      saveConfig(cfg);

      console.log("Successfully authenticated!");
      console.log(`Credentials saved to ${getConfigPath()}`);
    });

  // logout
  program
    .command("logout")
    .description("Clear saved credentials")
    .action(() => {
      const cfg = loadConfig();
      if (!isAuthenticated(cfg)) {
        console.log("You are not logged in.");
        return;
      }
      cfg.access_token = "";
      cfg.refresh_token = "";
      cfg.expires_at = 0;
      cfg.deployment_id = undefined;
      cfg.deployment_name = undefined;
      cfg.api_key = undefined;
      saveConfig(cfg);
      console.log("Successfully logged out.");
    });

  // status
  program
    .command("status")
    .description("Show current authentication and deployment status")
    .action(() => {
      const cfg = loadConfig();
      if (!isAuthenticated(cfg)) {
        console.log("Status: Not logged in");
        console.log("Run 'dosu login' to authenticate.");
        return;
      }
      if (isTokenExpired(cfg)) {
        console.log("Status: Token expired");
        console.log("Run 'dosu login' to re-authenticate.");
      } else {
        console.log("Status: Logged in");
      }
      if (cfg.deployment_id) {
        console.log(`Deployment: ${cfg.deployment_name}`);
        console.log(`Deployment ID: ${cfg.deployment_id}`);
      } else {
        console.log("Deployment: None selected");
        console.log("Run 'dosu' to open the TUI and select a deployment.");
      }
    });

  // mcp
  const mcp = program.command("mcp").description("Manage MCP server integrations");

  mcp
    .command("add <tool>")
    .description("Add Dosu MCP to an AI tool")
    .option("-g, --global", "Add globally (all projects) instead of project-local", false)
    .action((toolId: string, opts: { global: boolean }) => {
      let provider: Provider;
      try {
        provider = getProvider(toolId.toLowerCase());
      } catch {
        throw new Error(`unknown tool '${toolId}'. Use 'dosu mcp list' to see available tools`);
      }
      const cfg = loadConfig();

      if (!isAuthenticated(cfg)) {
        throw new Error("not logged in. Run 'dosu login' first");
      }
      if (isTokenExpired(cfg)) {
        throw new Error("session expired. Run 'dosu login' to re-authenticate");
      }
      if (!cfg.deployment_id) {
        throw new Error(
          "no deployment selected. Run 'dosu' to open the TUI and select a deployment",
        );
      }

      if (provider.id() === "manual") {
        provider.install(cfg, false);
        return;
      }

      let global = opts.global;
      if (!provider.supportsLocal() && !global) {
        console.log(`Note: ${provider.name()} only supports global installation.\n`);
        global = true;
      }

      const scope = global ? "global (all projects)" : "project-local";
      console.log(`Adding Dosu MCP to ${provider.name()} (${scope})...`);

      provider.install(cfg, global);

      console.log(`\n✓ Successfully added Dosu MCP to ${provider.name()}!`);
      if (global) {
        console.log(`\nStart ${provider.name()} in any project to use the Dosu MCP.`);
      } else {
        console.log(`\nStart ${provider.name()} in this project directory to use the Dosu MCP.`);
      }
    });

  mcp
    .command("list")
    .description("List available AI tools")
    .action(() => {
      console.log("Available AI tools:\n");
      for (const p of allProviders()) {
        let scope = "(local + global)";
        if (!p.supportsLocal()) scope = "(global only)";
        if (p.id() === "manual") scope = "";
        console.log(`  ${p.id().padEnd(10)} ${p.name()} ${scope}`);
      }
      console.log("\nUse 'dosu mcp add <tool>' to add Dosu MCP to a tool.");
    });

  // setup
  program
    .command("setup")
    .description("Set up Dosu MCP for your AI tools")
    .option("--deployment <id>", "Skip to tool configuration for a specific deployment")
    .action(async (opts: { deployment?: string }) => {
      const { runSetup } = await import("../setup/flow");
      await runSetup({ deploymentID: opts.deployment });
    });

  return program;
}

export async function execute(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
