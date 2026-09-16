/** `dosu knowledge statusline`: install a status-bar line in Claude Code / Cursor CLI that says
 * whether the current session is being studied, plus the `render` command those harnesses run. */

import { Command } from "commander";
import pc from "picocolors";
import {
  allStatuslineAgents,
  getStatuslineAgent,
  statuslineCommand as installedCommand,
  StatuslineConflictError,
} from "../statusline/agents";
import { STATUSLINE_LABELS } from "../statusline/render";
import { type RenderRunDeps, runStatuslineRender } from "../statusline/run";
import { resolveAgents } from "./agent-select";
import { printResult } from "./output";

export function statuslineCommand(renderDeps: RenderRunDeps = {}): Command {
  const cmd = new Command("statusline").description(
    "Show in your agent's status bar whether Dosu is studying the current session",
  );

  cmd
    .command("status")
    .description("Show whether the Dosu status line is installed for each supported agent")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = allStatuslineAgents().map((agent) => {
        let enabled = false;
        let note: string | undefined;
        try {
          enabled = agent.isEnabled();
        } catch (err) {
          note = err instanceof Error ? err.message : String(err);
        }
        return {
          agent: agent.id(),
          name: agent.name(),
          installed: agent.isInstalled(),
          enabled,
          config_path: agent.configPath(),
          ...(note ? { note } : {}),
        };
      });

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
        if (row.note) console.log(pc.yellow(`    ${row.note}`));
      }
      console.log(
        pc.dim(
          "\nUse 'dosu knowledge statusline enable|disable [agent...]' to change these.\n" +
            `States: ${Object.values(STATUSLINE_LABELS).join("  ")}`,
        ),
      );
    });

  cmd
    .command("enable [agents...]")
    .description("Install the Dosu status line for agents (default: all detected)")
    .action((ids: string[]) => {
      const agents = resolveAgents(ids, allStatuslineAgents, getStatuslineAgent);
      if (agents.length > 0 && process.env.DOSU_DEV === "true") {
        console.log(
          pc.dim(`Dev mode: the status line will run ${installedCommand(agents[0].id())}`),
        );
      }
      for (const agent of agents) {
        try {
          agent.enable();
          console.log(`✓ ${agent.name()} \u00B7 status line enabled (${agent.configPath()})`);
        } catch (err) {
          if (err instanceof StatuslineConflictError) {
            // Not a failure: their line stays; tell them how to chain ours onto it.
            console.log(
              `– ${agent.name()} \u00B7 already has a status line (${err.existingCommand}); left as is.`,
            );
            console.log(pc.dim("  To show Dosu alongside it, add to your script:"));
            console.log(pc.dim(`    ${err.suggestion}`));
            continue;
          }
          reportFailure(agent.name(), err);
        }
      }
    });

  cmd
    .command("disable [agents...]")
    .description("Remove the Dosu status line from agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveAgents(ids, allStatuslineAgents, getStatuslineAgent)) {
        try {
          const removed = agent.disable();
          console.log(
            `✓ ${agent.name()} \u00B7 status line ${removed ? "disabled" : "was not ours; left as is"}`,
          );
        } catch (err) {
          reportFailure(agent.name(), err);
        }
      }
    });

  cmd
    .command("render")
    .description("Render the status line from the harness payload on stdin (installed command)")
    .requiredOption("--agent <id>", "Agent whose hook state to report (claude, cursor)")
    .action(async (opts: { agent: string }) => {
      await runStatuslineRender(opts.agent, renderDeps);
    });

  return cmd;
}

function reportFailure(agentName: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${agentName}: ${message}`));
  process.exitCode = 1;
}
