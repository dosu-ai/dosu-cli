/** `dosu memory`: agent memory for Claude Code. Hooks record each session incrementally and inject
 * a note from earlier sessions in the same repository on a session's first prompt. Independent of
 * `dosu knowledge` and its hooks. */

import { Command } from "commander";
import { syncSession } from "../memory/sync";
import { printResult } from "./output";

export function memoryCommand(): Command {
  const cmd = new Command("memory").description(
    "Agent memory for Claude Code: record sessions, recall notes from earlier ones",
  );

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

  return cmd;
}
