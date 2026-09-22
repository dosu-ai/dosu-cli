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
