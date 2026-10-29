/** CLI command definitions using Commander. */

import { readFileSync, unlinkSync } from "node:fs";
import { Command } from "commander";
import { Client } from "../client/client";
import { knowledgeCommand } from "../commands/knowledge";
import { memoryCommand } from "../commands/memory";
import { projectCommand } from "../commands/project";
import { sourcesCommand } from "../commands/sources";
import { storeCommands } from "../commands/store";
import { syncCommand } from "../commands/sync";
import { upgradeCommand } from "../commands/upgrade";
import {
  type Config,
  clearConfigInPlace,
  getConfigPath,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  MODE_OSS,
  replaceLoginSession,
  saveConfig,
} from "../config/config";
import { createLogFollower } from "../debug/follow";
import { logger } from "../debug/logger";
import { refreshEnabledHooks } from "../hooks/agents";
import { allProviders, getProvider, type Provider } from "../mcp/providers";
import { configuredProviders, refreshConfiguredProviders } from "../mcp/refresh";
import { browserFallbackHint } from "../setup/styles";
import { checkForIncognitoBackfill } from "../version/incognito-backfill-check";
import {
  canRefreshMcp,
  checkForMcpRefresh,
  writeMcpRefreshCache,
} from "../version/mcp-refresh-check";
import { checkForUpdates } from "../version/update-check";
import { getVersionString, VERSION } from "../version/version";
import { CliUsageError } from "./errors";
import { fatalErrorDiagnostics, printFatalError } from "./fatal-error";

/** Commands that skip the update / skill / ready-task / MCP-refresh checks: `upgrade` does its
 * own, and the prompt-submit hook runs on every prompt while the user waits. */
const NO_BACKGROUND_CHECKS = new Set([
  "upgrade",
  "knowledge context",
  // Started by agents: the MCP server owns stdout for the protocol, and agents run the memory
  // commands from their shell while they wait.
  "mcp serve",
  "memory search",
  "memory evidence",
]);

/** `command` is the full subcommand path, e.g. `knowledge context`. */
export function shouldRunBackgroundChecks(command: string): boolean {
  return !NO_BACKGROUND_CHECKS.has(command);
}

/** `dosu setup` and `dosu mcp refresh` rewrite the agents' MCP entries themselves (and record
 * the version); running the automatic post-upgrade refresh first would do it twice and print
 * two reports. `dosu knowledge sync` is the hook command: it runs inside a live agent session,
 * where rewriting the agent's own config races its writes and the stderr nudge is never seen.
 * Deferring to the next command a person actually types loses nothing — the hook itself does
 * not depend on the MCP entry. */
export function shouldRunMcpRefreshCheck(actionCommand: Command): boolean {
  if (actionCommand.name() === "setup") return false;
  const parent = actionCommand.parent?.name();
  if (actionCommand.name() === "refresh" && parent === "mcp") return false;
  return !(actionCommand.name() === "sync" && parent === "knowledge");
}

function commandName(actionCommand: Command): string {
  const segments: string[] = [];
  let current: Command | null = actionCommand;
  while (current.parent) {
    segments.unshift(current.name());
    current = current.parent;
  }
  return segments.join(" ");
}

/** Suggest the closest registered command name for a mistyped one, if any is close enough. */
function suggestClosestCommand(input: string, program: Command): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  const candidates = ["help", ...program.commands.flatMap((c) => [c.name(), ...c.aliases()])];
  for (const name of candidates) {
    const d = editDistance(input.toLowerCase(), name.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = name;
    }
  }
  // Same threshold commander uses for its own suggestions.
  return best !== undefined && bestDistance <= 3 && bestDistance < best.length ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("dosu")
    .description(
      "Dosu CLI - capture your coding-agent sessions for Dosu memory through your sessiondb server",
    )
    .version(getVersionString(), "-v, --version")
    .helpCommand("help [command]", "Show help for a command")
    .option("--debug", "Enable debug logging to stderr", false)
    .hook("preAction", async (thisCommand, actionCommand) => {
      const opts = thisCommand.optsWithGlobals();
      logger.init({ debug: opts.debug });
      if (shouldRunBackgroundChecks(commandName(actionCommand))) {
        if (process.env.NODE_ENV !== "test" && !process.env.CI) {
          await checkForUpdates({ notify: true });
        }
        // First run on a new version: rewrite configured agents' MCP entries
        // that are not the shape this version writes, so format changes land
        // without a manual `dosu setup`.
        if (shouldRunMcpRefreshCheck(actionCommand)) {
          checkForMcpRefresh({ notify: true });
          checkForIncognitoBackfill({ notify: true });
        }
      }
    })
    .allowExcessArguments(true)
    .action(async () => {
      const command = program.args[0];
      if (command !== undefined) {
        // An unrecognized first token reaches the root action instead of a
        // subcommand — report it as an unknown command, not "too many arguments".
        let message = `error: unknown command '${command}'`;
        const suggestion = suggestClosestCommand(command, program);
        if (suggestion) message += `\n(Did you mean '${suggestion}'?)`;
        message += "\nRun 'dosu --help' to see available commands.";
        console.error(message);
        process.exitCode = 1;
        return;
      }
      // Default: the interactive home screen when there is a terminal to draw it on; piped
      // or scripted, the help text says what the commands are.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        program.outputHelp();
        return;
      }
      const { runTUI } = await import("../tui/tui");
      await runTUI();
    });

  // login
  program
    .command("login")
    .description("Authenticate with Dosu via OAuth")
    .option("--no-browser", "Skip browser: print a URL to open on another machine and wait")
    .action(async (opts: { browser: boolean }) => {
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
          result = await startOAuthFlow(undefined, undefined, undefined, (url) => {
            console.log(browserFallbackHint(url));
          });
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

      replaceLoginSession(cfg, {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + token.expires_in,
      });
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
      clearConfigInPlace(cfg);
      saveConfig(cfg);
      console.log("Successfully logged out.");
    });

  // status
  program
    .command("status")
    .description("Show current authentication and MCP status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const mode = cfg.mode === MODE_OSS ? "oss" : "cloud";
      if (!isAuthenticated(cfg)) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                authenticated: false,
                session_status: "missing",
                mode,
                mcp: {
                  status: "not_configured",
                  deployment_id: null,
                  deployment_name: null,
                },
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log("Status: Not logged in");
        console.log("Run 'dosu login' to authenticate.");
        return;
      }

      const sessionStatus =
        isTokenExpired(cfg) && !(await ensureFreshSession(cfg)) ? "expired" : "valid";
      if (opts.json) {
        const deploymentId = cfg.active_account.target?.deployment_id ?? null;
        const deploymentName = cfg.active_account.target?.deployment_name ?? null;
        const mcpStatus =
          cfg.mode === MODE_OSS
            ? "public_libraries"
            : deploymentId
              ? "configured"
              : "not_configured";
        console.log(
          JSON.stringify(
            {
              authenticated: sessionStatus === "valid",
              session_status: sessionStatus,
              mode,
              mcp: {
                status: mcpStatus,
                deployment_id: deploymentId,
                deployment_name: deploymentName,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      if (sessionStatus === "expired") {
        console.log("Status: Token expired");
        console.log("Run 'dosu login' to re-authenticate.");
      } else {
        console.log("Status: Logged in");
      }
      if (cfg.mode === MODE_OSS) {
        console.log("Mode: OSS");
        console.log("MCP: Public libraries only");
      } else if (cfg.active_account?.target?.deployment_id) {
        console.log(`MCP: ${cfg.active_account?.target?.deployment_name}`);
        console.log(`MCP ID: ${cfg.active_account?.target?.deployment_id}`);
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
        throw new CliUsageError(
          `unknown tool '${toolId}'. Use 'dosu mcp list' to see available tools`,
        );
      }
      const cfg = loadConfig();

      if (!isAuthenticated(cfg)) {
        throw new CliUsageError("not logged in. Run 'dosu login' first");
      }
      if (isTokenExpired(cfg) && !(await ensureFreshSession(cfg))) {
        throw new CliUsageError("session expired. Run 'dosu login' to re-authenticate");
      }
      if (cfg.mode !== MODE_OSS && !cfg.active_account?.target?.deployment_id) {
        throw new CliUsageError("no MCP selected. Run 'dosu' to open the TUI and select an MCP");
      }
      if (!cfg.active_account?.target?.api_key) {
        throw new CliUsageError("no API key available. Run 'dosu setup' to create one");
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
    .command("refresh")
    .description(
      "Rewrite the Dosu MCP entry in every configured AI tool and re-apply agents' enabled hooks",
    )
    .action(() => {
      const cfg = loadConfig();
      if (!canRefreshMcp(cfg)) {
        throw new CliUsageError("Dosu is not set up yet. Run 'dosu setup' first");
      }
      const configured = configuredProviders();
      if (configured.length === 0) {
        console.log("No AI tools with Dosu configured. Run 'dosu setup' to add Dosu to a tool.");
        return;
      }
      console.log("Refreshing Dosu MCP config for configured AI tools...\n");
      const result = refreshConfiguredProviders(cfg);
      // The marker tells the automatic post-upgrade check this release's refresh is done, hooks
      // included, so the hooks have to be re-applied before it is written.
      refreshEnabledHooks();
      writeMcpRefreshCache({ version: VERSION });
      for (const provider of result.updated) {
        console.log(`  ✓ ${provider.name()}`);
      }
      for (const { provider, error } of result.failed) {
        console.log(`  ✗ ${provider.name()}: ${error.message}`);
      }
      console.log("\nRestart your AI agents so they pick up the change.");
      if (result.failed.length > 0) process.exitCode = 1;
    });

  mcp
    .command("serve")
    .description("Run the local Dosu MCP server (stdio) that AI tools start from their MCP config")
    .option("--client <id>", "The AI tool this server runs for (claude-code, codex, opencode, ...)")
    .action(async (opts: { client?: string }) => {
      const { runMcpServe } = await import("../mcp/proxy");
      process.exitCode = await runMcpServe({ client: opts.client });
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

  program.addCommand(knowledgeCommand());
  program.addCommand(memoryCommand());
  program.addCommand(projectCommand());
  program.addCommand(syncCommand()); // `dosu knowledge sync` stays as the hook command.
  for (const cmd of storeCommands()) program.addCommand(cmd);
  program.addCommand(sourcesCommand());
  program.addCommand(upgradeCommand());

  // setup
  program
    .command("setup")
    .description("Set up Dosu MCP for your AI tools")
    .option("--deployment <id>", "Skip to tool configuration for a specific MCP")
    .option("--mode <mode>", "Force OSS or Cloud mode, skipping the interactive prompt (oss|cloud)")
    .option(
      "--storage",
      "Ask again which sessiondb server finished sessions ship to",
    )
    .action(async (opts: { deployment?: string; mode?: string; storage?: boolean }) => {
      const { runSetup } = await import("../setup/flow");
      let mode: "oss" | "cloud" | undefined;
      if (opts.mode !== undefined) {
        const normalized = opts.mode.toLowerCase();
        if (normalized !== "oss" && normalized !== "cloud") {
          throw new CliUsageError(
            `invalid --mode value '${opts.mode}' (expected 'oss' or 'cloud')`,
          );
        }
        mode = normalized;
      }
      await runSetup({ deploymentID: opts.deployment, mode, storage: opts.storage });
    });

  // logs
  program
    .command("logs")
    .description("View or manage debug logs")
    .option("-t, --tail [n]", "Show last N lines (default: 50)")
    .option("-f, --follow", "Show recent lines, then stream new ones as they arrive (Ctrl+C stops)")
    .option("--clear", "Delete the log file")
    .action((opts: { tail?: string | true; follow?: boolean; clear?: boolean }) => {
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

      if (opts.follow) {
        // Recent context first, then poll for appends. The interval keeps
        // the process alive until the user interrupts it.
        try {
          const lines = readFileSync(logPath, "utf-8").split("\n");
          if (lines.at(-1) === "") lines.pop(); // trailing newline
          console.log(lines.slice(-followTailLines(opts.tail)).join("\n"));
        } catch {
          console.log(`No log file at ${logPath} yet; waiting for output...`);
        }
        const follower = createLogFollower(logPath, (chunk) => process.stdout.write(chunk));
        setInterval(() => follower.poll(), FOLLOW_POLL_MS);
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

const FOLLOW_POLL_MS = 500;
const DEFAULT_TAIL_LINES = 50;

/** Lines of history `logs --follow` prints before streaming; -t overrides. */
function followTailLines(tail?: string | true): number {
  return typeof tail === "string"
    ? Number.parseInt(tail, 10) || DEFAULT_TAIL_LINES
    : DEFAULT_TAIL_LINES;
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

/** Run the CLI. A command that fails throws; the error unwinds to here, which is the one place
 * that prints it and exits 1. */
export async function execute(): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    printFatalError(err);
    logFatalError(err);
    process.exit(1);
  }
}

/** Keep the failure, including any server request ID, in the local debug log. */
function logFatalError(err: unknown): void {
  try {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const diagnostics = fatalErrorDiagnostics(err);
    logger.error("cli", diagnostics ? `${message} (${diagnostics})` : message);
  } catch {
    // Logging must never change how the command fails.
  }
}
