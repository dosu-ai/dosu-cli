/** `dosu knowledge incognito on|off [agents...]`: a saved per-agent switch. An agent in
 * incognito has none of its sessions studied, with no slash command needed. `/dosu-incognito`
 * stays available in every agent for keeping a single chat out while the agent is studied; `on`
 * and `off` reinstall it when it is missing. */

import { Command } from "commander";
import pc from "picocolors";
import { allIncognitoAgents, getIncognitoAgent, type IncognitoAgent } from "../incognito/agents";
import { INCOGNITO_COMMAND_NAME } from "../sync/incognito";
import { loadSyncState, setAgentsIncognito } from "../sync/watermark";
import { resolveAgents } from "./agent-select";
import { printResult } from "./output";

const SLASH = `/${INCOGNITO_COMMAND_NAME}`;

/** Keep `/dosu-incognito` present; a failure here must not undo the switch itself. */
function ensureSlashCommand(agent: IncognitoAgent): void {
  try {
    agent.enable();
  } catch (err) {
    reportFailure(agent.name(), err, `could not install ${SLASH}`);
  }
}

function switchAction(incognito: boolean) {
  return (ids: string[]): void => {
    const agents = resolveAgents(ids, allIncognitoAgents, getIncognitoAgent);
    if (agents.length === 0) return;
    try {
      setAgentsIncognito(
        agents.map((agent) => agent.id()),
        incognito,
      );
    } catch (err) {
      reportFailure("Dosu", err, "could not save the setting");
      return;
    }
    for (const agent of agents) {
      ensureSlashCommand(agent);
      console.log(
        incognito
          ? `👻 ${agent.name()} is incognito: its sessions will not be studied`
          : `📚 ${agent.name()} is studied again`,
      );
    }
    if (!incognito) {
      console.log(pc.dim("Sessions that finished while incognito stay unstudied."));
    }
  };
}

export function incognitoCommand(): Command {
  const cmd = new Command("incognito").description(
    "Keep a coding agent's sessions out of Dosu studying",
  );

  cmd
    .command("status")
    .description("Show which agents are incognito")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const incognitoAgents = new Set(loadSyncState().incognito_agents ?? []);
      const rows = allIncognitoAgents().map((agent) => ({
        agent: agent.id(),
        name: agent.name(),
        installed: agent.isInstalled(),
        incognito: incognitoAgents.has(agent.id()),
        command_installed: agent.isEnabled(),
        command_path: agent.commandPath(),
      }));

      if (opts.json) {
        printResult(rows, opts);
        return;
      }

      for (const row of rows) {
        const state = !row.installed
          ? pc.dim("agent not found")
          : row.incognito
            ? "👻 incognito (not studied)"
            : pc.green("📚 studied");
        const missing =
          row.installed && !row.command_installed ? pc.dim(`  (${SLASH} missing)`) : "";
        console.log(`  ${row.agent.padEnd(8)} ${row.name.padEnd(14)} ${state}${missing}`);
      }
      console.log(
        pc.dim(
          `\nUse 'dosu knowledge incognito on|off [agent...]' to change these.\n` +
            `To keep a single chat out instead, type ${SLASH} in it.`,
        ),
      );
    });

  cmd
    .command("on [agents...]")
    .description("Stop studying these agents' sessions (default: all detected)")
    .action(switchAction(true));

  cmd
    .command("off [agents...]")
    .description("Study these agents' sessions again (default: all detected)")
    .action(switchAction(false));

  return cmd;
}

function reportFailure(label: string, err: unknown, what: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${label}: ${what}: ${message}`));
  process.exitCode = 1;
}
