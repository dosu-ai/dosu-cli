#!/usr/bin/env bun
/** Dosu CLI: capture coding-agent sessions. */

import { printFatalError } from "./cli/fatal-error";
import { isStatuslineRenderArgv } from "./statusline/argv";

// Ensure Ctrl+C always exits immediately, even when a prompt intercepts SIGINT and swallows it
// as a cancel symbol.
process.on("SIGINT", () => process.exit(0));

async function main(): Promise<void> {
  // Status-line renders fire every few hundred milliseconds from the harness; dispatch them
  // before loading Commander, telemetry, and the rest of the CLI.
  if (isStatuslineRenderArgv(process.argv)) {
    const { runStatuslineRenderFromArgv } = await import("./statusline/run");
    await runStatuslineRenderFromArgv();
    return;
  }
  const { execute } = await import("./cli/cli");
  await execute();
}

main().catch((err) => {
  printFatalError(err);
  process.exit(1);
});
