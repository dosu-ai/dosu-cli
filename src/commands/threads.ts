/**
 * `dosu threads` — list, view, and manage conversation threads.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import type { ThreadListInput } from "../generated/dosu-api-types";
import { requireLoginConfig } from "./auth";
import { formatDate, printInfo, printResult, printTable, truncate } from "./output";

type ThreadListItem = {
  id: string;
  generated_title?: string | null;
  initial_message_title?: string | null;
  resolved?: boolean | null;
  inbox_archived_at?: string | null;
  created_at?: string | null;
};

type ThreadMessageGroup = {
  messages: Array<{
    author_role?: string | null;
    created_at?: string | null;
    body?: string | null;
  }>;
};

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function threadsCommand(): Command {
  const cmd = new Command("threads").description("List and manage conversation threads");

  cmd
    .command("list")
    .description("List threads")
    .option("--status <status>", "Filter by status: pending, resolved, archived")
    .option("--search <query>", "Search threads")
    .option("--limit <n>", "Maximum results (default: 20)", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: { status?: string; search?: string; limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const input: ThreadListInput = {
        __testing_scope__: undefined,
        active: undefined,
        archived: undefined,
        channels: undefined,
        chatOnly: undefined,
        confidenceLevels: undefined,
        inbox_archived: undefined,
        previewOnly: undefined,
        providers: undefined,
        read: undefined,
        resolved: undefined,
        search: undefined,
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        space_id: cfg.active_account!.target!.space_id!,
        workspaces: undefined,
        limit: Math.min(Number.parseInt(opts.limit ?? "20", 10), 100),
      };

      if (opts.search) input.search = opts.search;
      if (opts.status === "resolved") input.resolved = true;
      if (opts.status === "archived") {
        input.archived = true;
        input.inbox_archived = true;
      }
      if (opts.status === "pending") {
        input.resolved = false;
        input.archived = false;
        input.inbox_archived = false;
      }

      const data = await client.thread.list.query(input);
      const threads = data.list as ThreadListItem[];

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!threads || threads.length === 0) {
        console.log(pc.dim("No threads found."));
        return;
      }

      printTable(
        ["ID", "Title", "Status", "Created"],
        threads.map((t) => [
          t.id.slice(0, 8),
          truncate(t.generated_title ?? t.initial_message_title ?? "(no title)", 50),
          t.resolved ? "resolved" : t.inbox_archived_at ? "archived" : "pending",
          formatDate(t.created_at),
        ]),
        { rawData: threads },
      );
    });

  cmd
    .command("get")
    .description("View a thread and its messages")
    .argument("<id>", "Thread ID")
    .option("--limit <n>", "Number of messages to show (default: 20)", "20")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const [thread, messagesData] = await Promise.all([
        client.thread.get.query(id),
        client.messages.list.query({
          thread_id: id,
          limit: Number.parseInt(opts.limit ?? "20", 10),
        }),
      ]);

      if (opts.json) {
        printResult({ thread, messages: messagesData }, opts);
        return;
      }

      if (!thread) {
        console.log(pc.dim("Thread not found."));
        return;
      }

      console.log(pc.bold(thread.generated_title ?? "(untitled thread)"));
      printInfo([
        ["ID", thread.id],
        ["Created", formatDate(thread.created_at)],
        ["Status", thread.resolved ? "resolved" : "pending"],
        ["Channel", thread.channel],
      ]);

      const messages = messagesData.list as ThreadMessageGroup[] | undefined;
      if (messages && messages.length > 0) {
        // Flatten message groups into individual messages
        const allMessages = messages.flatMap((group) => group.messages);
        console.log(`\n${pc.bold("Messages")} (${allMessages.length})`);
        console.log(pc.dim("─".repeat(60)));
        for (const msg of allMessages) {
          const role = msg.author_role ?? "unknown";
          const date = formatDate(msg.created_at);
          console.log(`\n${pc.bold(role)} ${pc.dim(date)}`);
          if (msg.body) {
            console.log(truncate(msg.body, 500));
          }
        }
      }
    });

  cmd
    .command("archive")
    .description("Archive a thread")
    .argument("<id>", "Thread ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      await client.thread.archive.mutate({ threadId: id, archived: true });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }

      console.log(pc.green(`Thread ${id.slice(0, 8)} archived.`));
    });

  return cmd;
}
