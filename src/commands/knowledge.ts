/**
 * `dosu knowledge` — knowledge base search and listing.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult, printTable, truncate } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.org_id || !cfg.space_id) {
    console.error(pc.red("Missing org/space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function knowledgeCommand(): Command {
  const cmd = new Command("knowledge").description("Search and browse your knowledge base");

  cmd
    .command("search")
    .description("Search the knowledge base")
    .argument("<query>", "Search query")
    .option("--json", "Output as JSON")
    .option("--limit <n>", "Maximum results", "10")
    .action(async (query: string, opts: { json?: boolean; limit?: string }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Get data source IDs for the org
      const dataSources = await client.dataSource.list.query({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        org_id: cfg.org_id!,
        excluded_provider_slugs: [],
      });

      const dataSourceIds = dataSources
        .map((ds) => ds.id)
        .filter((id): id is string => id !== null);
      if (dataSourceIds.length === 0) {
        console.log(pc.dim("No data sources connected. Add data sources in the Dosu dashboard."));
        return;
      }

      const data = await client.search.getMentions.query({
        query,
        dataSourceIds,
        entityTypes: [],
      });

      const results = data.documents;

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!results || results.length === 0) {
        console.log(pc.dim("No results found."));
        return;
      }

      const limit = Number.parseInt(opts.limit ?? "10", 10);
      const limited = results.slice(0, limit);

      printTable(
        ["Title", "Type"],
        limited.map((r: { title?: string | null; entity_type?: string | null }) => [
          truncate(r.title ?? "(untitled)", 60),
          r.entity_type ?? "—",
        ]),
        { json: false, rawData: limited },
      );

      if (results.length > limit) {
        console.log(pc.dim(`\n${results.length - limit} more results not shown.`));
      }
    });

  cmd
    .command("list")
    .description("Show knowledge store information")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const store = await client.knowledgeStore.getBySpaceId.query(
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        { space_id: cfg.space_id! },
      );

      if (opts.json) {
        printResult(store, opts);
        return;
      }

      if (!store) {
        console.log(pc.dim("No knowledge store found for this deployment."));
        return;
      }

      console.log(pc.bold("Knowledge Store"));
      console.log(`  ID:       ${store.id}`);
      console.log(`  Space ID: ${store.space_id}`);
    });

  return cmd;
}
