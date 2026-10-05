/** `dosu memory search|evidence`: Dosu memory's two MCP tools from a terminal, for people,
 * scripts, and agents without MCP. They go through the same relay as `dosu mcp serve`, so the
 * request carries the same project (from the cwd), branch, and client headers an MCP session in
 * this directory would, and prints what the agent would read. */

import { Command, Option } from "commander";
import pc from "picocolors";
import { loadConfig, MODE_OSS } from "../config/config";
import { callMcpTool, proxyRelay, type ToolResult, toolText } from "../mcp/proxy";
import { printResult } from "./output";

interface MemoryOptions {
  json?: boolean;
  client?: string;
}

function clientOption(): Option {
  return new Option(
    "--client <id>",
    "Agent to report as the caller (claude-code, codex, opencode, pi, ...)",
  );
}

function fail(message: string): void {
  console.error(pc.red(message));
  process.exitCode = 1;
}

/** Calls `tool` and prints its result: the text, or with --json the whole result. A tool error
 * exits 1 (its text on stderr without --json). */
async function runTool(tool: string, args: Record<string, unknown>, opts: MemoryOptions) {
  if (loadConfig().mode === MODE_OSS) {
    return fail("Dosu memory needs a Dosu Cloud deployment; OSS mode serves public libraries.");
  }
  let result: ToolResult;
  try {
    result = await callMcpTool(proxyRelay({ client: opts.client }), tool, args);
  } catch (err) {
    // Not set up, or the request failed: the message says which, and what to do.
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (opts.json) {
    printResult(result, opts);
    if (result.isError) process.exitCode = 1;
    return;
  }
  if (result.isError) return fail(toolText(result) || `${tool} failed.`);
  console.log(toolText(result));
}

export function memoryCommand(): Command {
  const cmd = new Command("memory").description(
    "Search Dosu memory, learned from earlier agent sessions, as an agent's MCP tools do",
  );

  cmd
    .command("search")
    .description("Search memory for lessons and runbooks relevant to a task (search_memory)")
    .argument("<query>", "What you are trying to do or learn")
    .option("--json", "Output the tool result as JSON")
    .addOption(clientOption())
    .action((query: string, opts: MemoryOptions) => runTool("search_memory", { query }, opts));

  cmd
    .command("evidence")
    .description("Show the transcript excerpts behind one memory (get_memory_evidence)")
    .argument("<memory-id>", "A memory id from search results or a Task Memory digest")
    .option("--json", "Output the tool result as JSON")
    .addOption(clientOption())
    .action((memoryId: string, opts: MemoryOptions) =>
      runTool("get_memory_evidence", { memory_id: memoryId }, opts),
    );

  return cmd;
}
