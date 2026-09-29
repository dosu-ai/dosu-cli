/** `dosu review`: review workflow for pending doc changes and draft replies. */

import { readFileSync } from "node:fs";
import { isTRPCClientError } from "@trpc/client";
import { Command, Option } from "commander";
import pc from "picocolors";
import { CommandError, type CommandErrorCode } from "../cli/command-error";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type {
  CliPendingReviewItem,
  MessagesGetMessageOutput,
  ReviewGetChangeOutput,
} from "../generated/dosu-api-types";
import { requireLoginConfig } from "./auth";
import { confirmAction } from "./confirmation";
import { formatDate, printInfo, printResult, printTable, truncate } from "./output";
import { describeTimeRange, resolveTimeRange, timeBound } from "./time-range";

// Contract-typed since dosu#11679: no local mirror types, so a contract-side shape change
// fails typecheck here instead of silently breaking at runtime.
type ChangeView = ReviewGetChangeOutput;
type DraftMessageRow = NonNullable<MessagesGetMessageOutput>;
type ReviewOrigin = CliPendingReviewItem["origin"];

function requireConfig() {
  return requireLoginConfig();
}

function isNotFound(err: unknown): boolean {
  return isTRPCClientError(err) && (err.data as { code?: string } | null)?.code === "NOT_FOUND";
}

// A malformed id fails UUID validation with 422 (UNPROCESSABLE_CONTENT) rather than 404;
// treat it like NOT_FOUND so a bad id reads as a clean "no such review item".
function isInvalidId(err: unknown): boolean {
  return (
    isTRPCClientError(err) &&
    (err.data as { code?: string } | null)?.code === "UNPROCESSABLE_CONTENT"
  );
}

// Draft-message id prefix; mirrors DRAFT_MESSAGE_ID_PREFIX in dosu's review router and
// DRAFT_MESSAGE_PREFIX in the MCP review tool. Keep all three in sync.
const DRAFT_MESSAGE_ID_PREFIX = "draft_message:";

// Route an id by prefix (draft_message vs doc-change UUID); getChange now 422s on prefixed
// ids, so the old 404-probe routing no longer works.
function isDraftId(id: string): boolean {
  return id.startsWith(DRAFT_MESSAGE_ID_PREFIX);
}

// Strip the draft prefix to recover the bare message UUID the `messages.*` procedures expect.
function bareMessageId(id: string): string {
  return id.slice(DRAFT_MESSAGE_ID_PREFIX.length);
}

// Short id for confirmation messages — strip the draft prefix first so a draft
// shows its message id (`msg-1`), not the shared prefix (`draft_me`).
function truncateId(id: string): string {
  return (isDraftId(id) ? bareMessageId(id) : id).slice(0, 8);
}

function reviewItemNotFound(id: string): CommandError {
  return new CommandError(
    "REVIEW_ITEM_NOT_FOUND",
    `No review item found for '${id}'. Run 'dosu review list' to see pending items.`,
  );
}

// Fetch the doc-change view, or fail cleanly on an unknown (404) or malformed (422) id.
async function requireChange(client: TypedClient, id: string): Promise<ChangeView> {
  try {
    return await client.review.getChange.query({ id });
  } catch (err) {
    if (isNotFound(err) || isInvalidId(err)) throw reviewItemNotFound(id);
    throw err;
  }
}

// Fetch the message row behind a draft id (bare-UUID lookup), or fail if missing.
async function requireDraft(client: TypedClient, id: string): Promise<DraftMessageRow> {
  const draft = await client.messages.getMessage.query(bareMessageId(id));
  if (!draft) throw reviewItemNotFound(id);
  return draft;
}

function invalidArgument(message: string): CommandError {
  return new CommandError("INVALID_ARGUMENT", message);
}

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

// Recovery shared by every "wrong or missing scope" error: the exact existing selection commands.
const SELECT_LIBRARY_HINT =
  "Run 'dosu deployments list' to see the MCP deployments you can select, then " +
  "'dosu deployments switch <deployment-id>' for the Library to review, or run 'dosu setup' " +
  "to choose the organization and Library again.";

function failScope(
  code: CommandErrorCode,
  message: string,
  hint: string = SELECT_LIBRARY_HINT,
): never {
  throw new CommandError(code, message, [hint]);
}

/** What `review list` searched: doc changes come from the Library's knowledge store, draft
 * replies from the MCP deployment's threads. Names are read from the server for this account,
 * never from cached config, and stay null when a lookup cannot provide them. */
interface ReviewScope {
  knowledgeStoreId: string;
  library: { id: string; name: string | null };
  deployment: { id: string; name: string | null } | null;
}

// libraries.info is authoritative for "deleted or not visible" (NOT_FOUND); any other failure
// only costs the display name, so it must not turn a readable queue into an error.
async function lookupLibrary(
  client: TypedClient,
  spaceId: string,
): Promise<{ found: false } | { found: true; name: string | null }> {
  try {
    const library = await client.libraries.info.query(spaceId);
    return { found: true, name: library.name || null };
  } catch (err) {
    if (isNotFound(err)) return { found: false };
    return { found: true, name: null };
  }
}

/** Validate the saved Library / MCP deployment before listing, so a stale or unauthorized
 * target is an error rather than an empty queue. Read-only: never changes the selection. */
async function resolveReviewScope(
  client: TypedClient,
  spaceId: string,
  deploymentId: string | undefined,
): Promise<ReviewScope> {
  const [store, library, deployment] = await Promise.all([
    client.knowledgeStore.getBySpaceId.query({ space_id: spaceId }),
    lookupLibrary(client, spaceId),
    deploymentId ? client.workspaces.get.query(deploymentId) : Promise.resolve(undefined),
  ]);

  if (deploymentId && !deployment) {
    failScope(
      "DEPLOYMENT_UNAVAILABLE",
      `The selected MCP deployment (${deploymentId}) is unavailable: it was deleted, or the ` +
        "signed-in account cannot access it.",
    );
  }
  if (deployment && deployment.space_id !== spaceId) {
    failScope(
      "SCOPE_MISMATCH",
      `The saved Library (${spaceId}) does not match the Library of the selected MCP ` +
        `deployment (${deployment.space_id}).`,
      `Run 'dosu deployments switch ${deployment.deployment_id}' to save that deployment's ` +
        "Library again, or choose another MCP deployment with 'dosu deployments list'.",
    );
  }
  if (!library.found || !store) {
    failScope(
      "LIBRARY_UNAVAILABLE",
      `The selected Library (${spaceId}) is unavailable: it was deleted, or the signed-in ` +
        "account cannot access it.",
    );
  }

  return {
    knowledgeStoreId: store.id,
    library: { id: spaceId, name: library.name },
    deployment: deployment ? { id: deployment.deployment_id, name: deployment.name || null } : null,
  };
}

function describeScopeEntry(entry: { id: string; name: string | null }): string {
  return entry.name ? `${entry.name} (${entry.id})` : entry.id;
}

function printScope(scope: ReviewScope): void {
  printInfo([
    ["Library", describeScopeEntry(scope.library)],
    [
      "MCP deployment",
      scope.deployment
        ? describeScopeEntry(scope.deployment)
        : "none selected (draft replies not listed)",
    ],
  ]);
  console.log();
}

export function reviewCommand(): Command {
  const cmd = new Command("review").description("Review workflow (doc changes and draft replies)");

  cmd
    .command("list")
    .description(
      "List pending review items in the selected Library (doc changes and draft replies)",
    )
    .addOption(
      new Option(
        "--since <when>",
        "Only items created at or after <when>: a duration back from now (24h, 7d, 2w), " +
          "a UTC date (2026-09-01), or an ISO-8601 datetime",
      ).argParser(timeBound),
    )
    .addOption(
      new Option(
        "--until <when>",
        "Only items created before <when> (same forms; a date includes that whole day)",
      ).argParser(timeBound),
    )
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean; since?: string; until?: string }) => {
      let range: ReturnType<typeof resolveTimeRange>;
      try {
        range = resolveTimeRange(opts.since, opts.until);
      } catch (err) {
        throw invalidArgument(`${(err as Error).message}.`);
      }
      const rangeLabel = describeTimeRange(range);
      const inRange = rangeLabel ? ` ${rangeLabel}` : "";

      const cfg = requireConfig();
      const target = cfg.active_account?.target;
      if (!target?.space_id) {
        failScope(
          "NO_LIBRARY_SELECTED",
          "No Library selected. The review list reads the Library of the selected MCP deployment.",
        );
      }
      const client = createTypedClient(cfg);
      const scope = await resolveReviewScope(client, target.space_id, target.deployment_id);

      // Docs are knowledge-store-scoped, drafts are deployment-scoped; passing deploymentId
      // merges draft replies into the list, omitting it returns doc changes only.
      const result = await client.review.listPending.query({
        knowledgeStoreId: scope.knowledgeStoreId,
        ...(scope.deployment && { deploymentId: scope.deployment.id }),
        ...(range.since && { since: range.since.toISOString() }),
        ...(range.until && { until: range.until.toISOString() }),
      });
      const { items, truncated, total } = result;

      if (opts.json) {
        // `scope` is additive: `items`, `truncated`, and `total` keep their shape and meaning.
        printResult(
          {
            ...result,
            scope: {
              library: scope.library,
              deployment: scope.deployment,
              kinds: scope.deployment ? ["doc_change", "draft_message"] : ["doc_change"],
              since: range.since?.toISOString() ?? null,
              until: range.until?.toISOString() ?? null,
            },
          },
          opts,
        );
        return;
      }

      printScope(scope);

      if (!items || items.length === 0) {
        console.log(pc.dim(`No pending review items in this scope${inRange}.`));
        console.log(
          pc.dim(
            "Only the selected Library is listed. To review another Library, find its MCP " +
              "deployment with 'dosu deployments list' and select it with " +
              "'dosu deployments switch <deployment-id>'.",
          ),
        );
        return;
      }

      if (rangeLabel) console.log(pc.dim(`Pending review items created ${rangeLabel}:`));

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
      if (truncated) {
        // Mirrors the MCP review tool's truncation footer (ENG-605): the backlog
        // is larger than one page, so tell the user what they're looking at.
        console.log(
          pc.dim(`Showing ${items.length} of ${total}+ pending items${inRange} (list truncated).`),
        );
      }
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

  // In-place edit: docs go through page.updateReview (PENDING_REVIEW-guarded), drafts save a
  // new revision via message.saveDraft (body only); `dosu review approve` publishes afterward.
  cmd
    .command("edit")
    .description("Edit a pending doc or Dosu App draft in place")
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
          throw invalidArgument("Pass only one of --body or --body-file.");
        }

        let body: string | undefined = opts.body;
        if (opts.bodyFile) {
          try {
            body = readFileSync(opts.bodyFile, "utf-8");
          } catch (err) {
            throw invalidArgument(`Failed to read --body-file: ${(err as Error).message}`);
          }
        }

        if (body === undefined && opts.title === undefined) {
          throw invalidArgument("Nothing to edit. Pass --title and/or --body/--body-file.");
        }

        // Route by prefix: a draft saves a new revision (body only), a doc edits in place.
        if (isDraftId(id)) {
          // saveDraft takes body only; --title is doc-only. (Past the generic
          // "nothing to edit" check above, body is guaranteed set when title isn't.)
          if (opts.title !== undefined) {
            throw invalidArgument("Draft replies support --body only (no --title).");
          }
          if (body === undefined) {
            throw invalidArgument("Draft replies require --body or --body-file.");
          }
          await requireDraft(client, id);
          await client.messages.saveDraft.mutate({
            messageId: bareMessageId(id),
            body,
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
              throw new CommandError(
                "REVIEW_ITEM_NOT_FOUND",
                `No pending review item found for '${id}'. Run 'dosu review list' to see editable items.`,
              );
            }
            throw err;
          }
        }

        if (opts.json) {
          printResult({ success: true, id }, opts);
          return;
        }
        console.log(pc.green(`Review edited: ${truncateId(id)}`));
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

  // approve/reject mutate published content, so they are gated behind a diff preview plus
  // explicit confirmation (--confirm or an interactive y/N).
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

        const preview = change ?? {
          id,
          kind: "draft_message",
          title: draft?.title,
          body: draft?.body,
        };
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: `${verb} this ${noun}?`,
            preview,
          }))
        )
          return;

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
        console.log(pc.green(`Review ${name}: ${truncateId(id)}`));
      });
  }

  // revert is non-destructive so it stays ungated; drafts have no revert (a rejected draft is
  // regenerated on the next agent run), so a draft-prefixed id is refused.
  cmd
    .command("revert")
    .description("Reopen a previously accepted or declined doc change for review")
    .argument("<id>", "Page version ID (not a pending item from `dosu review list`)")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Route by prefix: drafts have no revert. requireDraft/requireChange turn an unknown id
      // into a clean "no review item" error instead of a misleading "not supported" one.
      if (isDraftId(id)) {
        await requireDraft(client, id);
        throw invalidArgument(
          "Revert is not supported for draft replies. A rejected draft is regenerated on the next agent run.",
        );
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
      console.log(pc.green(`Review revert: ${truncateId(id)}`));
    });

  return cmd;
}
