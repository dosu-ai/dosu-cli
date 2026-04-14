/**
 * `dosu threads` — list, view, and manage conversation threads.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { formatDate, printInfo, printResult, printTable, truncate } from "./output";

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

interface ThreadSummary {
  id: string;
  title?: string;
  preview?: string;
  created_at?: string;
  resolved_at?: string;
  inbox_archived_at?: string;
  channel?: string;
  provider?: string;
}

interface MessageSummary {
  id: string;
  body?: string;
  author_role?: string;
  created_at?: string;
  action?: string;
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
      const trpc = new TrpcClient(cfg);

      const input: Record<string, unknown> = {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        space_id: cfg.space_id!,
        limit: Math.min(Number.parseInt(opts.limit ?? "20", 10), 100),
      };

      if (opts.search) input.search = opts.search;
      if (opts.status === "resolved") input.resolved = true;
      if (opts.status === "archived") input.archived = true;
      if (opts.status === "pending") {
        input.resolved = false;
        input.archived = false;
      }

      const data = await trpc.query<ThreadSummary[]>("thread.list", input);

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!data || data.length === 0) {
        console.log(pc.dim("No threads found."));
        return;
      }

      printTable(
        ["ID", "Title", "Status", "Created"],
        data.map((t) => [
          t.id.slice(0, 8),
          truncate(t.title ?? t.preview ?? "(no title)", 50),
          t.resolved_at ? "resolved" : t.inbox_archived_at ? "archived" : "pending",
          formatDate(t.created_at),
        ]),
        { rawData: data },
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
      const trpc = new TrpcClient(cfg);

      const [thread, messages] = await Promise.all([
        trpc.query<ThreadSummary>("thread.get", { id }),
        trpc.query<MessageSummary[]>("messages.list", {
          thread_id: id,
          limit: Number.parseInt(opts.limit ?? "20", 10),
        }),
      ]);

      if (opts.json) {
        printResult({ thread, messages }, opts);
        return;
      }

      console.log(pc.bold(thread.title ?? "(untitled thread)"));
      printInfo([
        ["ID", thread.id],
        ["Created", formatDate(thread.created_at)],
        ["Status", thread.resolved_at ? "resolved" : "pending"],
        ["Channel", thread.channel],
      ]);

      if (messages && messages.length > 0) {
        console.log(`\n${pc.bold("Messages")} (${messages.length})`);
        console.log(pc.dim("─".repeat(60)));
        for (const msg of messages) {
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
      const trpc = new TrpcClient(cfg);

      await trpc.mutate("thread.archive", { id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }

      console.log(pc.green(`Thread ${id.slice(0, 8)} archived.`));
    });

  return cmd;
}
