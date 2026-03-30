#!/usr/bin/env bun
/**
 * Dosu CLI — Manage MCP servers for AI tools
 */

import { execute } from "./cli/cli";

execute().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
