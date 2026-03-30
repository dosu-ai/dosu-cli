#!/usr/bin/env bun
/**
 * Dosu CLI — Manage MCP servers for AI tools
 *
 * Migrated from Go to Bun/TypeScript.
 */

import { execute } from "./cli/cli";

execute().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
