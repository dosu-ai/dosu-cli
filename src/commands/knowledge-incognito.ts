/** `dosu knowledge incognito on|off [agents...]`: a saved per-agent switch. An agent in
 * incognito has none of its sessions shipped to Dosu memory, with no command needed, and `off`
 * first seals the ones that ran while it was in, so they stay out too. Its incognito command
 * (`/dosu-incognito`; `$dosu-incognito`, a skill, in Codex) stays available in every agent for
 * keeping a single session out while the agent ships; `on` and `off` reinstall it when it is
 * missing (pi's comes with its extension, which they never install). */

import { Command } from "commander";
import pc from "picocolors";
import { allIncognitoAgents, getIncognitoAgent, type IncognitoAgent } from "../incognito/agents";
import { sessionsToSeal } from "../sync/backlog";
import { INCOGNITO_COMMAND_NAME } from "../sync/incognito";
import { leaveIncognito, loadSyncState, setAgentsIncognito } from "../sync/state";
import { VERSION } from "../version/version";
import { resolveAgents } from "./agent-select";
import { printResult } from "./output";

/** Keep the agent's incognito command present; a failure here must not undo the switch itself. */
function ensureCommand(agent: IncognitoAgent): void {
  try {
    agent.enable();
  } catch (err) {
    reportFailure(agent.name(), err, `could not install ${agent.invocation()}`);
  }
}

function switchAction(incognito: boolean) {
  return (ids: string[]): void => {
    const agents = resolveAgents(ids, allIncognitoAgents, getIncognitoAgent);
    if (agents.length === 0) return;
    const agentIds = agents.map((agent) => agent.id());
    try {
      if (incognito) setAgentsIncognito(agentIds, true);
      // Sealing reads the sessions on disk; when that fails nothing is saved (fail closed).
      else leaveIncognito(agentIds, sessionsToSeal, VERSION);
    } catch (err) {
      // Nothing was saved: say which agents that leaves in incognito.
      const listed = new Set(loadSyncState().incognito_agents ?? []);
      const kept = incognito ? [] : agents.filter((agent) => listed.has(agent.id()));
      const names = kept.map((agent) => agent.name()).join(", ");
      reportFailure(
        "Dosu",
        err,
        kept.length > 0
          ? `could not save the setting; ${names} ${kept.length === 1 ? "stays" : "stay"} incognito`
          : "could not save the setting",
      );
      return;
    }
    for (const agent of agents) {
      ensureCommand(agent);
      console.log(
        incognito
          ? `👻 ${agent.name()} is incognito: its sessions will not be shipped to Dosu memory`
          : `📚 ${agent.name()} sessions ship to Dosu memory again`,
      );
    }
    if (!incognito) {
      console.log(pc.dim("Sessions that ran while incognito stay off the record."));
    }
  };
}

export function incognitoCommand(): Command {
  const cmd = new Command("incognito").description(
    "Keep a coding agent's sessions out of Dosu memory",
  );

  cmd
    .command("status")
    .description("Show which agents are incognito, and how each runs its incognito command")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const incognitoAgents = new Set(loadSyncState().incognito_agents ?? []);
      const agents = allIncognitoAgents();
      const rows = agents.map((agent) => ({
        agent: agent.id(),
        name: agent.name(),
        installed: agent.isInstalled(),
        incognito: incognitoAgents.has(agent.id()),
        command_installed: agent.isEnabled(),
        invocation: agent.invocation(),
        command_path: agent.commandPath(),
      }));

      if (opts.json) {
        printResult(rows, opts);
        return;
      }

      for (const [i, row] of rows.entries()) {
        const state = !row.installed
          ? pc.dim("agent not found")
          : row.incognito
            ? "👻 incognito (not shipped)"
            : pc.green("📚 shipped");
        const hint = agents[i].missingHint?.();
        const missing =
          row.installed && !row.command_installed
            ? pc.dim(`  (${row.invocation} missing${hint ? `; ${hint}` : ""})`)
            : "";
        console.log(`  ${row.agent.padEnd(8)} ${row.name.padEnd(14)} ${state}${missing}`);
      }
      console.log(
        pc.dim(
          `\nUse 'dosu knowledge incognito on|off [agent...]' to change these.\n` +
            `To keep a single session out instead, run /${INCOGNITO_COMMAND_NAME} ($${INCOGNITO_COMMAND_NAME} in Codex) in it.`,
        ),
      );
    });

  cmd
    .command("on [agents...]")
    .description("Stop shipping these agents' sessions (default: all detected)")
    .action(switchAction(true));

  cmd
    .command("off [agents...]")
    .description("Ship these agents' sessions again (default: all detected)")
    .action(switchAction(false));

  return cmd;
}

function reportFailure(label: string, err: unknown, what: string): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${label}: ${what}: ${message}`));
  process.exitCode = 1;
}
