/** `dosu knowledge incognito`: install the `/dosu-incognito` slash command per agent. Running it
 * inside a session marks that session's transcript so studying skips it. */

import { Command } from "commander";
import pc from "picocolors";
import { allIncognitoAgents, getIncognitoAgent } from "../incognito/agents";
import { INCOGNITO_COMMAND_NAME } from "../sync/incognito";
import { resolveAgents } from "./agent-select";
import { printResult } from "./output";

export function incognitoCommand(): Command {
  const cmd = new Command("incognito").description(
    `Manage the /${INCOGNITO_COMMAND_NAME} slash command that turns Dosu off for one session`,
  );

  cmd
    .command("status")
    .description("Show whether the slash command is installed for each supported agent")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = allIncognitoAgents().map((agent) => ({
        agent: agent.id(),
        name: agent.name(),
        installed: agent.isInstalled(),
        enabled: agent.isEnabled(),
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
            `Inside a session, run /${INCOGNITO_COMMAND_NAME} to keep that session out of studying.`,
        ),
      );
    });

  cmd
    .command("enable [agents...]")
    .description("Install the slash command for agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveAgents(ids, allIncognitoAgents, getIncognitoAgent)) {
        try {
          const action = agent.enable();
          const verb = action === "unchanged" ? "already installed" : "installed";
          console.log(
            `✓ ${agent.name()} \u00B7 /${INCOGNITO_COMMAND_NAME} ${verb} (${agent.commandPath()})`,
          );
        } catch (err) {
          reportFailure(agent.name(), err);
        }
      }
    });

  cmd
    .command("disable [agents...]")
    .description("Remove the slash command from agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveAgents(ids, allIncognitoAgents, getIncognitoAgent)) {
        try {
          const action = agent.disable();
          const verb = action === "removed" ? "removed" : "was not installed";
          console.log(`✓ ${agent.name()} \u00B7 /${INCOGNITO_COMMAND_NAME} ${verb}`);
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
