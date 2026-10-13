# Review workflow

How to work Dosu's review queue from the CLI: triage pending items, read the
diff, optionally edit, and apply a decision — safely.

The queue holds **document versions** (AI-generated, user-edited, synced from
source, or API-created) and **draft messages**, all surfaced through the same
`dosu review` commands. Doc changes come from the selected Library; draft
replies come only from threads of the selected MCP deployment.

## Read the list result

`dosu review list --json` returns
`{ "items": [...], "truncated": <bool>, "total": <n>, "scope": {...} }`.

- `items` holds at most 50 entries, newest first, doc changes and draft
  replies merged.
- `truncated: true` means more pending items may exist than `items` shows.
- `total` counts what the server found before that cap. When `truncated` is
  true it is a lower bound: report "at least `total`", never an exact backlog.
- Each `id` is opaque. A doc change's `id` is its page-version UUID; a draft
  reply's `id` looks like `draft_message:<uuid>` and has `kind: "draft_message"`.
  Pass the `id` exactly as listed to `diff`, `edit`, `approve`, and `reject`;
  do not strip the prefix or shorten it.
- `--since <when>` and `--until <when>` narrow the list by creation time. Each
  takes a duration back from now (`24h`, `7d`, `2w`), a UTC date
  (`2026-09-01`; an `--until` date includes that whole day), or an ISO-8601
  datetime. When `truncated` is true, `--until` reaches older items.

`scope` says what was searched. It was added alongside the older fields,
which keep their meaning:

- `library`: `{ "id", "name" }` of the Library whose pending doc changes are
  listed.
- `deployment`: `{ "id", "name" }` of the MCP deployment whose draft replies
  are listed, or `null` when none is saved. Then drafts are not listed.
- `kinds`: the item kinds searched, `["doc_change", "draft_message"]` or
  `["doc_change"]`.
- `since` / `until`: the resolved ISO-8601 bounds, or `null` when unbounded.

A `name` is `null` when the server could not provide one; report the ID then
and do not guess a name. Tell the user which Library the list covers.

An empty `items` array means no pending items in this scope. It is not a
reason to switch deployments.

`review list` checks the saved context before listing and fails (exit 1,
nothing on stdout) instead of returning an empty list when:

- `Not logged in`: run `dosu login`.
- `No Library selected`: no Library is saved. Follow the context check below.
- `... is unavailable`: the saved MCP deployment or Library was deleted, or
  the signed-in account cannot access it. Follow the context check below; if
  `dosu deployments list --json` returns nothing, the saved organization may
  be the inaccessible one, and `dosu setup` chooses it again.
- `... does not match ...`: the saved Library is not the MCP deployment's
  Library. The message names the `dosu deployments switch` command that saves
  them together again; run it only after the user confirms.

## Check the context when the scope looks wrong

Run this only when the user says the list is for the wrong Library, names a
different Library, or a command reports missing context:

1. `dosu status --json`: login state and the selected MCP deployment.
2. `dosu deployments info --json`: the selected MCP deployment. The list reads
   the Library saved in the CLI's config, which `dosu setup` and
   `dosu deployments switch` set to this deployment's `space_id`
   (`dosu libraries info <space_id> --json` gives its name). A successful list
   already reports both in `scope`, and a saved Library that does not match
   the deployment's is an error.
3. If that is not the Library the user means, run
   `dosu deployments list --json` and find the MCP deployment whose `space_id`
   matches it (`dosu libraries list --json` maps names to IDs).
4. Switch only to a deployment the user named or confirmed:
   `dosu deployments switch <deployment-id> --json`. It changes the CLI's
   selection for later commands and mints a new API key, so say that it did.
   Never pick the first deployment, and ask when several match or none does.
5. Run `dosu review list --json` again.

`deployments switch` changes only the CLI's saved selection. An AI tool with a
running Dosu MCP connection still points at its previous deployment until
`dosu mcp refresh` rewrites its MCP entry and the tool restarts or reconnects.
Say so after a switch; do not run `dosu mcp refresh` unless the user asks.

## Draft reply limits

- `edit` on a draft accepts `--body` or `--body-file` only (no `--title`).
- `approve` publishes the draft to its thread; `reject` discards it.
- Drafts have no `revert`. A rejected draft is regenerated on the next agent run.

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
dosu review list --since 7d --json          # optional creation-time window

# 2. Inspect — read the exact change before deciding anything.
dosu review diff <id> --json

# 3. (optional) Edit in place instead of rejecting a near-miss.
dosu review edit <id> --body-file ./revised.md   # or --body / --title (docs only)

# 4. Decide — only on the item the user named, only after they OK it.
dosu review approve <id> --confirm --json
dosu review reject  <id> --confirm --json

# Undo a doc-change decision — back to pending (not for draft replies).
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
- **Listing is read-only.** A request to show the list authorizes no approve,
  reject, edit, API-key creation, or deployment switch.
- **Diff before deciding.** Always `diff` and surface the change first.
- **Never batch-accept.** No loop over `list` that approves everything. One
  item, one confirmation.
- **Extra care for sync/PR origins.** `Synced from source` items and anything
  with a Sync PR URL push back to an upstream system on approval. Call it out
  and get explicit sign-off.
