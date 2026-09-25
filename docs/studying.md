# Studying sessions: the status line and `/dosu-incognito`

`dosu knowledge hooks enable` installs a session-end hook (Claude Code, Cursor, Codex) that runs
`dosu knowledge sync --quiet --detach`. The sync scans finished agent sessions, gates them behind a
watermark and a quiet period, applies the directory filter and pause switch from
`~/.config/dosu-cli/knowledge-sync.json`, and studies what is left. This document covers the
switches layered on top of that: a per-agent incognito setting, a per-session opt-out, and a
status-bar indicator.

`dosu setup` (and the TUI's configure step) installs the status line and the `/dosu-incognito`
slash command for every agent it enables the sync hook for, and removes them when an agent is
unticked. A hook that fails to install skips the bundle.

## Per-agent incognito

```bash
dosu knowledge incognito on                 # all detected agents
dosu knowledge incognito on cursor          # or any of: claude, cursor, codex
dosu knowledge incognito off [agents...]
dosu knowledge incognito status [--json]
```

`on` adds the agent ids to `incognito_agents` in `knowledge-sync.json`; `off` removes them. While an
agent is listed, sync skips every one of its sessions exactly like a `/dosu-incognito` session
(counted as incognito, passed by the watermark, so turning incognito off later does not study
them), the Activity backlog sets them aside, and its status line shows `👻 Dosu incognito`.
`resetSyncState` keeps the list. Both `on` and `off` also reinstall `/dosu-incognito` if it is
missing.

The setting only affects studying. The agent never reads it, so it can still call Dosu MCP tools;
only the slash command tells the model to leave Dosu alone.

The old `enable`/`disable` subcommands (which installed and removed the slash command) are gone
rather than aliased: reusing `enable` for "stop studying" would silently change what existing
scripts do.

## Per-session incognito

Typing `/dosu-incognito` in a chat keeps that chat out of Dosu while the agent is otherwise
studied. The command is a file per agent:

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
| `📚 Dosu studying…` | As `on`, and a knowledge-sync run is live right now (same lock check as the TUI) |
| `📚 Dosu on` | The hook is installed and this session will be studied when it ends |
| `👻 Dosu incognito` | `/dosu-incognito` was run in this session |
| `⚪ Dosu paused` | Studying is paused (Activity screen stop, or `paused` in the state file) |
| `⚪ Dosu not studying this folder` | A directory filter is set and `cwd` is outside it |
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
the CLI, and the renderer reads only the hook config, the sync state and lock files, and the
transcript. It
never throws; anything unreadable renders as `⚪ Dosu off`.

Dev installs (`DOSU_DEV=true`) pin the working copy and prefix with `env` rather than bare
`NAME=value` assignments, because Cursor spawns the command without a shell.

## Manual check

```bash
DOSU_DEV=true bun run dev knowledge statusline enable claude
DOSU_DEV=true bun run dev knowledge incognito on claude     # or type /dosu-incognito in one session
# Open Claude Code in a studied folder → 📚 Dosu on (📚 Dosu studying… while a sync runs)
# Run /dosu-incognito → 👻 Dosu incognito
# End the session; `dosu logs --tail` shows "skipping incognito session claude/<id>" on the next sync
```
