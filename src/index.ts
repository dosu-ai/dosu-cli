#!/usr/bin/env bun
/** Dosu CLI: manage MCP servers for AI tools. */

import { isStatuslineRenderArgv } from "./statusline/argv";

// Ensure Ctrl+C always exits immediately, even when @clack/prompts
// intercepts SIGINT and swallows it as a cancel symbol.
process.on("SIGINT", () => process.exit(0));

async function main(): Promise<void> {
  // Status-line renders fire every few hundred milliseconds from the harness; dispatch them
  // before loading Commander, telemetry, and the rest of the CLI.
  if (isStatuslineRenderArgv(process.argv)) {
    const { runStatuslineRenderFromArgv } = await import("./statusline/run");
    await runStatuslineRenderFromArgv();
    return;
  }
  // The agent-memory hook runs on every tool call (PostToolUse) and must not wait on the update
  // check or send telemetry; it skips Commander for the same reason.
  if (process.argv[2] === "memory" && process.argv[3] === "hook") {
    const { runMemoryHookCommand } = await import("./memory/hook");
    await runMemoryHookCommand();
    return;
  }
  // So does stage two's poller, which the first prompt's hook spawns: the session waits for the
  // note of the job it starts, and the update check would hold up that start.
  if (
    process.argv[2] === "memory" &&
    process.argv[3] === "recall-poll" &&
    process.argv[4] === "--session" &&
    process.argv.length === 6
  ) {
    const { pollFullRecall } = await import("./memory/two-stage");
    await pollFullRecall(process.argv[5]);
    return;
  }
  const { execute } = await import("./cli/cli");
  await execute();
}

main().catch((err) => {
  console.error(err.message ?? err);
  // Surface the tRPC code/path/status when present so masked server messages
  // (e.g. "[object Object]") stay diagnosable.
  const data = err?.data;
  if (data && (data.code || data.path || data.httpStatus)) {
    const parts = [
      data.code && `code=${data.code}`,
      data.path && `path=${data.path}`,
      data.httpStatus && `status=${data.httpStatus}`,
    ].filter(Boolean);
    console.error(parts.join(" "));
  }
  process.exit(1);
});
