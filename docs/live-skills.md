# Live knowledge skills

`dosu skill link` turns one Dosu document into a Claude Code skill. Every time the skill runs, the agent fetches the document's current **published** revision through the CLI and follows it. Editing and publishing the document in Dosu changes what every agent using the skill does. Nothing is reinstalled.

```bash
dosu skill link <document-id> --name migration-review --agent claude
```

Then, in a new Claude Code session:

```
/migration-review review migrations/0042_widen_status_enum.sql
```

The agent prints the source it used before doing anything else:

```
Using Dosu procedure "DB Enum Widening Checklist" (document 879cbca9-…, revision 4, live)
```

## Commands

| Command | What it does |
|---|---|
| `dosu skill link <document-id> --name <name> --agent claude [--revision <n>] [--description <text>] [--project] [--force] [--json]` | Resolve the document once, then write `<skills-root>/<name>/SKILL.md`. Fails without writing anything if the document is missing, unpublished, archived, in another Library, or larger than the size limit. |
| `dosu skill resolve --document <id> --library <id> [--revision <n>] [--json]` | Fetch the highest published revision (or the pinned one) and print it. This is the command the generated skill runs. Exit code 1 on every failure. |
| `dosu skill links [--project] [--json]` | List the bindings the CLI owns in the user root and, with `--project` or when `<cwd>/.claude/skills` exists, the project root. |
| `dosu skill unlink <name> --agent claude [--project] [--json]` | Remove a binding the CLI owns. Foreign skills are never touched. |

`skill install`, `skill update`, and `skill remove` manage the official `dosu` skill and are unaffected by linked skills.

## Where files go

| Scope | Root | When |
|---|---|---|
| user (default) | `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`, falling back to `~/.claude/skills/<name>/SKILL.md` | Skill is available in every project on this machine. |
| project (`--project`) | `<cwd>/.claude/skills/<name>/SKILL.md` | Requires a git work tree. Commit the file so teammates in the same Library get the skill. |

Only that one file is written. Sibling skill directories are never read, modified, or removed.

If a newly linked skill does not appear in Claude Code, start a new session.

## Live vs pinned

- **Live** (default): each invocation lists the document's revisions, keeps only published ones, and fetches the highest. Drafts are never used. A publish during a run does not change the revision already returned; the next invocation resolves fresh.
- **Pinned** (`--revision <n>`): each invocation fetches exactly revision `n`. If that revision is unavailable or unpublished the skill stops with an error instead of falling back to the current revision.

The frontmatter `description` (the trigger Claude Code matches on) is fixed at link time. Only the body is live. Override it with `--description`.

## Updating a procedure

1. Edit the document in the Dosu web app and publish the new revision.
2. Confirm with `dosu docs versions <document-id>`.
3. Start a new agent session and invoke the skill. The source line shows the new revision.

Re-running `dosu skill link` with the same name and document is safe. It reports `unchanged` when nothing differs, `updated` when you changed `--revision` or `--description`, and refuses with `binding_modified` if you edited the generated file by hand. `--force` overwrites your edits. `--force` also lets you point an existing binding at a different document. It never overwrites a skill the CLI did not create (`name_taken`).

## What the generated file contains

`SKILL.md` carries a versioned marker comment with the document id, Library id, pinned revision (or `null`), template version, CLI version, and a SHA-256 of the file's content. That marker is how `links` finds bindings and how `unlink` refuses to delete foreign skills. The file contains no credentials: the resolver reads your session from `~/.config/dosu-cli/config.json` when it runs.

## Failure reasons

Every failure exits 1. With `--json`, a single object with `status: "error"`, `reason`, `message`, and `agent_next_steps` is printed to stdout so the agent can report it.

| `reason` | Meaning |
|---|---|
| `library_mismatch` | The active Library differs from the one the skill was linked in, or the document lives in another Library. |
| `document_not_found` | Missing or inaccessible document. The CLI never searches by title. |
| `no_published_revision` | Every revision is a draft. |
| `revision_unavailable` | The pinned revision does not exist. |
| `revision_not_published` | The pinned revision is a draft. |
| `document_archived` | The document is archived. |
| `empty_body` | The published revision has no body. |
| `procedure_too_large` | The body exceeds 32,000 characters. Nothing is truncated. |
| `access_denied` | The current account cannot read the document. |
| `network_error` | The procedure could not be loaded. |
| `name_taken` | A skill with that name exists and the CLI did not create it. |
| `binding_modified` | The generated file was edited by hand. Use `--force` to overwrite. |
| `binding_points_elsewhere` | The existing binding tracks a different document. Use `--force`. |
| `not_a_dosu_link` | `unlink` was asked to remove a skill the CLI does not own. |

## Scope of v1

Claude Code only. Other `--agent` values are rejected. Out of scope for now: other clients, per-binding size limits, setup-wizard integration, and a TUI entry.
