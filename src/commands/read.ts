/**
 * `dosu read` — CLI shortcut for the MCP init_knowledge tool.
 *
 * Semantic search over the reviewed knowledge base. Returns results ranked
 * by relevance without the LLM source-selection pass (faster for CLI use).
 */

import { Command } from "commander";
import pc from "picocolors";
import { Client } from "../client/client";
import { loadConfig } from "../config/config";
import { logger } from "../debug/logger";
import { printResult, truncate } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.deployment_id) {
    console.error(pc.red("Missing deployment config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function readCommand(): Command {
  return new Command("read")
    .description("Retrieve relevant context from the knowledge base")
    .argument("[query]", "Optional search query")
    .option("--limit <n>", "Maximum results (default: 10)", "10")
    .option("--json", "Output as JSON")
    .action(async (query: string | undefined, opts: { limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const apiClient = new Client(cfg);
      const question = query ?? "What should I know before making changes?";

      logger.debug("read", `Searching: ${question}`);

      const resp = await apiClient.doRequest("POST", "/v1/knowledge/search", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        deployment_id: cfg.deployment_id!,
        query: question,
        top_k: Number.parseInt(opts.limit ?? "10", 10),
      });

      if (!resp.ok) {
        let detail = `Request failed with status ${resp.status}`;
        try {
          const body = await resp.json();
          const raw = body.detail ?? detail;
          detail = typeof raw === "string" ? raw : JSON.stringify(raw);
        } catch {}
        console.error(pc.red(`Error: ${detail}`));
        console.error(
          pc.dim("Run `dosu logs --tail 30` for details, or `dosu status` to check auth."),
        );
        process.exit(1);
      }

      const body = await resp.json();

      if (opts.json) {
        printResult(body, opts);
        return;
      }

      const results: { title: string; content: string; url?: string }[] = body.results ?? [];
      if (results.length === 0) {
        console.log(pc.dim("No results found."));
        return;
      }

      for (const r of results) {
        console.log(pc.bold(truncate(r.title, 80)));
        if (r.content) {
          console.log(pc.dim(truncate(r.content, 300)));
        }
        console.log();
      }
    });
}
