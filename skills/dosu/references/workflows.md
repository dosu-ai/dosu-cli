# Dosu CLI workflows

Use these patterns to compose commands. Replace placeholders with IDs read from JSON output; never guess them. See [commands.md](commands.md) for exact flags and choices.

## Configure Dosu for a coding agent

```bash
dosu setup --agent --tool <tool-id>
```

Read every NDJSON event:

1. On `need_user_action`, give the returned URL to the user and stop.
2. After the user confirms sign-in, run the returned `resume_command` verbatim.
3. On `pending`, wait for the user and repeat that command.
4. On `multiple_deployments`, list MCP deployments, let the user choose, and retry with `--deployment <id>`.
5. Treat `done` as setup completion, then verify with `dosu status --json`.

## Onboard from scratch (guided)

Use this flow when the user asks to "set up Dosu", "create a library and set it up", or any
end-to-end onboarding. It is a conversation, not a script: never invent names, never auto-pick
sources, and stop at every checkpoint below until the user answers. Run each mutation only after
its checkpoint. One step per turn is better than one turn with every step.

**Step 0 — Discover (read-only, no confirmation needed).**

```bash
dosu status --json
dosu sources list --json
dosu libraries list --json
```

If not configured, run the "Configure Dosu for a coding agent" flow first.

**Checkpoint 1 — Scope.** Present a short summary of the connected sources (name + provider, not
raw JSON) and any existing Libraries, then ask and wait:

1. Which source(s) should the new Library use? Existing ones, a new one, or both.
2. What should the Library be called? Suggest a name derived from the chosen sources, but let the
   user decide.
3. Visibility: default `internal`; mention `private`/`public` only if relevant (warn about the
   public-Library boundary from [SKILL.md](../SKILL.md)).
4. For each chosen GitHub repository: Monitor will be enabled with defaults (whole repository,
   `emoji`) unless they opt out.

**Step 0.5 — Connect a new source (only when the user asked for one).** Ask which provider. For
GitHub, run the CLI bridge — do not send the user hunting through the App:

```bash
dosu sources connect github --json
```

Give the user the `url` from the `awaiting_install` event and wait; the command completes on its
own when the install finishes and reports `new_repositories`. For any other provider (Slack, web
docs, Notion, Coda, Confluence, ...) the connect flow is web-only: give the user the App URL the
command prints, wait for them to confirm, then re-run `dosu sources list --json` to pick up the
new source.

**Step 1 — Create and attach (after the user answers).**

```bash
dosu libraries create --name "<user-approved name>" --json
dosu libraries sources attach <library-id> <existing-source-ids...> --confirm --json
dosu sources create github --repo <owner/name> --library <library-id> --confirm --json
dosu libraries monitors update <library-id> <repository-source-id> --enabled on --confirm --json
```

Use `libraries sources attach` for sources that already exist; use `sources create` for a GitHub
repo that became visible via `sources connect` but has no data source yet (it creates, attaches,
and verifies the first sync in one receipt).

Report each receipt in one line as it lands (Library ID, sources attached, Monitor state).

**Checkpoint 2 — Agent (optional).** Ask whether the user wants an Agent (GitHub/GitLab/Slack/Teams
responder) on one of the attached sources. Only on yes:

```bash
dosu agents create --library <library-id> --source <source-id> --name "<user-approved name>" --json
```

A `CONFLICT` (409) means that data source already has an Agent — one Agent per source. Report which
source conflicted and offer the alternatives: pick a different source, or (only with explicit
authorization) `dosu agents move` the existing Agent, which removes it from its current Library.

**Step 2 — Verify and hand off.**

```bash
dosu libraries info <library-id> --json
dosu libraries sources list <library-id> --json
dosu libraries monitors list <library-id> --json
```

Summarize the final state. Creating an MCP deployment for the new Library is not available in the
CLI; if the user wants their MCP/CLI target pointed at this Library, send them to the App to create
the MCP deployment, then run `dosu deployments switch`.

## Create a Library from existing sources

This works with any number or mix of organization sources.

```bash
# Discover connected sources and select exact IDs by provider/name.
dosu sources list --json

# Create the Library; capture its id. Omitted visibility defaults to `internal`;
# pass --visibility public|internal|private only when the user asks for it.
dosu libraries create --name "Incident Response" --json

# The user's explicit request authorizes these exact attachments.
dosu libraries sources attach <library-id> <repository-source-id> <handbook-source-id> \
  --confirm --json

# Enable the default for each newly attached GitHub repository unless the user opted out.
dosu libraries monitors update <library-id> <repository-source-id> \
  --enabled on --confirm --json

# Verify the final state, not just mutation receipts.
dosu libraries info <library-id> --json
dosu libraries sources list <library-id> --json
dosu libraries monitors list <library-id> --json
```

Apply the connection and public-Library safety boundaries from [SKILL.md](../SKILL.md) before attaching.

## Change an existing Library safely

```bash
dosu libraries list --json
dosu libraries info <library-id> --json

# Rename or change visibility only after the exact target/change is authorized.
dosu libraries update <library-id> --name "Operations Handbook" --confirm --json

# Read before changing one documentation setting.
dosu libraries config get <library-id> --json
dosu libraries config set <library-id> review_timeout_days --value 30 --confirm --json
```

## Create and configure an Agent

```bash
# Select a Library and an existing GitHub, GitLab, Slack, or Teams source.
dosu libraries list --json
dosu sources list --json

dosu agents create --library <library-id> --source <source-id> \
  --name "Repository Helper" --json

dosu agents info <agent-id> --json
dosu agents config get <agent-id> --json

# Change one leaf only after reading the current structure.
dosu agents config set <agent-id> issues.auto_reply.review_required \
  --value true --confirm --json
```

To move the Agent, confirm the destination and verify the returned `space_id`:

```bash
dosu agents move <agent-id> --library <destination-library-id> --confirm --json
```

## Configure a Library source and Monitor

```bash
dosu libraries sources config get <library-id> <source-id> --json
dosu libraries sources config update <library-id> <source-id> \
  --include-patterns '["docs/**","*.md"]' \
  --exclude-patterns '["archive/**"]' --confirm --json

dosu libraries monitors list <library-id> --json
dosu libraries monitors update <library-id> <source-id> \
  --enabled on --paths '["docs/**"]' \
  --up-to-date-behavior silent --confirm --json
```

## Find information and inspect its source

```bash
dosu ask "How is access control enforced?" --json
dosu knowledge search "access control" --json
dosu docs get <page-id> --json
```

Use `ask` for a synthesized answer. Use `knowledge search` and `docs get` when the user wants the underlying documents.

## Import external documents

```bash
dosu sources list --json
dosu docs import <platform> --files <comma-separated-ids> --json
dosu docs import-status <task-id> --json
```

Capture the returned task ID. Poll only when the user asked you to wait for completion.

## Review one pending item

```bash
dosu review list --json
dosu review diff <item-id> --json
dosu review approve <item-id> --confirm --json
```

Use `reject` instead of `approve` only for the same explicitly authorized item. Follow [review-workflow.md](review-workflow.md) for edits, draft replies, upstream sync, and rollback.

## Audit repository documentation

Follow [audit.md](audit.md) to inspect the repository and write `.dosu/audit.json`, then invoke only the task IDs the user chooses:

```bash
dosu audit --tasks <comma-separated-task-ids> --json
```

The coding agent performs triage; Dosu cloud generates docs and opens the PR.
