/** `dosu memory`: agent memory for Claude Code. Hooks record each session incrementally and inject
 * a note from earlier sessions in the same repository on a session's first prompt. Independent of
 * `dosu knowledge` and its hooks. */

import { Command } from "commander";
import pc from "picocolors";
import { HookConfigError } from "../hooks/formats";
import { runMemoryHookCommand } from "../memory/hook";
import {
  claudeSettingsPath,
  disableMemoryHooks,
  enableMemoryHooks,
  memoryHookStatus,
} from "../memory/install";
import { syncSession } from "../memory/sync";
import { pollFullRecall } from "../memory/two-stage";
import { printResult } from "./output";

function hooksCommand(): Command {
  const cmd = new Command("hooks").description("Manage the agent-memory hooks in Claude Code");

  cmd
    .command("status")
    .description("Show which Claude Code events have the memory hook")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const status = { settings: claudeSettingsPath(), events: memoryHookStatus() };
      if (opts.json) {
        printResult(status, opts);
        return;
      }
      for (const [event, enabled] of Object.entries(status.events)) {
        console.log(`  ${event.padEnd(17)} ${enabled ? pc.green("enabled") : "disabled"}`);
      }
      console.log(pc.dim(`\n${status.settings}`));
    });

  cmd
    .command("enable")
    .description(
      "Install the memory hooks (SessionStart, UserPromptSubmit, PostToolBatch, Stop, SessionEnd)",
    )
    .action(() => {
      changeHooks(enableMemoryHooks, "enabled");
    });

  cmd
    .command("disable")
    .description("Remove the memory hooks")
    .action(() => {
      changeHooks(disableMemoryHooks, "disabled");
    });

  return cmd;
}

function changeHooks(change: () => void, verb: string): void {
  try {
    change();
    console.log(`✓ Claude Code · memory hooks ${verb} (${claudeSettingsPath()})`);
  } catch (err) {
    const message =
      err instanceof HookConfigError || err instanceof Error ? err.message : String(err);
    console.error(pc.red(`✗ Claude Code: ${message}`));
    process.exitCode = 1;
  }
}

export function memoryCommand(): Command {
  const cmd = new Command("memory").description(
    "Agent memory for Claude Code: record sessions, recall notes from earlier ones",
  );

  cmd
    .command("hook", { hidden: true })
    .description("Claude Code hook entry point; reads the hook payload on stdin")
    .action(runMemoryHookCommand);

  cmd
    .command("recall-poll", { hidden: true })
    .description("Wait for a session's task-specific note and save it for the hooks to inject")
    .requiredOption("--session <id>", "Claude Code session id")
    .action(async (opts: { session: string }) => {
      await pollFullRecall(opts.session);
    });

  cmd
    .command("sync")
    .description("Upload what a Claude Code session added since the last sync")
    .requiredOption("--session <id>", "Claude Code session id")
    .option("--flush", "Then mark the session's episode ready for processing")
    .option("--json", "Output as JSON")
    .action(async (opts: { session: string; flush?: boolean; json?: boolean }) => {
      const result = await syncSession(opts.session, { flush: opts.flush });
      if (result.status === "failed") process.exitCode = 1;
      if (opts.json) {
        printResult(result, opts);
        return;
      }
      const detail = result.error ? `: ${result.error}` : "";
      console.log(
        `${result.status} · ${result.chunks} chunk${result.chunks === 1 ? "" : "s"}` +
          `${result.flushed ? " · flushed" : ""}${detail}`,
      );
    });

  cmd.addCommand(hooksCommand());
  return cmd;
}
