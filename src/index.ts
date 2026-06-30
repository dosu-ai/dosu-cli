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
  // A masked server message (e.g. "[object Object]" from a stringified 422
  // detail) is useless on its own — surface the tRPC code/path/status if the
  // error carries them so the failure is at least diagnosable.
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
