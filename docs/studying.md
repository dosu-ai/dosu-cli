# Studying sessions: the status line and `/dosu-incognito`

`dosu knowledge hooks enable` installs a session-end hook (Claude Code, Cursor, Codex) that runs
`dosu knowledge sync --quiet --detach`. The sync scans finished agent sessions, gates them behind a
watermark and a quiet period, applies the repo scope and pause switch from
`~/.config/dosu-cli/knowledge-sync.json`, and studies what is left. This document covers the study
scope and the two switches layered on top of it: a per-session opt-out and a status-bar indicator.

## Study scope

Only sessions that ran inside a git repository are studied. A session's repo is the `origin`
remote of its working directory, normalized to the same `host/owner/repo` key Dosu anchors notes
to (`git@github.com:dosu-ai/dosu-cli.git` → `github.com/dosu-ai/dosu-cli`). Sessions outside a
repo, or in a repo without an `origin`, are skipped. The lookup is cached per session in
`project-dirs.json`, so a checkout deleted later still resolves.

Each note the learner writes carries its session's repo: the tool gate sets `repo` on
`write_knowledge` (dropping anything the model supplied) and never sends `branch`. Repo alone keeps
the note unanchored, so it is promoted immediately as before, with the repo stored as observed
context. Sending a branch would anchor a Branch Note that waits for a PR merge, which a session on
the default branch or an already-merged branch never gets.

`dosu` → settings → study scope picks which repos to study (`repo_filter` in the state file).
Picking every repo clears the filter so new repos are studied automatically. Clones and worktrees of
the same repo share one entry.

Before repo scoping, the scope was a list of folders (`project_filter`). The next sync converts it
to the repos its folders' sessions ran in, so upgrading never widens the scope. A folder scope with
no repos in it becomes an empty repo scope, which studies nothing until you pick repos again.

Both are installed by default: `dosu setup` (and the TUI's configure step) enables the status line
and the slash command for every agent it enables the sync hook for, and removes them when an agent
is unticked. A hook that fails to install skips the bundle. The commands below manage them directly.

## Per-session incognito

```bash
dosu knowledge incognito enable            # all detected agents
dosu knowledge incognito enable claude     # or one of: claude, cursor, codex
dosu knowledge incognito status [--json]
dosu knowledge incognito disable [agents...]
```

`enable` writes a slash-command file per agent:

| Agent | File |
|---|---|
| Claude Code | `~/.claude/commands/dosu-incognito.md` (honors `CLAUDE_CONFIG_DIR`) |
| Cursor | `~/.cursor/commands/dosu-incognito.md` |
| Codex | `~/.codex/prompts/dosu-incognito.md` (honors `CODEX_HOME`) |

Running `/dosu-incognito` inside a session expands the file into the conversation. Its body carries
the marker `dosu:incognito:v1` and instructs the model not to call Dosu MCP tools for the rest of
the session. Because the harness records the expansion in the transcript, the marker is the switch:

- `dosu knowledge sync` skips any gated session whose transcript contains the marker (or Claude
  Code's `<command-name>/dosu-incognito</command-name>` record). Skipped sessions count as examined,
  so the watermark moves past them and they are never re-read. The debug log records
  `skipping incognito session <harness>/<id>` and the run summary shows `N incognito skipped`.
- The Activity screen and `dosu knowledge sessions` set them aside from the queue.

Properties worth knowing:

- It covers the **whole session**, including turns before the command was run, since the transcript
  is skipped as a unit.
- It is **one-way** for that session. Start a new session to have Dosu study again. Resuming the
  same session keeps it incognito.
- The command **instructs** the model to avoid Dosu tools; it does not block them. A `PreToolUse`
  hook that rejects Dosu tool calls when the marker is present is a possible follow-up.
- OpenCode has no slash-command install here, but its sessions are checked for the marker too.

## Status line

```bash
dosu knowledge statusline enable           # all detected agents
dosu knowledge statusline enable cursor    # or one of: claude, cursor
dosu knowledge statusline status [--json]
dosu knowledge statusline disable [agents...]
```

Claude Code (`~/.claude/settings.json`) and Cursor CLI (`~/.cursor/cli-config.json`) share the same
`statusLine: { "type": "command", "command": "..." }` config and pipe the same JSON payload
(`cwd`, `transcript_path`, `session_id`, ...) into the command on every update. `enable` sets the
command to `dosu knowledge statusline render --agent <id>`, which prints one line:

| Line | Meaning |
|---|---|
| `📚 Dosu studying…` | The hook is installed and this session will be studied when it ends |
| `👻 Dosu incognito` | `/dosu-incognito` was run in this session |
| `⚪ Dosu paused` | Studying is paused (Activity screen stop, or `paused` in the state file) |
| `⚪ Dosu not studying this repo` | `cwd` is outside a git repo, or its repo is outside the study scope |
| `⚪ Dosu off` | No Dosu hook is installed for this agent |

States are checked in that order after `off`: incognito outranks paused and not-studied because it
is the user's own action in this session and the line is how they confirm it took.

Neither setup nor `enable` replaces an existing status line. If one is configured, it is left
alone and the line to add to your own script is printed instead:

```bash
printf '%s' "$input" | dosu knowledge statusline render --agent claude
```

Rendering is on the hot path (harnesses re-run the command at most every 300 ms, Cursor kills it
after 2 s), so `src/index.ts` dispatches `knowledge statusline render` before loading the rest of
the CLI, and the renderer reads only the hook config, the sync state file, and the transcript, plus
one `git remote get-url origin` in `cwd` (1 s timeout) once the earlier states have not matched. It
never throws; anything unreadable renders as `⚪ Dosu off`.

Dev installs (`DOSU_DEV=true`) pin the working copy and prefix with `env` rather than bare
`NAME=value` assignments, because Cursor spawns the command without a shell.

## Manual check

```bash
DOSU_DEV=true bun run dev knowledge statusline enable claude
DOSU_DEV=true bun run dev knowledge incognito enable claude
# Open Claude Code in a studied repo → 📚 Dosu studying…
# Run /dosu-incognito → 👻 Dosu incognito
# End the session; `dosu logs --tail` shows "skipping incognito session claude/<id>" on the next sync
```
