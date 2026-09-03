/**
 * CLI command definitions using Commander.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { Command } from "commander";
import { Client } from "../client/client";
import { agentsCommand } from "../commands/agents";
import { analyticsCommand } from "../commands/analytics";
import { askCommand } from "../commands/ask";
import { auditCommand } from "../commands/audit";
import { deploymentsCommand } from "../commands/deployments";
import { docsCommand } from "../commands/docs";
import { integrationsCommand } from "../commands/integrations";
import { knowledgeCommand } from "../commands/knowledge";
import { librariesCommand } from "../commands/libraries";
import { membersCommand } from "../commands/members";
import { orgCommand } from "../commands/org";
import { reviewCommand } from "../commands/review";
import { skillCommand } from "../commands/skill";
import { sourcesCommand } from "../commands/sources";
import { telemetryCommand } from "../commands/telemetry";
import { threadsCommand } from "../commands/threads";
import { topicsCommand } from "../commands/topics";
import { upgradeCommand } from "../commands/upgrade";
import {
  type Config,
  clearConfigInPlace,
  getConfigPath,
  getConfigUserID,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  MODE_OSS,
  parseConfig,
  replaceLoginSession,
  saveConfig,
} from "../config/config";
import { getAccessTokenEmail, getAccessTokenUserID } from "../config/identity";
import { createLogFollower } from "../debug/follow";
import { logger } from "../debug/logger";
import { allProviders, getProvider, type Provider } from "../mcp/providers";
import { browserFallbackHint } from "../setup/styles";
import {
  getOrCreateInstallID,
  isTelemetryEnabled,
  loadTelemetrySettings,
} from "../telemetry/settings";
import {
  type CommandTelemetry,
  type CommandTelemetryContext,
  createCommandTelemetry,
} from "../telemetry/telemetry";
import { checkForReadyTasks } from "../version/pending-tasks-check";
import { checkForSkillUpdates } from "../version/skill-update-check";
import { checkForUpdates } from "../version/update-check";
import { getVersionString } from "../version/version";

export function shouldRunBackgroundChecks(actionName: string): boolean {
  return actionName !== "upgrade";
}

const TELEMETRY_FLUSH_TIMEOUT_MS = 750;
const MAX_TELEMETRY_CONFIG_BYTES = 64 * 1_024;

class CliUsageError extends Error {
  readonly exitCode = 1;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function commandTelemetryName(actionCommand: Command): string {
  const segments: string[] = [];
  let current: Command | null = actionCommand;
  while (current.parent) {
    segments.unshift(current.name());
    current = current.parent;
  }
  if (segments.length > 0) return segments.join(" ");
  return actionCommand.args.length > 0 ? "unknown" : "tui";
}

function shouldTrackCommand(command: string): boolean {
  return command !== "telemetry" && !command.startsWith("telemetry ");
}

function commandTelemetryContext(): CommandTelemetryContext {
  try {
    const cfg = loadConfigForTelemetry();
    if (!cfg) return { mode: "cloud", isAuthenticated: false };
    const authenticated = isAuthenticated(cfg);
    const accessToken = authenticated ? cfg.active_account.session.access_token : "";
    const configUserID = getConfigUserID(cfg);
    const tokenUserID = getAccessTokenUserID(accessToken);
    const userID = configUserID && configUserID === tokenUserID ? configUserID : undefined;
    const email = userID ? getAccessTokenEmail(accessToken) : undefined;
    return {
      mode: cfg.mode === MODE_OSS ? "oss" : "cloud",
      isAuthenticated: authenticated,
      ...(userID ? { user: { id: userID, ...(email ? { email } : {}) } } : {}),
    };
  } catch {
    return { mode: "cloud", isAuthenticated: false };
  }
}

/** Read only a bounded regular file so telemetry can never block a config-free command on a FIFO. */
function loadConfigForTelemetry(): Config | undefined {
  let fd: number | undefined;
  try {
    const nonblocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    fd = openSync(getConfigPath(), constants.O_RDONLY | nonblocking);
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > MAX_TELEMETRY_CONFIG_BYTES) return undefined;

    const content = Buffer.alloc(MAX_TELEMETRY_CONFIG_BYTES + 1);
    const bytesRead = readSync(fd, content, 0, content.byteLength, 0);
    if (bytesRead > MAX_TELEMETRY_CONFIG_BYTES) return undefined;
    return parseConfig(JSON.parse(content.subarray(0, bytesRead).toString("utf8")) as unknown);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Telemetry config cleanup must not affect the command.
      }
    }
  }
}

function startTelemetry(
  telemetry: CommandTelemetry | undefined,
  command: string,
  context: CommandTelemetryContext,
): boolean {
  if (!telemetry) return false;
  try {
    telemetry.start(command, context);
    return true;
  } catch {
    return false;
  }
}

async function finishTelemetry(operation: () => Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TELEMETRY_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Telemetry must never change command output, exit codes, or behavior.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

export function createProgram(options: { telemetry?: CommandTelemetry } = {}): Command {
  const program = new Command();
  let telemetryStarted = false;
  let telemetryValidationFailure = false;

  program
    .name("dosu")
    .description("Dosu CLI - Manage MCP servers for AI tools")
    .version(getVersionString(), "-v, --version")
    .helpCommand("help [command]", "Show help for a command")
    .option("--debug", "Enable debug logging to stderr", false)
    .hook("preAction", async (thisCommand, actionCommand) => {
      const opts = thisCommand.optsWithGlobals();
      logger.init({ debug: opts.debug });
      if (shouldRunBackgroundChecks(actionCommand.name())) {
        if (process.env.NODE_ENV !== "test" && !process.env.CI) {
          // Bare `dosu` launches the TUI, whose welcome banner shows the
          // update itself — the boxed stderr notice would tear across the
          // TUI's redraws.
          const launchesTUI = actionCommand.parent === null;
          await checkForUpdates({ notify: !launchesTUI });
        }
        checkForSkillUpdates();
        checkForReadyTasks();
      }
      const command = commandTelemetryName(actionCommand);
      if (options.telemetry && shouldTrackCommand(command)) {
        telemetryStarted = startTelemetry(options.telemetry, command, commandTelemetryContext());
      }
    })
    .hook("postAction", async () => {
      const exitCode = Number(process.exitCode ?? 0);
      const telemetry = options.telemetry;
      if (telemetryStarted && telemetry) {
        if (telemetryValidationFailure) {
          await finishTelemetry(() =>
            telemetry.fail(new CliUsageError("expected CLI usage error")),
          );
        } else {
          await finishTelemetry(() => telemetry.complete(Number.isFinite(exitCode) ? exitCode : 1));
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
        telemetryValidationFailure = true;
        process.exitCode = 1;
        return;
      }
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
    .option("--no-browser", "Skip browser: print a URL to open on another machine and wait")
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
  program.addCommand(agentsCommand());
  program.addCommand(analyticsCommand());
  program.addCommand(askCommand());
  program.addCommand(auditCommand());
  program.addCommand(deploymentsCommand());
  program.addCommand(docsCommand());
  program.addCommand(integrationsCommand());
  program.addCommand(knowledgeCommand());
  program.addCommand(librariesCommand());
  program.addCommand(membersCommand());
  program.addCommand(orgCommand());
  program.addCommand(reviewCommand());
  program.addCommand(sourcesCommand());
  program.addCommand(telemetryCommand());
  program.addCommand(topicsCommand());
  program.addCommand(threadsCommand());
  program.addCommand(skillCommand());
  program.addCommand(upgradeCommand());

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
          throw new CliUsageError("--tool and --login-ticket require --agent");
        }

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
        await runSetup({ deploymentID: opts.deployment, mode });
      },
    );

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

export async function execute(): Promise<void> {
  const telemetry = processCommandTelemetry();
  const program = createProgram({ telemetry });
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (telemetry) await finishTelemetry(() => telemetry.fail(err));
    throw err;
  }
}

function processCommandTelemetry(): CommandTelemetry | undefined {
  try {
    const settings = loadTelemetrySettings();
    if (!isTelemetryEnabled(settings)) return undefined;
    return createCommandTelemetry(
      {},
      {
        resolveInstallId: () => settings.install_id ?? getOrCreateInstallID(),
      },
    );
  } catch {
    return undefined;
  }
}
