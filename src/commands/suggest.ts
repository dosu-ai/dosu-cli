/**
 * `dosu suggest` — AI document suggestions.
 */

import { Command } from "commander";
import pc from "picocolors";
import { listSpaceDataSourceIds } from "../client/supabase";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

async function getKnowledgeStoreId(client: TypedClient, spaceId: string): Promise<string> {
  const store = await client.knowledgeStore.getBySpaceId.query({
    space_id: spaceId,
  });
  if (!store) {
    console.error(pc.red("No knowledge store found for this deployment."));
    process.exit(1);
  }
  return store.id;
}

export function suggestCommand(): Command {
  const cmd = new Command("suggest").description("AI document suggestions");

  cmd
    .command("list")
    .description("List pending document suggestions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.active_account!.target!.space_id!);

      const suggestions = await client.suggestedDoc.listForKnowledgeStore.query({
        knowledgeStoreId: ksId,
      });

      if (opts.json) {
        printResult(suggestions, opts);
        return;
      }

      if (!suggestions || suggestions.length === 0) {
        console.log(pc.dim("No pending suggestions."));
        return;
      }

      printTable(
        ["ID", "Title"],
        suggestions.map((s: { id: string; title?: string }) => [
          s.id.slice(0, 8),
          s.title ?? "(untitled)",
        ]),
        { rawData: suggestions },
      );
    });

  cmd
    .command("generate")
    .description("Generate new document suggestions from data sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.active_account!.target!.space_id!);

      const dataSourceIds = await listSpaceDataSourceIds(
        cfg,
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        cfg.active_account!.target!.space_id!,
      );
      if (dataSourceIds.length === 0) {
        throw new Error("No data sources are connected to the active deployment.");
      }

      const result = await client.suggestedDoc.generate.mutate({
        knowledgeStoreId: ksId,
        dataSourceIds,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Document suggestions are being generated."));
    });

  cmd
    .command("reject")
    .description("Reject a suggestion")
    .argument("<id>", "Suggestion ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.suggestedDoc.delete.mutate({ id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Suggestion rejected."));
    });

  return cmd;
}
