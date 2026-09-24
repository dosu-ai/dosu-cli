# Dosu CLI command reference

This file is the detailed source for the current command surface. Optional flags are in brackets. Only commands showing `--json` support structured JSON. Run the nested `--help` if the installed CLI differs.

## Authentication and setup

```text
dosu login [--request | --check <ticket>] [--json] [--no-browser]
dosu logout
dosu status [--json]
dosu setup [--deployment <id>] [--mode <oss|cloud>] [--agent --tool <id>]
           [--login-ticket <ticket>]
```

- `--request` and `--check` are mutually exclusive login modes.
- `setup --agent` requires `--tool`, emits NDJSON, and exits instead of waiting for a browser callback.

## Libraries

```text
dosu libraries list [--json]
dosu libraries info <library-id> [--json]
dosu libraries create --name <name> [--visibility public|internal|private] [--json]
dosu libraries update <library-id> [--name <name>]
                      [--visibility public|internal|private] [--confirm] [--json]
dosu libraries delete <library-id> [--confirm] [--json]
```

- Library and source IDs in this section must be UUID v4. Names are nonempty and at most 50 characters. Omitted visibility uses the App default, `internal`. `update` requires at least one changed field.
- `update` and `delete` prompt only in an interactive non-JSON terminal; agents pass `--confirm` after authorization.
- The last Library in an organization cannot be deleted. A successful delete hides it immediately; child-data cleanup continues asynchronously.

### Library documentation config

```text
dosu libraries config get <library-id> [--json]
dosu libraries config set <library-id> <setting> --value <json> [--confirm] [--json]
```

Settings and values:

| Setting | JSON value |
|---|---|
| `commit_to_trigger_pr` | boolean |
| `default_accept_review` | boolean |
| `default_save_publish` | boolean |
| `review_timeout_days` | `7`, `14`, `30`, or `90` |

`set` reads the current version immediately before writing and sends that version with the mutation.

### Library sources

```text
dosu libraries sources list <library-id> [--json]
dosu libraries sources attach <library-id> <source-id...> [--confirm] [--json]
dosu libraries sources detach <library-id> <source-id...> [--confirm] [--json]

dosu libraries sources config get <library-id> <source-id> [--json]
dosu libraries sources config update <library-id> <source-id>
    [--issues on|off] [--pull-requests on|off] [--discussions on|off] [--wiki on|off]
    [--include-patterns <json-string-array>] [--exclude-patterns <json-string-array>]
    [--confirm] [--json]
```

- `attach` and `detach` require one or more UUID source IDs. Repeated IDs are deduplicated.
- Detaching archives pages that source synced into this Library; copies in other Libraries are unaffected.
- Source config requires at least one option. GitHub accepts every option above; GitLab accepts only include/exclude patterns. The App resolves the provider.
- Pattern options replace the list. Use `[]` to clear it.

### Library Monitor

```text
dosu libraries monitors list <library-id> [--json]
dosu libraries monitors update <library-id> <source-id>
    [--enabled on|off] [--paths <json-string-array>]
    [--up-to-date-behavior emoji|comment|silent] [--confirm] [--json]
```

`update` requires at least one option. Monitor supports GitHub, GitLab, and Azure DevOps. It performs first-time setup for an attached supported source, reusing existing deployment infrastructure when available. When no Monitor row exists, omitted `--enabled`, paths, and behavior default to `true`, `[]`, and `emoji`.

## Agents

```text
dosu agents list [--json]
dosu agents info <agent-id> [--json]
dosu agents create --library <library-id> --source <source-id>
                   [--name <name>] [--guidelines <text>] [--json]
dosu agents update <agent-id> [--name <name>] [--enabled on|off]
                   [--guidelines <text> | --clear-guidelines] [--confirm] [--json]
dosu agents delete <agent-id> [--confirm] [--json]
dosu agents move <agent-id> --library <library-id> [--confirm] [--json]

dosu agents config get <agent-id> [--json]
dosu agents config set <agent-id> <existing.leaf.path>
                       --value <json> [--confirm] [--json]
```

- Agent, Library, and source IDs in this section must be UUID v4. `create` accepts an existing GitHub, GitLab, Slack, or Teams source. The App supplies provider defaults, enables the Agent, and starts Mention-only reply behavior. Omitted name uses the source name.
- Agent names are at most 80 characters; guidelines are at most 20,000 characters.
- `update` requires at least one option. `--guidelines` conflicts with `--clear-guidelines`.
- Config `set` changes one existing non-object leaf. Read the config first to select a valid path and value type.
- `move` replaces the Agent's Library and returns the updated Agent. It does not report any historical-data migration.

## Knowledge and documents

```text
dosu ask <question> [--session <id>] [--timeout <seconds>] [--json]
dosu knowledge search <query> [--limit <positive-int>] [--json]   # default 10
dosu knowledge list [--json]

dosu docs list [--search <query>] [--topic <id>] [--limit <positive-int>] [--json]
dosu docs get <id> [--revision <positive-int>] [--json]
dosu docs create --title <title> [--body <markdown> | --body-file <path>] [--json]
dosu docs update <id> [--title <title>] [--body <markdown> | --body-file <path>] [--json]
dosu docs archive <id> [--json]
dosu docs unarchive <id> [--json]
dosu docs delete <id> [--json]
dosu docs versions <id> [--json]
dosu docs restore <id> --revision <positive-int> [--json]
dosu docs generate --title <title> [--instructions <text>] [--json]
dosu docs auto-tag <id> [--json]
dosu docs import <platform> --files <comma-separated-ids> [--json]
dosu docs import-status <task-id> [--json]
dosu docs publish <id> --to <platform> [target flags] [--json]
dosu docs sync-back <id> [--json]
```

- Document list defaults to 20. `create` and `update` reject combining `--body` with `--body-file`; `update` requires at least one field.
- Import platforms: `github`, `gitlab`, `azure_devops`, `confluence`, `notion`, `coda`.
- Publish platforms: the same six. Target flags are `--repo-id`, `--project-id`, `--parent-page-id`, `--doc-id`, `--directory`, and `--data-source-id`; Azure DevOps requires `--data-source-id`. Other target validation may occur in the backend.
- `generate`, `auto-tag`, import, publish, and sync operations may be asynchronous. Use the returned task/status identifiers rather than assuming completion.

## Review

Read [review-workflow.md](review-workflow.md) before mutating a review item.

```text
dosu review list [--json]
dosu review diff <id> [--json]
dosu review edit <id> [--title <title>] [--body <markdown> | --body-file <path>] [--json]
dosu review context <thread-id> [--json]
dosu review approve <id> [--confirm] [--json]
dosu review reject <id> [--confirm] [--json]
dosu review revert <id> [--json]
```

`edit` requires at least one field. `approve` and `reject` do not write without interactive confirmation or `--confirm`.

## Sources, integrations, members, and organization

```text
dosu sources list [--json]
dosu sources info <id> [--json]
dosu sources sync <id> [--json]
dosu sources update <id> [--name <name>] [--description <text>] [--json]
dosu sources delete <id> [--json]
dosu sources connect [github] [--json] [--timeout <seconds>] [--no-open]
dosu sources create github --repo <owner/name> [--library <id>] [--confirm] [--json]

dosu integrations list [--json]
dosu integrations status <platform> [--json]
dosu integrations slack-channels [--json]
dosu integrations slack-join <channel-id> [--json]
dosu integrations github-collaborators <positive-repository-id> [--json]

dosu members invite <email> [--role admin|member] [--json]       # default member
dosu org info [--json]
```

- `sources update` requires `--name` or `--description`.
- `sources connect` currently supports only `github`: it prints an install URL for the user to
  open, then waits for the GitHub App install to complete (default 600s). With `--json` it emits
  NDJSON events — `awaiting_install` (give the `url` to the user), then `installed` with
  `new_repositories`, or `timeout` (exit 1). Other providers exit 1 with a web-app handoff URL.
- `sources create` wires an installed GitHub repo into a Library: it creates (or reuses) the
  repo's data source + deployment, attaches it, and verifies the first sync. `--library` defaults
  to the active Library. A repo not listed means the GitHub App lacks access — run
  `sources connect github` first. Forks can't be connected.
- Integration status choices: `github`, `gitlab`, `azure_devops`, `slack`, `confluence`, `notion`, `coda`, `teams`. GitHub, Slack, and Teams currently return `connected: null` because CLI status probing is unavailable for them.
- The CLI has no member list/remove/request commands; `members invite` is its only member operation.

## Threads, Topics, suggestions, and analytics

```text
dosu threads list [--status pending|resolved|archived] [--search <query>]
                  [--limit <1..100>] [--json]                    # default 20
dosu threads get <id> [--limit <-1|positive-int>] [--json]       # default 20
dosu threads archive <id> [--json]

dosu topics list [--json]
dosu topics pages <topic-id> [--search <query>] [--limit <positive-int>] [--json]

dosu suggest list [--json]
dosu suggest generate [--json]
dosu suggest reject <id> [--json]

dosu analytics [--days <positive-int>] [--json]                  # default 30
```

Topics are read-only. The CLI has no `tags` command and no suggestion-accept command.

## MCP deployments and local utilities

```text
dosu deployments list [--json]
dosu deployments info [--json]
dosu deployments switch <id> [--json]

dosu mcp list
dosu mcp add <agent> [--global] [--show-secret]
dosu skill install | remove | update
dosu telemetry status [--json]
dosu telemetry enable | disable | reset
dosu insights
dosu upgrade
dosu logs [--tail [n]] [--clear]
```

`deployments` selects the MCP deployment stored in local config; it is distinct from `agents`. `insights` opens an interactive visual report. `logs --clear` deletes the CLI log file.

## Codebase audit

```text
dosu audit [--findings <path>] [--data-source-id <id>]
           [--tasks <comma-separated-task-ids> | --yes] [--list-tasks] [--json]
```

The coding agent writes the findings; Dosu generates the selected docs. Follow [audit.md](audit.md) and [audit-findings-schema.md](audit-findings-schema.md).
