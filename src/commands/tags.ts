/**
 * `dosu tags` — tag management for knowledge base.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

async function getKnowledgeStoreId(trpc: TrpcClient, spaceId: string): Promise<string> {
  const store = await trpc.query<{ id: string } | null>("knowledgeStore.getBySpaceId", {
    space_id: spaceId,
  });
  if (!store) {
    console.error(pc.red("No knowledge store found for this deployment."));
    process.exit(1);
  }
  return store.id;
}

export function tagsCommand(): Command {
  const cmd = new Command("tags").description("Manage knowledge base tags");

  cmd
    .command("list")
    .description("List all tags")
    .option("--search <query>", "Search tags by name")
    .option("--json", "Output as JSON")
    .action(async (opts: { search?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const tags = opts.search
        ? await trpc.query<unknown[]>("tag.listKnowledgeStoreTagsWithPagination", {
            knowledge_store_id: ksId,
            searchTerm: opts.search,
          })
        : await trpc.query<unknown[]>("tag.listKnowledgeStoreTags", {
            knowledge_store_id: ksId,
          });

      if (opts.json) {
        printResult(tags, opts);
        return;
      }

      if (!tags || tags.length === 0) {
        console.log(pc.dim("No tags found."));
        return;
      }

      printTable(
        ["ID", "Name", "Description"],
        (tags as Array<{ id: string; name: string; description?: string }>).map((t) => [
          t.id.slice(0, 8),
          t.name,
          t.description ?? "—",
        ]),
        { rawData: tags },
      );
    });

  cmd
    .command("create")
    .description("Create a new tag")
    .requiredOption("--name <name>", "Tag name")
    .option("--description <desc>", "Tag description")
    .option("--json", "Output as JSON")
    .action(async (opts: { name: string; description?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const result = await trpc.mutate("tag.create", {
        knowledge_store_id: ksId,
        name: opts.name,
        description: opts.description ?? "",
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green(`Tag "${opts.name}" created.`));
    });

  cmd
    .command("update")
    .description("Update a tag")
    .argument("<id>", "Tag ID")
    .requiredOption("--name <name>", "New tag name")
    .option("--description <desc>", "New description")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { name: string; description?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const result = await trpc.mutate("tag.update", {
        id,
        knowledge_store_id: ksId,
        name: opts.name,
        description: opts.description,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green(`Tag updated.`));
    });

  cmd
    .command("delete")
    .description("Delete a tag")
    .argument("<id>", "Tag ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("tag.delete", { id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Tag deleted."));
    });

  cmd
    .command("add")
    .description("Add a tag to a page")
    .argument("<tag-id>", "Tag ID")
    .argument("<page-id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (tagId: string, pageId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("tag.addToPage", { tag_id: tagId, page_id: pageId });

      if (opts.json) {
        printResult({ success: true, tag_id: tagId, page_id: pageId }, opts);
        return;
      }
      console.log(pc.green("Tag added to page."));
    });

  cmd
    .command("remove")
    .description("Remove a tag from a page")
    .argument("<tag-id>", "Tag ID")
    .argument("<page-id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (tagId: string, pageId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("tag.removeFromPage", { tag_id: tagId, page_id: pageId });

      if (opts.json) {
        printResult({ success: true, tag_id: tagId, page_id: pageId }, opts);
        return;
      }
      console.log(pc.green("Tag removed from page."));
    });

  cmd
    .command("pages")
    .description("List pages with a specific tag")
    .argument("<tag-id>", "Tag ID")
    .option("--search <query>", "Search within tagged pages")
    .option("--limit <n>", "Maximum results", "10")
    .option("--json", "Output as JSON")
    .action(async (tagId: string, opts: { search?: string; limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const pages = await trpc.query<Array<{ id: string; title?: string; created_at?: string }>>(
        "tag.getPagesByTagId",
        {
          knowledge_store_id: ksId,
          tag_id: tagId,
          searchTerm: opts.search,
          limit: Number.parseInt(opts.limit ?? "10", 10),
        },
      );

      if (opts.json) {
        printResult(pages, opts);
        return;
      }

      if (!pages || pages.length === 0) {
        console.log(pc.dim("No pages found with this tag."));
        return;
      }

      printTable(
        ["ID", "Title"],
        pages.map((p) => [p.id.slice(0, 8), p.title ?? "(untitled)"]),
        { rawData: pages },
      );
    });

  return cmd;
}
