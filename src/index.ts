#!/usr/bin/env bun
/**
 * Dosu CLI — Manage MCP servers for AI tools
 */

import { execute } from "./cli/cli";

// Ensure Ctrl+C always exits immediately, even when @clack/prompts
// intercepts SIGINT and swallows it as a cancel symbol.
process.on("SIGINT", () => process.exit(0));

execute().catch((err) => {
  console.error(err.message ?? err);
  console.error(
    "\nRun `dosu logs --tail 30` for details, or re-run with `--debug` to stream debug logs.",
  );
  process.exit(1);
});
