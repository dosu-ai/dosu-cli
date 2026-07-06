/**
 * `dosu review` — review workflow for pending doc changes and draft replies.
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

// The raw message row behind a draft id (used to preview a draft in the gate).
type DraftMessageRow = NonNullable<RouterOutputs["messages"]["getMessage"]>;

function requireConfig() {
  return requireLoginConfig();
}

function isNotFound(err: unknown): boolean {
  return isTRPCClientError(err) && (err.data as { code?: string } | null)?.code === "NOT_FOUND";
}

// Prefix on draft-message review-item ids from `review.listPending` (ENG-547,
// dosu-ai/dosu#11451). Mirror of DRAFT_MESSAGE_ID_PREFIX in dosu's
// frontend/packages/api/src/routers/review.ts and DRAFT_MESSAGE_PREFIX in
// backend/public_api/mcp/tools/review.py — keep all three in sync. Prefixing makes
// the opaque id identical across MCP and tRPC/CLI so the same token is portable.
const DRAFT_MESSAGE_ID_PREFIX = "draft_message:";

// Route an opaque review-item id to its kind, mirroring the MCP tool's
// `_parse_item_id`: a prefixed id is a draft_message, a bare id is a doc_change
// page-version UUID. We dispatch on the prefix rather than probing review.getChange
// (the old ENG-524 approach) because the change-view endpoint types its id as a UUID
// and now 422s — not 404s — on a prefixed id, so a 404-probe can no longer route drafts.
function isDraftId(id: string): boolean {
  return id.startsWith(DRAFT_MESSAGE_ID_PREFIX);
}

// Strip the draft prefix to recover the bare message UUID the `messages.*`
// procedures expect (they're otherwise called by the web with bare, web-controlled
// ids). Only called on ids already confirmed as drafts by isDraftId, so the prefix
// is always present.
function bareMessageId(id: string): string {
  return id.slice(DRAFT_MESSAGE_ID_PREFIX.length);
}

// Fetch the doc-change view for a bare page-version id, or exit with a clear
// message if it's unknown/inaccessible (getChange 404s). Non-404s propagate.
async function requireChange(client: TypedClient, id: string): Promise<ChangeView> {
  try {
    return await client.review.getChange.query({ id });
  } catch (err) {
    if (isNotFound(err)) {
      console.error(
        pc.red(`No review item found for '${id}'. Run 'dosu review list' to see pending items.`),
      );
      process.exit(1);
    }
    throw err;
  }
}

// Fetch the message row behind a draft id, or exit with a clear message if missing.
// `messages.getMessage` wants the bare UUID, so strip the prefix for the lookup while
// still echoing the id the user passed in any error.
async function requireDraft(client: TypedClient, id: string): Promise<DraftMessageRow> {
  const draft = await client.messages.getMessage.query(bareMessageId(id));
  if (!draft) {
    console.error(
      pc.red(`No review item found for '${id}'. Run 'dosu review list' to see pending items.`),
    );
    process.exit(1);
  }
  return draft;
}

// Pinned to the published API enum so the case labels are checked against the real
// origin union (RouterOutputs derives it from `review.listPending`).
// `origin` is unique to the doc-change member of the listPending union (drafts
// have none), so extract on its presence rather than on `kind` — the doc member's
// kind is the broad ReviewItemKind, not a literal, so a kind-extract yields never.
type ReviewOrigin = Extract<
  RouterOutputs["review"]["listPending"][number],
  { origin: string }
>["origin"];

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

// A draft reply has no published baseline to diff against — preview is title + body.
function printDraftPreview(draft: DraftMessageRow): void {
  printInfo([
    ["Title", draft.title ?? "(untitled)"],
    ["Source", "Draft reply"],
  ]);
  console.log();
  console.log(draft.body ?? "");
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
  const cmd = new Command("review").description("Review workflow (doc changes and draft replies)");

  cmd
    .command("list")
    .description("List pending review items (doc changes and draft replies)")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      if (!cfg.space_id) {
        console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
        process.exit(1);
      }
      const client = createTypedClient(cfg);
      const ksId = await getKnowledgeStoreId(client, cfg.space_id);

      // Docs are knowledge-store-scoped; drafts are deployment-scoped. Passing
      // deploymentId merges draft replies into the list (ENG-524) — omit it and
      // the server returns doc changes only.
      const items = await client.review.listPending.query({
        knowledgeStoreId: ksId,
        deploymentId: cfg.deployment_id,
      });

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
        items.map((i) =>
          i.kind === "draft_message"
            ? [
                i.id,
                i.kind,
                truncate(i.title || "(untitled)", 40),
                "Draft reply",
                "draft",
                formatDate(i.createdAt),
              ]
            : [
                i.id,
                i.kind,
                truncate(i.title ?? "(untitled)", 40),
                humanizeSource(i.origin, i.version),
                i.pendingStatus,
                formatDate(i.createdAt),
              ],
        ),
        { rawData: items },
      );
    });

  cmd
    .command("diff")
    .description("Show a pending review item (doc-change diff or draft reply body)")
    .argument("<id>", "Review item ID (from `dosu review list`)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Route by the opaque id's prefix: a draft renders its body, a doc renders a diff.
      if (isDraftId(id)) {
        const draft = await requireDraft(client, id);
        if (opts.json) {
          printResult({ id, kind: "draft_message", title: draft.title, body: draft.body }, opts);
          return;
        }
        console.log(pc.bold(draft.title ?? "(untitled)"));
        console.log(pc.dim("Draft reply"));
        console.log("");
        console.log(draft.body ?? "");
        return;
      }

      const change = await requireChange(client, id);
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

  // In-place edit of a pending review item. doc changes go through page.updateReview
  // (PENDING_REVIEW-guarded); draft replies save a new draft revision via
  // message.saveDraft (body only). After editing, `dosu review approve` publishes.
  cmd
    .command("edit")
    .description("Edit a pending review item in place (doc body/title, or draft reply body)")
    .argument("<id>", "Review item ID (from `dosu review list`)")
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

        if (opts.body !== undefined && opts.bodyFile !== undefined) {
          console.error(pc.red("Pass only one of --body or --body-file."));
          process.exit(1);
        }

        let body: string | undefined = opts.body;
        if (opts.bodyFile) {
          try {
            body = readFileSync(opts.bodyFile, "utf-8");
          } catch (err) {
            console.error(pc.red(`Failed to read --body-file: ${(err as Error).message}`));
            process.exit(1);
          }
        }

        if (body === undefined && opts.title === undefined) {
          console.error(pc.red("Nothing to edit. Pass --title and/or --body/--body-file."));
          process.exit(1);
        }

        // Route by prefix: a draft saves a new revision (body only), a doc edits in place.
        if (isDraftId(id)) {
          // saveDraft takes body only; --title is doc-only. (Past the generic
          // "nothing to edit" check above, body is guaranteed set when title isn't.)
          if (opts.title !== undefined) {
            console.error(pc.red("Draft replies support --body only (no --title)."));
            process.exit(1);
          }
          await requireDraft(client, id);
          await client.messages.saveDraft.mutate({
            messageId: bareMessageId(id),
            body: body as string,
          });
        } else {
          try {
            await client.page.updateReview.mutate({
              page_version_id: id,
              title: opts.title,
              body,
            });
          } catch (err) {
            if (isNotFound(err)) {
              console.error(
                pc.red(
                  `No pending review item found for '${id}'. Run 'dosu review list' to see editable items.`,
                ),
              );
              process.exit(1);
            }
            throw err;
          }
        }

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
      .description(
        `${verb} a review item (doc change or draft reply; shows a preview, requires --confirm)`,
      )
      .argument("<id>", "Review item ID (from `dosu review list`)")
      .option("--confirm", "Apply without the interactive prompt")
      .option("--json", "Output as JSON")
      .action(async (id: string, opts: { json?: boolean; confirm?: boolean }) => {
        const cfg = requireConfig();
        const client = createTypedClient(cfg);

        // Route by the opaque id's prefix: a doc resolves its diff via getChange;
        // a draft previews its stored body instead (ENG-524 / ENG-547).
        const change = isDraftId(id) ? null : await requireChange(client, id);
        const draft = change ? null : await requireDraft(client, id);
        const noun = change ? "change" : "draft reply";

        if (!opts.json) {
          if (change) printChangePreview(change);
          else printDraftPreview(draft as DraftMessageRow);
        }

        let proceed = opts.confirm === true;
        if (!proceed && !opts.json && process.stdin?.isTTY) {
          const answer = await p.confirm({
            message: `${verb} this ${noun}?`,
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
            const preview = change ?? {
              id,
              kind: "draft_message",
              title: draft?.title,
              body: draft?.body,
            };
            printResult({ ...preview, applied: false, confirmRequired: true }, opts);
          } else {
            console.log(pc.dim("Aborted. Re-run with --confirm to apply."));
          }
          return;
        }

        if (change) {
          await client.page.updatePublicationStatus.mutate({ page_version_id: id, action });
        } else if (action === "accept") {
          // Publish the draft (latest stored body) to its originating thread.
          await client.messages.publishMessage.mutate({ postId: bareMessageId(id) });
        } else {
          // Reject = discard the draft reply.
          await client.messages.deleteMessage.mutate(bareMessageId(id));
        }

        if (opts.json) {
          printResult({ success: true, id, action }, opts);
          return;
        }
        console.log(pc.green(`Review ${name}: ${id.slice(0, 8)}`));
      });
  }

  // revert just re-opens a doc change for review (non-destructive), so it stays
  // ungated. Drafts have no revert — a rejected draft is regenerated on the next
  // agent run — so a draft-prefixed id is refused here (ENG-524).
  cmd
    .command("revert")
    .description("Revert a doc change to pending review (not supported for draft replies)")
    .argument("<id>", "Review item ID (from `dosu review list`)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Route by prefix: drafts have no revert. requireDraft turns a truly-unknown
      // id into a clean "no review item" error instead of a misleading "not
      // supported" one; requireChange does the same for an unknown doc id.
      if (isDraftId(id)) {
        await requireDraft(client, id);
        console.error(
          pc.red(
            "Revert is not supported for draft replies. A rejected draft is regenerated on the next agent run.",
          ),
        );
        process.exit(1);
      }
      await requireChange(client, id);

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
