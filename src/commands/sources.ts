/**
 * `dosu sources` — list and inspect connected data sources.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { formatDate, printInfo, printResult, printTable } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function sourcesCommand(): Command {
  const cmd = new Command("sources").description("Manage connected data sources");

  cmd
    .command("list")
    .description("List all connected data sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const dataSources = await client.dataSource.list.query({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        org_id: cfg.org_id!,
        excluded_provider_slugs: [],
      });

      if (opts.json) {
        printResult(dataSources, opts);
        return;
      }

      const list = (dataSources ?? []) as Array<{
        id: string;
        name: string;
        provider_slug?: string;
        created_at?: string;
      }>;
      if (list.length === 0) {
        console.log(pc.dim("No data sources connected."));
        return;
      }

      printTable(
        ["ID", "Name", "Provider", "Created"],
        list.map((ds) => [
          ds.id.slice(0, 8),
          ds.name ?? "(unnamed)",
          ds.provider_slug ?? "—",
          formatDate(ds.created_at),
        ]),
        { rawData: list },
      );
    });

  cmd
    .command("info")
    .description("Show details of a data source")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const ds = await client.dataSource.get.query(id);

      if (opts.json) {
        printResult(ds, opts);
        return;
      }

      if (!ds) {
        console.log(pc.dim("Data source not found."));
        return;
      }

      printInfo(
        [
          ["ID", ds.id],
          ["Name", ds.name],
          ["Description", ds.description],
          ["Provider", ds.provider_slug],
          ["Created", formatDate(ds.created_at)],
        ],
        { rawData: ds },
      );
    });

  cmd
    .command("sync")
    .description("Trigger a data source sync")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.dataSource.syncDataSource.mutate({ data_source_id: id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green(`Data source sync triggered for ${id.slice(0, 8)}.`));
    });

  cmd
    .command("update")
    .description("Update a data source")
    .argument("<id>", "Data source ID")
    .option("--name <name>", "New name")
    .option("--description <desc>", "New description")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { name?: string; description?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const result = await client.dataSource.update.mutate({
        data_source_id: id,
        name: opts.name,
        description: opts.description,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Data source updated."));
    });

  cmd
    .command("delete")
    .description("Delete a data source")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.dataSource.deleteDataSource.mutate(id);

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Data source deleted."));
    });

  return cmd;
}
