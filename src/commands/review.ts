/**
 * `dosu review` — document review workflow.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printInfo, printResult } from "./output";

function requireConfig() {
  return requireLoginConfig();
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
      const client = createTypedClient(cfg);

      const context = await client.review.getThreadContext.query({
        thread_id: threadId,
      });

      if (opts.json) {
        printResult(context, opts);
        return;
      }

      // Context is a discriminated union — access fields safely
      const ctx = context as Record<string, unknown>;
      const reviewPage = ctx.reviewPage as { id: string; title?: string } | undefined;
      const publishedPage = ctx.publishedPage as { id: string; title?: string } | null | undefined;

      printInfo([
        ["Type", context.type],
        ["Page ID", ctx.pageId as string | undefined],
        ["Review Page", reviewPage?.title ?? reviewPage?.id],
        ["Published Page", publishedPage?.title ?? publishedPage?.id],
        ["Sync PR", (ctx.syncPrUrl as string | null) ?? undefined],
      ]);
    });

  const actions = [
    { name: "approve", action: "accept" as const, description: "Approve a document version" },
    { name: "reject", action: "decline" as const, description: "Reject a document version" },
    {
      name: "revert",
      action: "revert_to_pending" as const,
      description: "Revert to pending review",
    },
  ];

  for (const { name, action, description } of actions) {
    cmd
      .command(name)
      .description(description)
      .argument("<page-version-id>", "Page version ID")
      .option("--json", "Output as JSON")
      .action(async (pageVersionId: string, opts: { json?: boolean }) => {
        const cfg = requireConfig();
        const client = createTypedClient(cfg);

        await client.page.updatePublicationStatus.mutate({
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
