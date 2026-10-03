# Syncing sessions to Dosu memory

`dosu knowledge hooks enable` installs a session-end hook (Claude Code, Cursor, Codex) that runs
`dosu knowledge sync --quiet --detach`. The sync scans the last 30 days of agent sessions, keeps the
ones its ledger has no answer for, applies the repo scope and pause switch from
`~/.config/dosu-cli/knowledge-sync.json`, and ships them to Dosu memory (secrets redacted locally
first), which learns from each session server-side. Shipping is on by default;
`dosu knowledge transcripts disable` turns it off. This document covers how a sync decides what to
ship, the project key sessions are scoped by, the repo scope, and the two switches layered on top:
a per-session opt-out and a status-bar indicator.

## Codex hooks

`dosu knowledge hooks enable codex` writes `$CODEX_HOME/hooks.json` (default `~/.codex`) for the
`codex` on PATH, so re-running it after a Codex upgrade converges on the right set:

| Codex | Sync triggers | Prompt-time memory |
|---|---|---|
| 0.160+ | `SessionEnd` (the ended session ships at once; 3s timeout, Codex's cap), and `Stop` | `UserPromptSubmit` |
| 0.116 to 0.159, or no `codex` on PATH | `Stop`, after every turn (sessions ship once quiet) | `UserPromptSubmit` |
| older | `Stop` | none |

`Stop` stays alongside `SessionEnd` because every Codex that shares the home reads the same
hooks.json (another install, the IDE extension, the desktop app), and one without `SessionEnd`
skips that event silently: `Stop` keeps its sessions shipping. It is also the backstop for a session
that never fires `SessionEnd` (`codex exec` killed with SIGTERM fires none; SIGINT does): a later
turn's run ships it once it has been quiet for five minutes. A `Stop` run never names a session as
ended, so it ships nothing early; on 0.160 its run is usually an empty one.

Codex runs a hook only once its `config.toml` records the hook's hash as trusted (0.129+), and
`codex exec` never asks, so `enable` records that trust itself: a
`[hooks.state."<hooks.json path>:<event>:<group>:<handler>"]` table with `trusted_hash`, the same
hash Codex's own `/hooks` review stores (sha256 over the normalized hook; the path is `CODEX_HOME`
with symlinks resolved). The keys are positions, so when Dosu's hook leaves an event (an upgrade,
or `disable`) the user's own hooks behind it shift, and their tables move with them. Only those
tables change; the rest of `config.toml`, comments included, is left as it was, and an edit that
parsing shows would change anything else is refused with an error, leaving both files as they
were: hooks Codex would not run are never installed. `hooks status` reports Codex enabled only
while Dosu's hooks are in hooks.json with their current hashes trusted. `disable` removes exactly
the hooks and tables `enable` added (with the newline each table was appended behind), and deletes
a hooks.json or config.toml it leaves empty; both files keep their mode.

The prompt hook runs `dosu knowledge context --agent codex --format codex`, which answers with the
same `additionalContext` JSON as Claude Code's. It names the session by its rollout file, as the
scan does: Codex's `session_id` is the root session's even inside a subagent.

## What a sync ships

The state file keeps a ledger (`sessions`, schema 3) with one entry per session, keyed
`<harness>/<session id>`, recording how it was settled and the session's mtime at the time. A
scanned session is **pending** when it has no entry, when its mtime differs from the entry's (it was
resumed or kept writing), or when it was passed over by a different CLI version (so newer harness
support or rules get a second look). `--retry-rejected` makes sessions the backend refused pending
for that run. Nothing is skipped for good by being older than something else, and there is no count
cap on the scan: listing is metadata only. Claude Code sessions are listed from `~/.claude` and,
when the variable is set, `CLAUDE_CONFIG_DIR`. Codex sessions are listed from `sessions/` and
`archived_sessions/` under `CODEX_HOME` (default `~/.codex`). Each run settles at most 20 sessions, oldest first;
`--bootstrap` keeps going until the backlog is drained. Entries are pruned a week after their session
leaves the 30-day window.

| Outcome | Meaning |
|---|---|
| `shipped` | Accepted by the ingest API (202) |
| `trivial` | No user record, nothing answering it, or under 2,000 characters of content |
| `incognito` | `/dosu-incognito` was run in the session |
| `rejected` | The backend refused the payload (HTTP 400, 413, or 422) |
| `unsupported` | No normalizer for the harness, or the transcript could not be normalized |
| `skipped_by_user` | You declined setup's offer to ship the last 30 days (it offers only sessions the ledger has never settled) |

Only transport errors, auth failures, and 5xx responses are failures: they stop the run, leave the
session pending, and make hook runs back off (except for a just-ended session, below). `rejected`
and `unsupported` are answers, so one unreadable session never stalls the rest.
`dosu knowledge sync --status` shows counts per outcome and the rejected and unsupported sessions
grouped by reason; `dosu knowledge sessions --rejected` (or `--unsupported`) lists every one.

**Worthiness** is judged on what would ship: the normalized, redacted trajectory. Text, tool
arguments, and tool results all count toward the 2,000 characters, so a terse run that did its work
through tools ships; the meta record does not count.

**Quiet period.** A session updated in the last five minutes may still be running, so it waits for a
later run. The exception is a session the hook says just ended: the `--detach` parent reads the hook
payload and passes the session to the detached run as `--ended <harness>:<id>=<transcript>` (one
value per session, so two sessions' transcripts never get swapped; `--ended-path <transcript>` names
a session known only by its transcript). That session ships in the same run, past the quiet period
and ahead of the backlog, together with the subagent sessions it spawned, which ended with it (Codex
fires `SessionEnd` for the root session only), even if its transcript lives outside the directories the scan walks. A
transcript outside the default directories (including one this run lists only because the agent
exported `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, which a sync started elsewhere lacks) is remembered in
the state file (`outside_sessions`) until it is gone or leaves the window, so later runs retry it
after a failure and ship its tail when it is resumed. If another run holds the sync lock, the run
waits for it (up to ten minutes) instead of leaving the session for a later trigger. A paused hook
run ships nothing, but still remembers where an ended session lives. While hook runs back off after
a failure, a run carrying an ended session still tries that session, and only that one; if it gets
through, the backoff ends. Only definitive end events count: Claude Code's `SessionEnd`, and
Codex's `SessionEnd` (0.160+), whose session is named by its rollout file as the scan names it.
Per-turn events (Cursor's `stop`, Codex's `Stop`) never pass `--ended`. Each agent's end event is
one reader in `END_EVENT_READERS` (`src/sessions/capture.ts`).

**Resumed sessions.** For a shipped session the ledger also keeps how many normalized records went
and a sha256 of them. When the session grows and its records still start with exactly that prefix,
only the meta record and the new tail ship, with `metadata.continuation =
{"from_record": n, "prefix_sha256": "..."}`. A new tail too small to learn from is not uploaded and
the session stays shipped. If the prefix no longer matches, the whole session ships again and the
server dedupes identical content. A child session's upload carries `parent_session_id`: for a
Codex subagent (`thread_source: "subagent"` in its rollout's `session_meta`), the parent's rollout
name, which is the parent's own `session_id`. The report a finished Codex subagent hands its parent,
a `<subagent_notification>` injected as a user message, ships in the parent's trace in place as an
`observation` record: what the parent acted on next, not something the user said.

Upgrading from the watermark state (schema 2, or the learner-era schema 1) seeds the ledger with the
sessions it shipped. Everything else in the window becomes pending again, including sessions the
watermark passed over without shipping; the server dedupes anything it already has. Clearing the
history on the Activity screen empties the ledger the same way.

## Project key

Every upload, and every prompt-time memory request, carries a `project` key naming the codebase the
session worked in (`repo` repeats it for servers that predate `project`). Memory is scoped by it
when the deployment has no linked repository. For a working directory, the first rule that applies
wins:

1. A directory linked in `~/.config/dosu-cli/projects.json`
   (`{"links": [{"dir": "/abs/path", "project": "<key>"}]}`), longest match.
2. The `DOSU_PROJECT` environment variable.
3. The `origin` remote, normalized (`github.com/acme/widget`).
4. `git:<sha>` of the repository's root commit, for clones without an `origin`. Skipped in a shallow
   clone, whose oldest commit is only where the clone was cut.
5. `path:<git top level, or the directory itself>`.

A session's key is cached in `project-dirs.json` the first time it is resolved, whichever rule
produced it, so a checkout deleted later still resolves and a session never changes projects
midway. The prompt hook resolves it first for Claude Code and Codex sessions, so the transcript
ships under the same project it was served memory for. A link added later applies to sessions not yet
resolved (the unshipped backlog), not to ones already served or shipped. Only a `path:` answer is
looked up again once the session file changes, since the directory may have become a repository.
A git lookup that runs out of time is no answer, never a reason to fall back to `path:`: the prompt
hook, which keeps the prompt waiting, then sends no key for the rest of that session, and the sync,
which can wait minutes, resolves it. A root commit found once is reused for later sessions in the
same directory while the repository still has it, so the long walk happens once.

`DOSU_PROJECT` counts only in the session's own agent's environment: the prompt hook, and the
session-end hook for the session that just ended (`--ended`). A sync shipping a batch runs in
whichever agent's environment triggered it, so it never applies its own `DOSU_PROJECT` to the rest
of the batch. To key a backlog of sessions that ran without the variable, link their directory
instead.

## Repo scope

A session's repo is the `origin` remote of its working directory, normalized to a `host/owner/repo`
key (`git@github.com:dosu-ai/dosu-cli.git` → `github.com/dosu-ai/dosu-cli`). A session outside a
repo, or in a repo without an `origin`, has no repo. The lookup is cached per session in
`project-dirs.json`, so a checkout deleted later still resolves. Cursor's transcripts record no
working directory, so its `stop` hook records it to `session-captures/cursor/<id>.json` before the
detached sync starts.

`dosu` → settings → study scope picks which repos to ship (`repo_filter` in the state file). With a
repo scope, only sessions in the picked repos are shipped. Picking every repo clears the filter, so
new repos and sessions outside any repo are shipped too. Clones and worktrees of the same repo share
one entry.

Before repo scoping, the scope was a list of folders (`project_filter`). The next sync converts it
to the repos its folders' sessions ran in, so upgrading never widens the scope. A folder scope with
no repos in it becomes an empty repo scope, which ships nothing until you pick repos again.

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

- `dosu knowledge sync` never uploads a session whose transcript contains the marker (or Claude
  Code's `<command-name>/dosu-incognito</command-name>` record). It is settled in the ledger as
  `incognito`, so it is not re-read until it changes. The debug log records
  `not shipping incognito session <harness>/<id>` and the run summary counts it as passed over.
- The Activity screen and `dosu knowledge sessions` set them aside from the queue.

Properties worth knowing:

- It covers the **whole session**, including turns before the command was run, since the transcript
  is skipped as a unit.
- It is **one-way** for that session. Start a new session to have Dosu learn again. Resuming the
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
| `📚 Dosu learning…` | The hook is installed and this session ships to Dosu memory when it ends |
| `👻 Dosu incognito` | `/dosu-incognito` was run in this session |
| `⚪ Dosu paused` | Syncing is paused (Activity screen stop, or `paused` in the state file) |
| `⚪ Dosu not learning from this repo` | A repo scope is set and `cwd` is not in one of its repos |
| `⚪ Dosu off` | No Dosu hook is installed for this agent, or shipping is disabled |

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
# Open Claude Code in a synced repo → 📚 Dosu learning…
# Run /dosu-incognito → 👻 Dosu incognito
# End the session; `dosu logs --tail` shows "not shipping incognito session claude/<id>" right away
```
