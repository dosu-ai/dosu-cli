/**
 * `dosu write` — CLI shortcut for the MCP save_topic tool.
 *
 * Saves a candidate topic to the knowledge base. The candidate enters
 * Dosu's server-side review pipeline before being published and indexed
 * for semantic search.
 */

import { Command } from "commander";
import pc from "picocolors";
import { Client } from "../client/client";
import { loadConfig } from "../config/config";
import { logger } from "../debug/logger";
import { printResult } from "./output";

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

export function writeCommand(): Command {
  return new Command("write")
    .description("Save a fact or insight to the knowledge base")
    .argument("<fact>", "The fact or insight to save")
    .option("--json", "Output as JSON")
    .action(async (fact: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const apiClient = new Client(cfg);

      logger.debug("write", `Saving topic: ${fact.slice(0, 60)}`);

      const resp = await apiClient.doRequest("POST", "/v1/topics", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        deployment_id: cfg.deployment_id!,
        name: fact.trim().split(/\s+/).slice(0, 8).join(" "),
        context: fact,
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

      if (opts.json) {
        const body = await resp.json();
        printResult(body, opts);
        return;
      }

      const deployment = cfg.deployment_name ?? "Dosu";
      console.log(pc.green(`Saved to ${deployment}`));
    });
}
