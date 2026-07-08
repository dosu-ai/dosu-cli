/**
 * `dosu topics` — browse Topics in your knowledge base (read-only).
 *
 * Topics are fully managed by Dosu (assigned during indexing); the CLI can
 * list them and the pages under each, but cannot create, edit, or remove them.
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

export function topicsCommand(): Command {
  // `tags` kept as a hidden alias for back-compat with the pre-rename CLI.
  const cmd = new Command("topics")
    .alias("tags")
    .description("Browse Topics in your knowledge base");

  cmd
    .command("list")
    .description("List all topics")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.space_id!);

      const topics = await client.topic.listTopicsByKnowledgeStore.query({
        knowledge_store_id: ksId,
      });

      if (opts.json) {
        printResult(topics, opts);
        return;
      }

      if (!topics || topics.length === 0) {
        console.log(pc.dim("No topics found."));
        return;
      }

      printTable(
        ["ID", "Name", "Description"],
        topics.map((t: { topic_id: string; name: string; description?: string | null }) => [
          t.topic_id.slice(0, 8),
          t.name,
          t.description ?? "—",
        ]),
        { rawData: topics },
      );
    });

  cmd
    .command("pages")
    .description("List pages with a specific topic")
    .argument("<topic-id>", "Topic ID")
    .option("--search <query>", "Search within the topic's pages")
    .option("--limit <n>", "Maximum results", "10")
    .option("--json", "Output as JSON")
    .action(async (topicId: string, opts: { search?: string; limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(client, cfg.space_id!);

      const result = await client.topic.getPagesByTopicId.query({
        knowledge_store_id: ksId,
        topic_id: topicId,
        searchTerm: opts.search,
        limit: Number.parseInt(opts.limit ?? "10", 10),
      });
      const pages = result.data;

      if (opts.json) {
        printResult(pages, opts);
        return;
      }

      if (!pages || pages.length === 0) {
        console.log(pc.dim("No pages found with this topic."));
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
