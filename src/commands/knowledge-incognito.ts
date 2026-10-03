/** `dosu knowledge incognito`: install the `/dosu-incognito` command per agent (`$dosu-incognito`,
 * a skill, in Codex). Running it inside a session marks that session's transcript so it is never
 * shipped. */

import { Command } from "commander";
import pc from "picocolors";
import { allIncognitoAgents, getIncognitoAgent } from "../incognito/agents";
import { INCOGNITO_COMMAND_NAME } from "../sync/incognito";
import { resolveAgents } from "./agent-select";
import { printResult } from "./output";

export function incognitoCommand(): Command {
  const cmd = new Command("incognito").description(
    `Manage the /${INCOGNITO_COMMAND_NAME} command (Codex: $${INCOGNITO_COMMAND_NAME}) that turns Dosu off for one session`,
  );

  cmd
    .command("status")
    .description("Show whether the command is installed for each supported agent")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = allIncognitoAgents().map((agent) => ({
        agent: agent.id(),
        name: agent.name(),
        installed: agent.isInstalled(),
        enabled: agent.isEnabled(),
        invocation: agent.invocation(),
        command_path: agent.commandPath(),
      }));

      if (opts.json) {
        printResult(rows, opts);
        return;
      }

      for (const row of rows) {
        const state = !row.installed
          ? pc.dim("not installed")
          : row.enabled
            ? pc.green("enabled")
            : "disabled";
        console.log(`  ${row.agent.padEnd(8)} ${row.name.padEnd(14)} ${state}`);
      }
      console.log(
        pc.dim(
          `\nUse 'dosu knowledge incognito enable|disable [agent...]' to change these.\n` +
            `Inside a session, run /${INCOGNITO_COMMAND_NAME} ($${INCOGNITO_COMMAND_NAME} in Codex) to keep that session out of Dosu memory.`,
        ),
      );
    });

  cmd
    .command("enable [agents...]")
    .description("Install the command for agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveAgents(ids, allIncognitoAgents, getIncognitoAgent)) {
        try {
          const action = agent.enable();
          const verb = action === "unchanged" ? "already installed" : "installed";
          console.log(
            `✓ ${agent.name()} \u00B7 ${agent.invocation()} ${verb} (${agent.commandPath()})`,
          );
        } catch (err) {
          reportFailure(agent.name(), err);
        }
      }
    });

  cmd
    .command("disable [agents...]")
    .description("Remove the command from agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveAgents(ids, allIncognitoAgents, getIncognitoAgent)) {
        try {
          const action = agent.disable();
          const verb = action === "removed" ? "removed" : "was not installed";
          console.log(`✓ ${agent.name()} \u00B7 ${agent.invocation()} ${verb}`);
        } catch (err) {
          reportFailure(agent.name(), err);
        }
      }
    });

  return cmd;
}

function reportFailure(agentName: string, err: unknown): void {
  console.error(pc.red(`✗ ${agentName}: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
}
