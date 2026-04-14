/**
 * `dosu review` — document review workflow.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { printInfo, printResult } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg;
}

interface ThreadContext {
  type: "messages" | "topic" | "document";
  pageId?: string;
  reviewPage?: { id: string; title?: string };
  publishedPage?: { id: string; title?: string } | null;
  previousVersion?: { version: number; body: string } | null;
  syncPrUrl?: string | null;
}

export function reviewCommand(): Command {
  const cmd = new Command("review").description("Document review workflow");

  cmd
    .command("context")
    .description("Get review context for a thread")
    .argument("<thread-id>", "Thread ID")
    .option("--json", "Output as JSON")
    .action(async (threadId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const context = await trpc.query<ThreadContext>("review.getThreadContext", {
        thread_id: threadId,
      });

      if (opts.json) {
        printResult(context, opts);
        return;
      }

      printInfo([
        ["Type", context.type],
        ["Page ID", context.pageId],
        ["Review Page", context.reviewPage?.title ?? context.reviewPage?.id],
        ["Published Page", context.publishedPage?.title ?? context.publishedPage?.id],
        ["Sync PR", context.syncPrUrl ?? undefined],
      ]);
    });

  for (const { name, action, description } of [
    { name: "approve", action: "accept", description: "Approve a document version" },
    { name: "reject", action: "decline", description: "Reject a document version" },
    { name: "revert", action: "revert_to_pending", description: "Revert to pending review" },
  ]) {
    cmd
      .command(name)
      .description(description)
      .argument("<page-version-id>", "Page version ID")
      .option("--json", "Output as JSON")
      .action(async (pageVersionId: string, opts: { json?: boolean }) => {
        const cfg = requireConfig();
        const trpc = new TrpcClient(cfg);

        await trpc.mutate("page.updatePublicationStatus", {
          page_version_id: pageVersionId,
          action,
        });

        if (opts.json) {
          printResult({ success: true, page_version_id: pageVersionId, action }, opts);
          return;
        }
        console.log(pc.green(`Review ${name}: ${pageVersionId.slice(0, 8)}`));
      });
  }

  return cmd;
}
