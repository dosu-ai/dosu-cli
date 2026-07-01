/**
 * CLI command definitions using Commander.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { Command } from "commander";
import { Client } from "../client/client";
import { analyticsCommand } from "../commands/analytics";
import { askCommand } from "../commands/ask";
import { auditCommand } from "../commands/audit";
import { deploymentsCommand } from "../commands/deployments";
import { docsCommand } from "../commands/docs";
import { hooksCommand } from "../commands/hooks";
import { insightsCommand } from "../commands/insights";
import { integrationsCommand } from "../commands/integrations";
import { knowledgeCommand } from "../commands/knowledge";
import { membersCommand } from "../commands/members";
import { orgCommand } from "../commands/org";
import { reviewCommand } from "../commands/review";
import { skillCommand } from "../commands/skill";
import { sourcesCommand } from "../commands/sources";
import { suggestCommand } from "../commands/suggest";
import { tagsCommand } from "../commands/tags";
import { threadsCommand } from "../commands/threads";
import {
  type Config,
  getConfigPath,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  MODE_OSS,
  saveConfig,
} from "../config/config";
import { logger } from "../debug/logger";
import { allProviders, getProvider, type Provider } from "../mcp/providers";
import { checkForReadyTasks } from "../version/pending-tasks-check";
import { checkForSkillUpdates } from "../version/skill-update-check";
import { checkForUpdates } from "../version/update-check";
import { getVersionString } from "../version/version";

/**
 * Hook entrypoints are auto-invoked by Claude Code on every turn and must stay
 * fast and stdout-clean. Skip the update checks for them (their stderr notices
 * are noise on the hot path and the background fetch can delay process exit).
 */
const HOOK_ENTRYPOINTS = new Set(["user-prompt-submit", "post-tool-use", "stop"]);
function isHookEntrypointInvocation(argv: string[]): boolean {
  const i = argv.indexOf("hooks");
  return i >= 0 && HOOK_ENTRYPOINTS.has(argv[i + 1] ?? "");
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("dosu")
    .description("Dosu CLI - Manage MCP servers for AI tools")
    .version(getVersionString(), "-v, --version")
    .option("--debug", "Enable debug logging to stderr", false)
    .hook("preAction", (thisCommand) => {
      const opts = thisCommand.optsWithGlobals();
      logger.init({ debug: opts.debug });
      if (!isHookEntrypointInvocation(process.argv)) {
        checkForUpdates();
        checkForSkillUpdates();
        checkForReadyTasks();
      }
    })
    .action(async () => {
      // Default: launch TUI when no subcommand given
      const { runTUI } = await import("../tui/tui");
      await runTUI();
    });

  // login
  program
    .command("login")
    .description("Authenticate with Dosu via OAuth")
    .option(
      "--request",
      "Mint a login ticket for agent / human-in-the-loop auth (prints URL and exits)",
    )
    .option("--check <ticket>", "Exchange a login ticket created with --request for a token")
    .option("--json", "Emit machine-readable JSON output (use with --request or --check)")
    .option("--no-browser", "Skip browser — print a URL to open on another machine and wait")
    .action(
      async (opts: { request?: boolean; check?: string; json?: boolean; browser: boolean }) => {
        if (opts.request && opts.check !== undefined) {
          console.error("--request and --check cannot be combined.");
          process.exitCode = 2;
          return;
        }

        if (opts.request) {
          const { runLoginRequest } = await import("../agent/login-commands");
          process.exitCode = await runLoginRequest({ json: opts.json === true });
          return;
        }

        if (opts.check !== undefined) {
          const { runLoginCheck } = await import("../agent/login-commands");
          process.exitCode = await runLoginCheck({
            ticket: opts.check,
            json: opts.json === true,
          });
          return;
        }

        const cfg = loadConfig();
        if (isAuthenticated(cfg)) {
          if (!isTokenExpired(cfg)) {
            console.log("You are already logged in.");
            console.log("Run 'dosu logout' first to re-authenticate.");
            return;
          }
          if (await ensureFreshSession(cfg)) {
            console.log("Session refreshed.");
            console.log(`Credentials saved to ${getConfigPath()}`);
            return;
          }
        }

        const { isHeadless } = await import("../auth/headless");
        const useDeviceFlow = !opts.browser || isHeadless();

        const { OAuthCallbackError } = await import("../auth/errors");

        let token: { access_token: string; refresh_token: string; expires_in: number };

        if (useDeviceFlow) {
          const { startDeviceFlow } = await import("../auth/device");
          try {
            token = await startDeviceFlow();
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
            return;
          }
        } else {
          console.log("Opening browser for authentication...");
          const { startOAuthFlow } = await import("../auth/flow");
          let result: Awaited<ReturnType<typeof startOAuthFlow>>;
          try {
            result = await startOAuthFlow();
          } catch (err) {
            if (err instanceof OAuthCallbackError) {
              console.error(err.userMessage);
            } else {
              console.error(err instanceof Error ? err.message : String(err));
            }
            process.exitCode = 1;
            return;
          }

          if (!result.browserOpened) {
            // Browser unavailable — fall through to device flow
            const { startDeviceFlow } = await import("../auth/device");
            try {
              token = await startDeviceFlow();
            } catch (err) {
              console.error(err instanceof Error ? err.message : String(err));
              process.exitCode = 1;
              return;
            }
          } else {
            token = result.token;
          }
        }

        cfg.access_token = token.access_token;
        cfg.refresh_token = token.refresh_token;
        cfg.expires_at = Math.floor(Date.now() / 1000) + token.expires_in;
        saveConfig(cfg);

        console.log("Successfully authenticated!");
        console.log(`Credentials saved to ${getConfigPath()}`);
      },
    );

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
      cfg.org_id = undefined;
      cfg.space_id = undefined;
      saveConfig(cfg);
      console.log("Successfully logged out.");
    });

  // status
  program
    .command("status")
    .description("Show current authentication and MCP status")
    .action(async () => {
      const cfg = loadConfig();
      if (!isAuthenticated(cfg)) {
        console.log("Status: Not logged in");
        console.log("Run 'dosu login' to authenticate.");
        return;
      }
      if (isTokenExpired(cfg) && !(await ensureFreshSession(cfg))) {
        console.log("Status: Token expired");
        console.log("Run 'dosu login' to re-authenticate.");
      } else {
        console.log("Status: Logged in");
      }
      if (cfg.mode === MODE_OSS) {
        console.log("Mode: OSS");
        console.log("MCP: Public libraries only");
      } else if (cfg.deployment_id) {
        console.log(`MCP: ${cfg.deployment_name}`);
        console.log(`MCP ID: ${cfg.deployment_id}`);
      } else {
        console.log("MCP: None selected");
        console.log(
          "Run 'dosu deployments list' to see available MCPs, then 'dosu deployments switch <id>' to select one.",
        );
      }
    });

  // mcp
  const mcp = program.command("mcp").description("Manage MCP server integrations");

  mcp
    .command("add <agent>")
    .description("Add Dosu MCP to an AI tool")
    .option("-g, --global", "Add globally (all projects) instead of project-local", false)
    .option("--show-secret", "Print full manual configuration secrets", false)
    .action(async (toolId: string, opts: { global: boolean; showSecret: boolean }) => {
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
      if (isTokenExpired(cfg) && !(await ensureFreshSession(cfg))) {
        throw new Error("session expired. Run 'dosu login' to re-authenticate");
      }
      if (cfg.mode !== MODE_OSS && !cfg.deployment_id) {
        throw new Error("no MCP selected. Run 'dosu' to open the TUI and select an MCP");
      }
      if (!cfg.api_key) {
        throw new Error("no API key available. Run 'dosu setup' to create one");
      }

      if (provider.id() === "manual") {
        provider.install(cfg, false, { showSecret: opts.showSecret });
        return;
      }

      let global = opts.global;
      if (!provider.supportsLocal() && !global) {
        console.log(`Note: ${provider.name()} only supports global installation.\n`);
        global = true;
      }

      const scope = global ? "global (all projects)" : "project-local";
      console.log(`Adding Dosu MCP to ${provider.name()} (${scope})...`);

      provider.install(cfg, global, { showSecret: opts.showSecret });

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
      console.log("\nUse 'dosu mcp add <agent>' to add Dosu MCP to a tool.");
    });

  // Agent-facing commands
  program.addCommand(analyticsCommand());
  program.addCommand(askCommand());
  program.addCommand(auditCommand());
  program.addCommand(deploymentsCommand());
  program.addCommand(docsCommand());
  program.addCommand(hooksCommand());
  program.addCommand(insightsCommand());
  program.addCommand(integrationsCommand());
  program.addCommand(knowledgeCommand());
  program.addCommand(membersCommand());
  program.addCommand(orgCommand());
  program.addCommand(reviewCommand());
  program.addCommand(sourcesCommand());
  program.addCommand(suggestCommand());
  program.addCommand(tagsCommand());
  program.addCommand(threadsCommand());
  program.addCommand(skillCommand());

  // setup
  program
    .command("setup")
    .description("Set up Dosu MCP for your AI tools")
    .option("--deployment <id>", "Skip to tool configuration for a specific MCP")
    .option("--mode <mode>", "Force OSS or Cloud mode, skipping the interactive prompt (oss|cloud)")
    .option("--agent", "Run non-interactive setup designed for coding agents (requires --tool)")
    .option(
      "--tool <id>",
      "Configure a single AI tool by id (claude, cursor, codex, …). Required with --agent.",
    )
    .option(
      "--login-ticket <ticket>",
      "Resume an --agent setup by redeeming a ticket from a previous run",
    )
    .action(
      async (opts: {
        deployment?: string;
        mode?: string;
        agent?: boolean;
        tool?: string;
        loginTicket?: string;
      }) => {
        if (opts.agent) {
          if (!opts.tool) {
            const { emitError } = await import("../agent/output");
            const { listAgentSupportedToolIDs } = await import("../agent/flow");
            emitError({
              step: "setup",
              reason: "missing_tool",
              agent_next_steps: `Pass --tool <id> when using --agent. Supported ids: ${listAgentSupportedToolIDs().join(", ")}.`,
            });
            process.exitCode = 2;
            return;
          }
          const { runAgentSetup } = await import("../agent/flow");
          process.exitCode = await runAgentSetup({
            tool: opts.tool,
            loginTicket: opts.loginTicket,
            deploymentID: opts.deployment,
          });
          return;
        }

        // Non-agent flags that only make sense with --agent.
        if (opts.tool || opts.loginTicket) {
          throw new Error("--tool and --login-ticket require --agent");
        }

        const { runSetup } = await import("../setup/flow");
        let mode: "oss" | "cloud" | undefined;
        if (opts.mode !== undefined) {
          const normalized = opts.mode.toLowerCase();
          if (normalized !== "oss" && normalized !== "cloud") {
            throw new Error(`invalid --mode value '${opts.mode}' (expected 'oss' or 'cloud')`);
          }
          mode = normalized;
        }
        await runSetup({ deploymentID: opts.deployment, mode });
      },
    );

  // logs
  program
    .command("logs")
    .description("View or manage debug logs")
    .option("-t, --tail [n]", "Show last N lines (default: 50)")
    .option("--clear", "Delete the log file")
    .action((opts: { tail?: string | true; clear?: boolean }) => {
      const logPath = logger.getLogPath();

      if (opts.clear) {
        try {
          unlinkSync(logPath);
          console.log("Log file deleted.");
        } catch {
          console.log("No log file to delete.");
        }
        return;
      }

      if (opts.tail !== undefined) {
        const n = typeof opts.tail === "string" ? parseInt(opts.tail, 10) || 50 : 50;
        try {
          const content = readFileSync(logPath, "utf-8");
          const lines = content.split("\n");
          console.log(lines.slice(-n).join("\n"));
        } catch {
          console.log(`No log file found at ${logPath}`);
        }
        return;
      }

      // No flags: print log file path
      console.log(logPath);
    });

  return program;
}

async function ensureFreshSession(cfg: Config): Promise<boolean> {
  if (!isTokenExpired(cfg)) return true;
  try {
    logger.debug("cli", "token expired, attempting refresh");
    await new Client(cfg).refreshToken();
    return true;
  } catch (err: unknown) {
    logger.debug("cli", `token refresh failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function execute(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
