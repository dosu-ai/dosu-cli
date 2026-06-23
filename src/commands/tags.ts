/**
 * `dosu tags` — tag management for knowledge base.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.space_id) {
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

export function tagsCommand(): Command {
  const cmd = new Command("tags").description("Manage knowledge base tags");

  cmd
    .command("list")
    .description("List all tags")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.space_id!);

      const tags = await client.topic.listTopicsByKnowledgeStore.query({
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
        tags.map((t) => [t.topic_id.slice(0, 8), t.name, t.description ?? "—"]),
        { rawData: tags },
      );
    });

  cmd
    .command("remove")
    .description("Remove a tag from a page")
    .argument("<tag-id>", "Tag ID")
    .argument("<page-id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (tagId: string, pageId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.topic.removeFromPage.mutate({ topic_id: tagId, page_id: pageId });

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
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.space_id!);

      const result = await client.topic.getPagesByTopicId.query({
        knowledge_store_id: ksId,
        topic_id: tagId,
        searchTerm: opts.search,
        limit: Number.parseInt(opts.limit ?? "10", 10),
      });
      const pages = result.data;

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
        pages.map((p: { id: string; title?: string }) => [
          p.id.slice(0, 8),
          p.title ?? "(untitled)",
        ]),
        { rawData: pages },
      );
    });

  return cmd;
}
