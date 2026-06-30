/**
 * `dosu review` — document review workflow.
 */

import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import type { RouterOutputs } from "@dosu/api-types";
import { isTRPCClientError } from "@trpc/client";
import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { formatDate, printInfo, printResult, printTable, truncate } from "./output";

// The server-rendered change view consumed by the approve/reject confirm-gate.
type ChangeView = RouterOutputs["review"]["getChange"];

function requireConfig() {
  return requireLoginConfig();
}

// Pinned to the published API enum so the case labels are checked against the real
// origin union (RouterOutputs derives it from `review.listPending`).
type ReviewOrigin = RouterOutputs["review"]["listPending"][number]["origin"];

// ponytail: mirrors _humanize_origin in dosu's backend/public_api/mcp/tools/review.py —
// keep in sync so the CLI, MCP tool, and dashboard show the same source labels.
function humanizeSource(origin: ReviewOrigin, version: number): string {
  switch (origin) {
    case "manual_update":
      return version <= 1 ? "User created" : "User updated";
    case "llm_generated":
      return "AI generated";
    case "sync_upstream":
      return "Synced from source";
    case "api_update":
      return "Created via API";
    default:
      return origin;
  }
}

// Colorize a unified diff so the preview reads like one. + green, - red, hunk headers dim.
function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return pc.dim(line);
    })
    .join("\n");
}

// Render the change view preview shown before an approve/reject confirmation.
function printChangePreview(change: ChangeView): void {
  printInfo([
    ["Title", change.title],
    ["Source", change.source],
    [
      "Version",
      change.isNewDoc
        ? `${change.version} (new)`
        : `${change.publishedVersion ?? "?"} → ${change.version}`,
    ],
  ]);
  if (!change.hasChanges) {
    console.log(pc.dim("No content changes."));
    return;
  }
  console.log();
  console.log(colorizeDiff(change.diff));
}

async function getKnowledgeStoreId(client: TypedClient, spaceId: string): Promise<string> {
  const store = await client.knowledgeStore.getBySpaceId.query({ space_id: spaceId });
  if (!store) {
    console.error(pc.red("No knowledge store found for this deployment."));
    process.exit(1);
  }
  return store.id;
}

export function reviewCommand(): Command {
  const cmd = new Command("review").description("Document review workflow");

  cmd
    .command("list")
    .description("List pending document review items")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      if (!cfg.space_id) {
        console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
        process.exit(1);
      }
      const client = createTypedClient(cfg);
      const ksId = await getKnowledgeStoreId(client, cfg.space_id);

      const items = await client.review.listPending.query({ knowledgeStoreId: ksId });

      if (opts.json) {
        printResult(items, opts);
        return;
      }

      if (!items || items.length === 0) {
        console.log(pc.dim("No pending review items."));
        return;
      }

      printTable(
        ["ID", "Kind", "Title", "Source", "Status", "Created"],
        items.map((i) => [
          i.id.slice(0, 8),
          i.kind,
          truncate(i.title ?? "(untitled)", 40),
          humanizeSource(i.origin, i.version),
          i.pendingStatus,
          formatDate(i.createdAt),
        ]),
        { rawData: items },
      );
    });

  cmd
    .command("diff")
    .description("Show the server-rendered diff for a pending document version")
    .argument("<page-version-id>", "Page version ID (from `dosu review list`)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      let change: RouterOutputs["review"]["getChange"];
      try {
        change = await client.review.getChange.query({ id });
      } catch (err) {
        if (
          isTRPCClientError(err) &&
          (err.data as { code?: string } | null)?.code === "NOT_FOUND"
        ) {
          console.error(
            pc.red(
              `No review item found for '${id}'. Run 'dosu review list' to see pending items.`,
            ),
          );
          process.exit(1);
        }
        throw err;
      }

      if (opts.json) {
        printResult(change, opts);
        return;
      }

      const versions =
        change.publishedVersion != null
          ? `v${change.publishedVersion} → v${change.version}`
          : `v${change.version}`;
      console.log(pc.bold(change.title));
      console.log(pc.dim(`${change.source} · ${versions}`));
      console.log("");
      // `diff` is fully rendered server-side: unified diff, new-doc body, or the
      // "(No textual changes…)" notice — distinguished by isNewDoc / hasChanges.
      console.log(change.diff);
    });

  // In-place edit of a pending version's body/title via page.updateReview
  // (PENDING_REVIEW-guarded server-side). After editing, `dosu review approve` publishes.
  cmd
    .command("edit")
    .description("Edit a pending document version's body/title in place")
    .argument("<page-version-id>", "Page version ID (from `dosu review list`)")
    .option("--title <title>", "New title")
    .option("--body <markdown>", "New body (markdown)")
    .option("--body-file <path>", "Read body from file")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        opts: { title?: string; body?: string; bodyFile?: string; json?: boolean },
      ) => {
        const cfg = requireConfig();
        const client = createTypedClient(cfg);

        const body = opts.bodyFile ? readFileSync(opts.bodyFile, "utf-8") : opts.body;
        if (body === undefined && opts.title === undefined) {
          console.error(pc.red("Nothing to edit. Pass --title and/or --body/--body-file."));
          process.exit(1);
        }

        await client.page.updateReview.mutate({
          page_version_id: id,
          title: opts.title,
          body,
        });

        if (opts.json) {
          printResult({ success: true, id }, opts);
          return;
        }
        console.log(pc.green(`Review edited: ${id.slice(0, 8)}`));
      },
    );

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

  // approve/reject mutate published content, so they're gated behind a diff
  // preview + explicit confirmation — mirroring the MCP tool's confirm-gated
  // accept/decline. `--confirm` (or an interactive y/N) is required to apply.
  const gated = [
    { name: "approve", action: "accept" as const, verb: "Approve" },
    { name: "reject", action: "decline" as const, verb: "Reject" },
  ];

  for (const { name, action, verb } of gated) {
    cmd
      .command(name)
      .description(`${verb} a document version (shows the diff, requires --confirm)`)
      .argument("<id>", "Review item ID (from `dosu review list`)")
      .option("--confirm", "Apply without the interactive prompt")
      .option("--json", "Output as JSON")
      .action(async (id: string, opts: { json?: boolean; confirm?: boolean }) => {
        const cfg = requireConfig();
        const client = createTypedClient(cfg);

        // For the only kind today (doc_change) the opaque id is the page version id.
        const change = await client.review.getChange.query({ id });
        if (!opts.json) printChangePreview(change);

        let proceed = opts.confirm === true;
        if (!proceed && !opts.json && process.stdin?.isTTY) {
          const answer = await p.confirm({
            message: `${verb} this change?`,
            initialValue: false,
          });
          if (p.isCancel(answer)) {
            console.log(pc.dim("Cancelled."));
            return;
          }
          proceed = answer === true;
        }

        if (!proceed) {
          if (opts.json) {
            printResult({ ...change, applied: false, confirmRequired: true }, opts);
          } else {
            console.log(pc.dim("Aborted. Re-run with --confirm to apply."));
          }
          return;
        }

        await client.page.updatePublicationStatus.mutate({
          page_version_id: id,
          action,
        });

        if (opts.json) {
          printResult({ success: true, id, action }, opts);
          return;
        }
        console.log(pc.green(`Review ${name}: ${id.slice(0, 8)}`));
      });
  }

  // revert just re-opens an item for review (non-destructive), so it stays ungated.
  cmd
    .command("revert")
    .description("Revert to pending review")
    .argument("<id>", "Review item ID (from `dosu review list`)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      await client.page.updatePublicationStatus.mutate({
        page_version_id: id,
        action: "revert_to_pending",
      });

      if (opts.json) {
        printResult({ success: true, id, action: "revert_to_pending" }, opts);
        return;
      }
      console.log(pc.green(`Review revert: ${id.slice(0, 8)}`));
    });

  return cmd;
}
