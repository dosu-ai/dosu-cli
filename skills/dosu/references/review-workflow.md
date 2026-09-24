# Review workflow

How to work Dosu's review queue from the CLI: triage pending items, read the
diff, optionally edit, and apply a decision — safely.

The queue holds **document versions** (AI-generated, user-edited, synced from
source, or API-created) and **draft messages**, all surfaced through the same
`dosu review` commands. Items are keyed on a single `page-version-id` so
`list` → `diff` → `edit` → `approve`/`reject` all share one ID.

> `list` returns only the most recent pending items (server-capped, currently
> 50) and does not flag truncation. If the queue is large, don't assume `list`
> shows everything.

## Scope tool access for a review session

Approving and rejecting are destructive and outward-facing. When you spin up an
agent session dedicated to reviewing, scope it to just the review commands:

```yaml
allowed-tools: Bash(dosu review:*)
```

This lets the agent triage, diff, and edit, but keeps it from running unrelated
CLI commands during a review pass.

## The flow

```bash
# 1. Triage — what's pending? Columns: ID, Kind, Title, Source, Status, Created.
dosu review list --json

# 2. Inspect — read the exact change before deciding anything.
dosu review diff <page-version-id> --json

# 3. (optional) Edit in place instead of rejecting a near-miss.
dosu review edit <page-version-id> --body-file ./revised.md   # or --body / --title

# 4. Decide — only on the item the user named, only after they OK it.
dosu review approve <page-version-id> --confirm --json
dosu review reject  <page-version-id> --confirm --json

# Undo a decision — back to pending.
dosu review revert <page-version-id> --json
```

### `--confirm` is mandatory for agents

`approve` and `reject` only prompt interactively in a TTY *without* `--json`.
The skill always passes `--json`, which suppresses both the diff preview and
the prompt — so without `--confirm` the command changes nothing and returns
`{ "applied": false, "confirmRequired": true }`. Run `dosu review diff <id>` to
see the change, then pass `--confirm` to apply — only after the user has
approved that specific item.

## Reading the `Source` column

`Source` is the humanized `origin` field:

| `origin` | Source | Meaning |
|---|---|---|
| `manual_update` | User created / User updated | A teammate authored or edited the doc |
| `llm_generated` | AI generated | Dosu drafted the change |
| `sync_upstream` | Synced from source | Came in from a connected source (Notion/Confluence/GitHub) |
| `api_update` | Created via API | Pushed in programmatically |

## Feeding PR / thread context

A review often originates from a conversation thread (a GitHub issue, a Slack
message, a sync-back PR). Pull that context before deciding:

```bash
dosu review context <thread-id> --json
```

It returns the review `type`, the review/published page IDs, and — when the
change round-trips to an external system — a **Sync PR URL**. Use it to:

- show the user where the change came from and where approval will land, and
- read the originating discussion so the decision matches intent.

## Safety rules

- **Explicit item only.** Decide on the `id` the user named. "Review my queue"
  → run `list` and show it; never decide on their behalf.
- **Diff before deciding.** Always `diff` and surface the change first.
- **Never batch-accept.** No loop over `list` that approves everything. One
  item, one confirmation.
- **Extra care for sync/PR origins.** `Synced from source` items and anything
  with a Sync PR URL push back to an upstream system on approval. Call it out
  and get explicit sign-off.
