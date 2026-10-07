/** `dosu memory`: agent memory for Claude Code, Codex, and Cursor. Hooks record each session
 * incrementally and inject a note from earlier sessions in the same repository on a session's first
 * prompt (on Cursor, before its first tool call). Independent of `dosu knowledge` and its hooks. */

import { Command, Option } from "commander";
import pc from "picocolors";
import { dosuOnPath, HookConfigError } from "../hooks/formats";
import { runMemoryHookCommand } from "../memory/hook";
import {
  disableMemoryHooks,
  enableMemoryHooks,
  memoryHookStatus,
  memoryHooksTarget,
} from "../memory/install";
import { MEMORY_AGENTS, type MemoryAgent } from "../memory/state";
import { flushAfterExit, syncSession } from "../memory/sync";
import { pollFullRecall } from "../memory/two-stage";
import { printResult } from "./output";

const agentOption = () =>
  new Option("--agent <agent>", "Coding agent").choices(MEMORY_AGENTS).default("claude-code");

function hooksCommand(): Command {
  const cmd = new Command("hooks").description(
    "Manage the agent-memory hooks in Claude Code, Codex, or Cursor",
  );

  cmd
    .command("status")
    .description("Show which of the agent's events have the memory hook")
    .addOption(agentOption())
    .option("--json", "Output as JSON")
    .action((opts: { agent: MemoryAgent; json?: boolean }) => {
      const status = {
        settings: memoryHooksTarget(opts.agent).configPath,
        events: memoryHookStatus(opts.agent),
      };
      if (opts.json) {
        printResult(status, opts);
        return;
      }
      for (const [event, enabled] of Object.entries(status.events)) {
        console.log(`  ${event.padEnd(28)} ${enabled ? pc.green("enabled") : "disabled"}`);
      }
      console.log(pc.dim(`\n${status.settings}`));
    });

  cmd
    .command("enable")
    .description("Install the memory hooks (`status` lists them)")
    .addOption(agentOption())
    .action((opts: { agent: MemoryAgent }) => {
      // Dev hooks pin this working copy by absolute path, so PATH is moot.
      if (process.env.DOSU_DEV !== "true" && !dosuOnPath()) {
        console.log(
          pc.yellow(
            "Warning: 'dosu' is not on PATH; hooks run 'dosu memory hook' and will fail until it is.",
          ),
        );
      }
      changeHooks(opts.agent, enableMemoryHooks, "enabled");
    });

  cmd
    .command("disable")
    .description("Remove the memory hooks")
    .addOption(agentOption())
    .action((opts: { agent: MemoryAgent }) => {
      const moved = changeHooks(opts.agent, disableMemoryHooks, "disabled");
      if (moved) {
        console.log(
          pc.yellow(
            `  ${moved} other hook${moved === 1 ? "" : "s"} moved within their group; ` +
              "Codex skips them until you trust them again in /hooks.",
          ),
        );
      }
    });

  return cmd;
}

function changeHooks<T>(
  agent: MemoryAgent,
  change: (agent: MemoryAgent) => T,
  verb: string,
): T | undefined {
  const { name, configPath, enableNote } = memoryHooksTarget(agent);
  try {
    const result = change(agent);
    console.log(`✓ ${name} · memory hooks ${verb} (${configPath})`);
    if (verb === "enabled" && enableNote) console.log(pc.dim(`  ${enableNote}`));
    return result;
  } catch (err) {
    const message =
      err instanceof HookConfigError || err instanceof Error ? err.message : String(err);
    console.error(pc.red(`✗ ${name}: ${message}`));
    process.exitCode = 1;
  }
}

export function memoryCommand(): Command {
  const cmd = new Command("memory").description(
    "Agent memory for Claude Code, Codex, and Cursor: record sessions, recall notes from earlier ones",
  );

  cmd
    .command("hook", { hidden: true })
    .description("Agent hook entry point; reads the hook payload on stdin")
    .addOption(agentOption())
    .option("--stage-two", "Codex's background prompt hook: wait for stage two and print it")
    .action((opts: { agent: MemoryAgent; stageTwo?: boolean }) =>
      runMemoryHookCommand({ agent: opts.agent, stageTwo: opts.stageTwo }),
    );

  cmd
    .command("recall-poll", { hidden: true })
    .description("Start a session's task-specific note, wait for it, and save it for the hooks")
    .requiredOption("--session <id>", "Agent session id")
    .action(async (opts: { session: string }) => {
      await pollFullRecall(opts.session);
    });

  cmd
    .command("flush-on-exit", { hidden: true })
    .description("Wait for the agent's process to exit, then sync and flush unless already flushed")
    .requiredOption("--session <id>", "Agent session id")
    .requiredOption("--pid <pid>", "Agent process id", (value) => Number.parseInt(value, 10))
    .action(async (opts: { session: string; pid: number }) => {
      const result = await flushAfterExit(opts.session, opts.pid);
      if (result.status === "failed") process.exitCode = 1;
    });

  cmd
    .command("sync")
    .description("Upload what an agent session added since the last sync")
    .requiredOption("--session <id>", "Agent session id")
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
