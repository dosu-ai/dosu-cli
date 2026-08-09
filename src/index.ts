#!/usr/bin/env bun
/**
 * Dosu CLI — Manage MCP servers for AI tools
 */

import { execute } from "./cli/cli";
import {
  CLI_SIGNALS,
  dispatchCliSignal,
  installsImmediateSigintHandler,
} from "./cli/signal-policy";

// Ordinary prompt cancellation remains immediate. Short-lived guarded work
// (currently the project MCP preflight) can delay exit only until its detached
// process tree has been shut down.
if (installsImmediateSigintHandler(process.argv)) {
  for (const signal of CLI_SIGNALS) {
    process.on(signal, () => {
      void dispatchCliSignal(signal);
    });
  }
}

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
