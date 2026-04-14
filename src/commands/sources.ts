/**
 * `dosu sources` — list and inspect connected data sources.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { formatDate, printInfo, printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

interface DataSource {
  id: string;
  name: string;
  description?: string;
  provider_slug?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function sourcesCommand(): Command {
  const cmd = new Command("sources").description("Manage connected data sources");

  cmd
    .command("list")
    .description("List all connected data sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const dataSources = await trpc.query<DataSource[]>(
        "dataSource.list",
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        { org_id: cfg.org_id! },
      );

      if (opts.json) {
        printResult(dataSources, opts);
        return;
      }

      if (!dataSources || dataSources.length === 0) {
        console.log(pc.dim("No data sources connected."));
        return;
      }

      printTable(
        ["ID", "Name", "Provider", "Created"],
        dataSources.map((ds) => [
          ds.id.slice(0, 8),
          ds.name ?? "(unnamed)",
          ds.provider_slug ?? "—",
          formatDate(ds.created_at),
        ]),
        { rawData: dataSources },
      );
    });

  cmd
    .command("info")
    .description("Show details of a data source")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const ds = await trpc.query<DataSource>("dataSource.get", { id });

      if (opts.json) {
        printResult(ds, opts);
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
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("dataSource.syncDataSource", { dataSourceId: id });

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
      const trpc = new TrpcClient(cfg);

      const result = await trpc.mutate("dataSource.update", {
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
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("dataSource.deleteDataSource", { data_source_id: id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Data source deleted."));
    });

  return cmd;
}
