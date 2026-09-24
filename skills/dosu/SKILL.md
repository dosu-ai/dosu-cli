---
name: dosu
description: 'Use the Dosu CLI to authenticate and configure coding agents; manage Libraries, Agents, sources, Monitor, documents, reviews, threads, topics, members, integrations, and deployments; query knowledge; or audit a repository for Dosu-generated docs. Use for Dosu platform work that should be done from a terminal instead of the web app.'
---

# Use the Dosu CLI

Operate Dosu through `dosu`. Prefer structured output and let the CLI and App validate product rules.

## Start correctly

1. Run `dosu --version`. Do not probe installation with unrelated package-manager commands.
2. If it is unavailable and Node is present, try `npx -y @dosu/cli --version` and use `npx -y @dosu/cli` as the command prefix for this session. Otherwise ask before installing anything.
3. Run `dosu --help` or the relevant nested `--help` before using a command not covered by [the command reference](references/commands.md).
4. Pass `--json` whenever that leaf command exposes it. Parse the result; do not scrape the human table.

## Satisfy the right prerequisite

- `dosu login` supplies the JWT used by tRPC-backed commands.
- `dosu setup` selects an organization, Library context, and MCP deployment, creates an API key, and can configure an agent tool.
- `dosu ask` needs an API key. `docs generate`, `docs auto-tag`, and `docs publish` need both JWT login and the API key. Other platform commands generally need JWT login; commands scoped to an organization or current Library also need the corresponding setup selection.
- For coding-agent setup, follow the nonblocking `dosu setup --agent --tool <id>` workflow in [workflows.md](references/workflows.md). Relay its URL and execute its returned `resume_command`; never invent ticket commands.

## Use current product terms

- **Organization** is the account and permission boundary.
- **Library** is the knowledge container shown in the App. Older APIs may call it a `space`; do not present that internal name to users.
- **Data source** is an organization-level connection such as a repository, Slack channel, or Notion workspace. A Library can use already-connected sources.
- **Agent** is a configurable GitHub, GitLab, Slack, or Teams deployment serving exactly one Library.
- **Monitor** is per Library and source. It supports GitHub, GitLab, and Azure DevOps sources.
- `dosu deployments` manages selectable **MCP deployments**. Do not use it as an Agent CRUD command.

## Route by intent

| Intent | Route |
|---|---|
| Set up Dosu end-to-end ("set up dosu", new Library from scratch) | Read the guided onboarding flow in [workflows.md](references/workflows.md) first; it is checkpoint-driven — ask, wait, then act |
| Create or configure a Library | `dosu libraries ...` |
| Attach existing organization sources | `dosu sources list` → `dosu libraries sources attach` |
| Create or configure an Agent | `dosu agents ...` |
| Ask for a synthesized answer | `dosu ask` |
| Find source documents | `dosu knowledge search`, then `dosu docs get` |
| Create, import, or publish docs | `dosu docs ...` |
| Review a pending doc change or draft reply | Read [review-workflow.md](references/review-workflow.md) first |
| Inspect conversations | `dosu threads ...` |
| Browse managed topics | `dosu topics ...` |
| Audit agent docs, README, architecture, or dependencies | Read [audit.md](references/audit.md) first |

Use [commands.md](references/commands.md) as the sole detailed command and flag reference. Use [workflows.md](references/workflows.md) only for multi-command composition.

## Apply Library and Agent semantics

- To assemble a Library, list organization sources, create the Library, attach the chosen source IDs, then verify with `libraries info` and `libraries sources list`. The CLI cannot establish a brand-new OAuth connection.
- `libraries sources config` resolves the provider on the App side. Read the command reference before choosing provider-specific options.
- When creating a Library with a GitHub repository, or newly attaching one to an existing Library, treat Monitor as part of that setup unless the user opts out. Enable it with the whole-repository and `emoji` defaults, verify it, and explain that Monitor reviews pull requests to keep the Library's knowledge up to date. Follow [the Library workflow](references/workflows.md); do not ask the user to choose defaults.
- Create an Agent from an existing source ID and let the App choose its defaults; do not synthesize config in shell commands. Each data source can back at most one Agent: a `CONFLICT` (409) from `agents create` means the source already has one — offer a different source or an authorized `agents move` instead of retrying.
- Read Agent config before changing one existing leaf. Values are JSON. If a concurrent write returns `CONFLICT`, read again, re-evaluate the requested change, and retry only if it is still correct.
- Moving an Agent replaces its Library. Verify the returned `space_id`; do not infer migration behavior for historical data from the move receipt.

## Respect write boundaries

- Treat an explicit, unambiguous user request for the exact mutation as authorization. Otherwise show the intended change and wait for confirmation.
- For commands exposing `--confirm`, omit it first when a preview is useful; `{ "confirmRequired": true, "applied": false }` means nothing changed. Pass `--confirm` only after authorization.
- Never batch-approve or batch-reject review items. Diff one item, explain it, and decide only the ID the user authorized.
- Before deleting a Library, Agent, source, or document, state the exact target and impact. Before detaching a source, read and state the impact documented in the command reference. Some older delete commands do not enforce `--confirm`; the absence of a CLI prompt is not user approval.
- Before attaching a source to a public Library, warn that its content becomes available to everyone who can access that Library.
- OAuth connection and billing remain web-only. Report the boundary instead of claiming success.

## Handle failures literally

- `Not logged in` or an unrecoverable expired session: run `dosu login` (agent setup may instead return a ticket flow).
- Missing organization, Library, deployment, or API-key context: run the appropriate `dosu setup` flow.
- `confirmRequired`: no write occurred.
- `CONFLICT` on config: reread before retrying.
- A tRPC or backend error is a failed operation. Surface the code/path/status and do not imply the requested state exists.

## References

- [commands.md](references/commands.md): authoritative CLI syntax, choices, defaults, conflicts, and prerequisites
- [workflows.md](references/workflows.md): reusable multi-command flows
- [review-workflow.md](references/review-workflow.md): review safety and context
- [audit.md](references/audit.md): repository audit procedure
- [audit-findings-schema.md](references/audit-findings-schema.md): `.dosu/audit.json` contract
