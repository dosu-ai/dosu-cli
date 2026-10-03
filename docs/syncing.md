# Syncing sessions to Dosu memory

`dosu knowledge hooks enable` installs a session-end hook (Claude Code, Cursor, Codex), for
OpenCode a plugin (see [OpenCode](#opencode)) and for pi the Dosu pi extension (see [Pi](#pi)),
each running `dosu knowledge sync --quiet --detach`; for Claude Code it also installs the prompt-time memory hook
(`UserPromptSubmit` → `dosu knowledge context`) unless transcript shipping is off, and `disable`
removes both. With no agent named it installs for every agent it detects and names the ones it
skipped. Claude Code counts as detected when `~/.claude` (or `CLAUDE_CONFIG_DIR`) exists or
`claude` is on PATH, so a freshly provisioned machine can set Dosu up before Claude Code's first
run (which is what creates `~/.claude`); `dosu knowledge transcripts enable` and `dosu setup` detect
it the same way, and say so when they skip it. The sync scans the last 30 days of agent sessions, keeps the
ones its ledger has no answer for, applies the repo scope and pause switch from
`~/.config/dosu-cli/knowledge-sync.json`, and ships them to Dosu memory (secrets redacted locally
first), which learns from each session server-side. Shipping is on by default;
`dosu knowledge transcripts disable` turns it off. This document covers how a sync decides what to
ship, the project key sessions are scoped by, the repo scope, and the two switches layered on top:
a per-session opt-out and a status-bar indicator. On a machine torn down after its last task, run
`dosu knowledge sync --flush` as the last step (see [Throwaway machines](#throwaway-machines)).

## Codex hooks

`dosu knowledge hooks enable codex` writes `$CODEX_HOME/hooks.json` (default `~/.codex`) for the
`codex` on PATH, so re-running it after a Codex upgrade converges on the right set. Codex counts as
installed (for `hooks enable` with no agent named, and for `dosu setup`) when its home exists or
`codex` is on PATH: Codex creates its home on its first run, which on a fresh machine comes after
Dosu's setup.

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

When `SessionEnd` fires is up to Codex. `codex exec` fires it as the run ends, on SIGINT too, but
not when killed with SIGTERM (what a task runner's timeout sends). The 0.160 TUI, in its default
mode, talks to a shared background server: `/quit` only disconnects, and `SessionEnd` fires when the
server unloads the thread, `thread_unload_delay_secs` later (config.toml, default 60). That hook runs
in the background server's environment (its PATH and `DOSU_PROJECT`, from the TUI that started it),
not the quitting TUI's. A session that misses its `SessionEnd` ships with a later run once it has
been quiet for five minutes, which a throwaway machine never reaches: end it with
`dosu knowledge sync --flush` (see [Throwaway machines](#throwaway-machines)).

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
`--bootstrap` and `--flush` keep going until the backlog is drained. Entries are pruned a week after their session
leaves the 30-day window.

| Outcome | Meaning |
|---|---|
| `shipped` | Accepted by the ingest API (202) |
| `trivial` | No user record, nothing answering it, or under 2,000 characters of content |
| `incognito` | `/dosu-incognito` was run in the session |
| `rejected` | The backend refused the payload (HTTP 400, 413, or 422) |
| `unsupported` | No normalizer for the harness, or the transcript could not be normalized |
| `skipped_by_user` | You declined setup's offer to ship the last 30 days (it offers only sessions the ledger has never settled), or ran `dosu knowledge skip-backlog` |

Only transport errors, auth failures, and 5xx responses are failures: they stop the run, leave the
session pending, and make hook runs back off (except for a just-ended session, below). `rejected`
and `unsupported` are answers, so one unreadable session never stalls the rest.
`dosu knowledge sync --status` shows counts per outcome and the rejected and unsupported sessions
grouped by reason; `dosu knowledge sessions --rejected` (or `--unsupported`) lists every one.

**Subagents.** Claude Code writes each subagent's conversation to its own transcript,
`<project>/<session id>/subagents/agent-<agent id>.jsonl` (a workflow's agents one level down, in
`subagents/workflows/<workflow id>/`). The sync lists every one as a session of its own
(`claude/agent-<agent id>`), normalizes it on its own, and ships it with
`metadata.parent_session_id` set to the session it worked for (the top-level session, for a nested
subagent too). It is settled in the ledger on its own, so it can be trivial while its session ships,
but it inherits what its session decided: a session-end hook for the session ships its subagents in
the same run, right after the session and however many there are (the per-run batch limit of 20
applies only to the rest of the backlog), `/dosu-incognito` in the session keeps them out, and they
ship under the session's project key. A subagent's transcript waits as long as its session does
(until the session ends or has been quiet for five minutes), however long ago the subagent itself
finished, so it never ships ahead of the session or before an opt-out later in it. Views count
sessions, not transcripts: `--status`, `transcripts status`, `knowledge sessions`, the Activity
screen, and setup's backfill offer count a session's subagents with it and report them apart
("Subagents: 2 shipped", `subagent_counts` in JSON), and `total_shipped` counts sessions only.

A background subagent (or background shell command) reports back by injecting a
`<task-notification>` message, carrying its result, into the session. The trajectory normalizer
drops those as harness noise, but they are what the model acted on next, the way a foreground
subagent's result is its tool result. So the CLI keeps each one in place as an `observation`
record (input the agent received that nobody typed): the session's trace stays readable on its own,
and the subagent's full work ships separately, linked by `parent_session_id`. When the session is
busy as the notification arrives (the usual case interactively), Claude Code queues it and logs it
as an `attachment` row (`queued_command`), which the normalizer skips entirely; the CLI turns those
back into the input they stand for. The same goes for a message the user typed mid-turn, which
ships as a user record, and one from another agent session, which ships as an observation.

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
through, the backoff ends. Only definitive end events count: Claude Code's `SessionEnd`, Codex's
`SessionEnd` (0.160+), whose session is named by its rollout file as the scan names it, the exit of
the opencode process that ran an OpenCode session, and pi's `session_shutdown` as the Dosu pi
extension reports it. Per-turn events (Cursor's `stop`, Codex's `Stop`, OpenCode's `session.idle`)
never pass `--ended`. Each agent's end event is one reader in `END_EVENT_READERS`
(`src/sessions/capture.ts`), except OpenCode's: its plugin passes `--ended` itself. `--flush` lifts
the quiet period for every session (see [Throwaway machines](#throwaway-machines)).

**Resumed sessions.** For a shipped session the ledger also keeps how many normalized records went
and a sha256 of them. When the session grows and its records still start with exactly that prefix,
only the meta record and the new tail ship, with `metadata.continuation =
{"from_record": n, "prefix_sha256": "..."}`. A new tail too small to learn from is not uploaded and
the session stays shipped. If the prefix no longer matches, the whole session ships again and the
server dedupes identical content. A child session's upload carries `parent_session_id`: for a
Codex subagent (`thread_source: "subagent"` in its rollout's `session_meta`), the parent's rollout
name, which is the parent's own `session_id`. The report a finished Codex subagent hands its parent,
a `<subagent_notification>` injected as a user message, ships in the parent's trace in place as an
`observation` record: what the parent acted on next, not something the user said. A subagent spawned
with its parent's context starts its rollout with a copy of the parent's history; on 0.160 (whose
rollouts mark where the subagent's own records begin, `subagent_history_start_ordinal`) only the
subagent's own records ship, since the parent's trace carries the rest. Older rollouts have no such
mark and ship whole.

**Forks.** A session forked or cloned from another (`AgentSession.forkOf`; pi's `/fork`, `/clone`,
`--fork`) opens with a verbatim copy of that session's history, which is the parent's to ship.
Its upload carries `parent_session_id` and only what the fork added: the meta record and the
records past the leading ones the parent's normalized records hold too, marked with
`continuation` as a tail is (`from_record` is where the fork's own records start). A fork with
nothing of its own yet is too small to learn from, and ships once it has more. A fork is not a
subagent: it outlives the session it came from, so that session's end neither ships nor holds it.

Upgrading from the watermark state (schema 2, or the learner-era schema 1) seeds the ledger with the
sessions it shipped. Everything else in the window becomes pending again, including sessions the
watermark passed over without shipping; the server dedupes anything it already has. Clearing the
history on the Activity screen empties the ledger the same way.

## Claude Code in an eval harness

On a throwaway machine, set Dosu up before Claude Code's first run (`dosu knowledge hooks enable`
detects it from `claude` on PATH), then run sessions as usual. Dosu learns from a `claude -p`
session through two user-level hooks in `~/.claude/settings.json` (`UserPromptSubmit` for
prompt-time memory, `SessionEnd` to ship the session the moment it ends) and the transcript Claude
Code writes under `~/.claude/projects`. Some flags switch those off. Checked with Claude Code
2.1.286 in `-p` mode:

| Passed to `claude` | Prompt-time memory | Ships when it ends | Transcript written |
|---|---|---|---|
| none of the below | yes | yes | yes |
| `--bare` (also `CLAUDE_CODE_SIMPLE=1`) | no | no | yes |
| `--safe-mode` (also `CLAUDE_CODE_SAFE_MODE=1`) | no | no | yes |
| `--restricted` | no | no | yes |
| `--setting-sources` without `user` | no | no | yes |
| `--settings '{"disableAllHooks": true}'` (or that key in any settings file) | no | no | yes |
| `--no-session-persistence` | yes | the hook runs, but there is nothing to ship | no |

So an eval harness must not pass `--no-session-persistence` at all, and should not pass the others:
they skip user hooks, so the session gets no memory at prompt time and does not ship when it ends.
(`--strict-mcp-config` without Dosu in its `--mcp-config` also drops the Dosu MCP tools.) A session
that wrote a transcript still ships with a later sync once it has been quiet for five minutes, which
a machine torn down right after the run never reaches. If a harness cannot drop those flags, it can
ship each session itself as soon as `claude` returns, using the `session_id` from
`--output-format json`:

```bash
dosu knowledge sync --ended claude:<session_id>
```

That ships the session and its subagents at once, past the quiet period. Or ship everything at the
end with `dosu knowledge sync --flush` (see [Throwaway machines](#throwaway-machines)).

## Throwaway machines

A VM or container destroyed after its last task gets no later sync, so make this its last step,
after the last agent has exited:

```bash
dosu knowledge sync --flush
```

End events ship most sessions at once, but not all: Codex killed with SIGTERM fires no `SessionEnd`,
Codex before 0.160 and Cursor have only per-turn events, pi run with `--no-extensions` loads no
extension to report its end, and the sync a hook starts runs detached, where a teardown can cut it
short. A flush ships every pending session now, with its subagents, past the five-minute quiet
period. It drains the backlog batch by batch in the foreground (`--detach` is refused), and when
another sync holds the lock, such as one a session-end hook just started, it waits for it (up to ten
minutes) instead of skipping. It is an explicit command even with `--quiet`, which then only
silences it: it resumes a paused sync and does not wait out a failure backoff. It still leaves out
incognito sessions, sessions too small to learn from, and repos outside the repo scope, and ships
nothing while `dosu knowledge transcripts disable` is in effect. If an upload fails, it stops with
the rest still pending and, without `--quiet` or `--json`, exits 1. A session still running when the
flush starts ships what it has so far; were the machine to live on, the rest would ship later as a
tail.

## Project key

Every upload, and every prompt-time memory request, carries a `project` key naming the codebase the
session worked in (`repo` repeats it for servers that predate `project`). Memory is scoped by it
when the deployment has no linked repository. For a working directory, the first rule that applies
wins:

1. A directory linked in `~/.config/dosu-cli/projects.json`
   (`{"links": [{"dir": "/abs/path", "project": "<key>"}]}`), longest match. Manage links with
   `dosu project link [dir] <key>` and `dosu project unlink [dir]`; `dosu project show [dir]` prints a
   directory's key and the rule that produced it.
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

Memory pulled over MCP is scoped by the same key. Every agent's Dosu MCP entry runs the local
proxy, `dosu mcp serve --client <agent>`, which resolves the key once for the directory the agent
started it in and sends it as `x-dosu-project` (and `x-dosu-repo`, for older servers) with every
request, along with the branch checked out at that moment (`x-dosu-branch`) and the agent
(`x-dosu-client`). When that directory has no key of its own (no link, no `DOSU_PROJECT`, not in
a checkout), as when a GUI host such as Cursor or Claude Desktop starts a global server in `/` or
the home directory, the proxy asks an agent that supports MCP roots for its workspace roots and
scopes the session by the first local one instead. `dosu memory search` and `dosu memory evidence`
send the same headers from the current directory. A value with characters outside ASCII (a linked key, a checkout path, a branch
name) goes as an RFC 8187 value, `UTF-8''` followed by its percent-encoded UTF-8, which the server
decodes; any other value goes as it is.

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
one entry. A script sets the same scope from checkouts on disk:

```bash
dosu knowledge scope set <checkout>...   # ship only these checkouts' repos (by origin remote)
dosu knowledge scope clear               # ship every repo, and sessions outside any repo
dosu knowledge scope show [--json]
```

`set` replaces the scope and refuses a directory without an `origin`, since a repo scope can only
name repositories by their origin; a session in a clone without one is never in a repo scope,
whatever its project key.

`dosu knowledge skip-backlog [--before <date>]` makes setup's other choice, declining the 30-day
backfill, from a script: every session waiting to ship now (or, with `--before`, last active before
that date) is settled as `skipped_by_user`, and only sessions that finish or change from then on
ship. It ships nothing, works while shipping is switched off (so a script can set the starting
point before turning shipping on), and leaves sessions outside the repo scope unsettled, for a later
scope that includes them to decide. A skipped session stays skipped until it changes; to ship it
after all, clear the shipping history on the Activity screen and run
`dosu knowledge sync --bootstrap`.

Before repo scoping, the scope was a list of folders (`project_filter`). The next sync converts it
to the repos its folders' sessions ran in, so upgrading never widens the scope. A folder scope with
no repos in it becomes an empty repo scope, which ships nothing until you pick repos again.

Both are installed by default: `dosu setup` (and the TUI's configure step) enables the status line
and the slash command for every agent it enables the sync hook for, and removes them when an agent
is unticked. A hook that fails to install skips the bundle. The commands below manage them directly.

## OpenCode

OpenCode keeps its sessions in a sqlite DB (`$XDG_DATA_HOME/opencode/opencode.db`) and has no
command hooks, so it gets its own reader and a plugin.

**Reading sessions.** Every session row is listed, a subagent's child session (`parent_id` set) as
its own session that ships with `parent_session_id`. The trajectory adapter reads the whole-session
document `opencode export <id>` prints, so the shipper asks the opencode binary on PATH for it
(`opencode export --pure`, which skips plugins, Dosu's included); without one, or when it fails, the
same document is rebuilt from the `session`, `message`, and `part` rows. Both normalize to the same
records. A child session is incognito when the session that spawned it is.

**The plugin.** `dosu knowledge hooks enable opencode` (and `dosu setup`) writes
`$XDG_CONFIG_HOME/opencode/plugin/dosu.js` and the `/dosu-incognito` command; `disable` removes
both, and the directories it made for them if they are left empty. A `plugin/dosu.js` that is not
Dosu's is never replaced: enable stops with an error instead. OpenCode counts as installed when its
config or data dir exists, or, on a machine where it has never run, when `opencode` is on PATH.
The plugin is plain JavaScript importing only node builtins, and does three things:

- When the opencode process exits, however it exits (`opencode run` finishing or interrupted; the
  TUI quitting; `opencode serve`, and the SDK, web UI, and `run --attach` built on it, stopped by
  any signal, SIGKILL included), one `dosu knowledge sync --quiet --detach` runs with
  `--ended opencode:<id>` for every session that ran a turn in it, so each ships right away. The
  first turn starts a detached watcher that reads session ids from a pipe only the opencode process
  writes to; the kernel closes the pipe when that process exits, which ends the watcher's input and
  starts the sync. opencode's own `dispose` hook is not used: a server killed by a signal never
  runs it, and a live process runs it whenever it reloads an instance (`/connect`, a config
  change), which ends nothing. Nor is `session.idle` an end: the TUI fires it after every turn,
  and a subagent's session fires it when its task returns. A session left idle in a long-lived TUI
  or server ships with a plain sync (no session named) that the plugin runs 5.5 minutes after the
  last turn went idle, once that session is past the quiet period.
- Before a prompt is saved or sent (`chat.message`), it runs
  `dosu knowledge context --agent opencode --format plain` with `{"prompt", "session_id", "cwd"}` on
  stdin and appends the digest, if any, to the user message as a synthetic text part flagged
  `metadata.dosu_memory`. The shipper drops that part, so memory never ships back as something the
  user said. Incognito sessions (including one resumed in a later process) and subagents' sessions
  are not asked about.
- `/dosu-incognito` is an opencode custom command whose prompt carries the marker.

OpenCode 1.18 starts an npm install of `@opencode-ai/plugin` into its config dir on every start until
that dir has a `node_modules`, plugin or not; with any local plugin it waits for the install before
loading plugins, whether or not they import the package (Dosu's does not). That needs registry
access once (it honors `npm_config_registry`, so a mirror works). With no registry reachable, every
start waits for the install to fail (about 70 seconds against a refused connection), then loads the
plugin anyway.

## Per-session incognito

```bash
dosu knowledge incognito enable            # all detected agents
dosu knowledge incognito enable claude     # or one of: claude, cursor, codex, opencode
dosu knowledge incognito status [--json]
dosu knowledge incognito disable [agents...]
```

`enable` writes a command file per agent:

| Agent | Run it as | File |
|---|---|---|
| Claude Code | `/dosu-incognito` | `~/.claude/commands/dosu-incognito.md` (honors `CLAUDE_CONFIG_DIR`) |
| Cursor | `/dosu-incognito` | `~/.cursor/commands/dosu-incognito.md` |
| Codex | `$dosu-incognito` | `~/.codex/skills/dosu-incognito/SKILL.md` (honors `CODEX_HOME`) |
| OpenCode | `/dosu-incognito` | `~/.config/opencode/command/dosu-incognito.md` (honors `XDG_CONFIG_HOME`) |

Running the command inside a session expands the file into the conversation. Its body carries
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
- It carries over to a Codex session's **subagents and forks**, whose rollouts hold no marker of
  their own (a subagent's starts with the parent's history only when spawned with it; a fork's on
  0.160 references its source instead of copying it): a rollout whose `session_meta` names a
  `parent_thread_id` or `forked_from_id` is off the record when any rollout up that chain carries
  the marker, for shipping and for the prompt-time memory hook alike.
- The command **instructs** the model to avoid Dosu tools; it does not block them. A `PreToolUse`
  hook that rejects Dosu tool calls when the marker is present is a possible follow-up.
- An OpenCode subagent's session is incognito when the session that spawned it is.
- Pi's `/dosu-incognito` comes with the Dosu pi extension rather than this command (see [Pi](#pi)).
- The marker itself works anywhere: a prompt containing `dosu:incognito:v1` takes its session off
  the record in any agent, with or without the command installed.

### Codex: `$dosu-incognito`

Codex has no user slash commands: 0.140 and 0.160 run only their built-in `/` commands and no longer
load custom prompts (`~/.codex/prompts`, where CLIs before this one installed the command; `enable`
removes that file). What a user can invoke is a skill, so the command is the skill
`$CODEX_HOME/skills/dosu-incognito`, run by mentioning it: type `$dosu-incognito` in the TUI (the
`$` menu lists it) or anywhere in a `codex exec` prompt. Codex adds the skill's text to the
conversation as a user turn, so the rollout carries the marker. The skill sets
`allow_implicit_invocation: false` in `agents/openai.yaml`: Codex leaves it out of the skills it
lists to the model, which therefore never opens it on its own and carries the marker into a session
the user did not take off the record. It lives under `$CODEX_HOME/skills` rather than
`~/.agents/skills`, which other agents read too. `/dosu-incognito` typed into Codex is an
unrecognized command.

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

## Pi

Pi has no hook config, so `dosu knowledge hooks enable pi` (and `dosu setup`, which lists pi as an
agent; `dosu mcp add pi` does the same) writes one extension, `<agent dir>/extensions/dosu.ts`
(`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), which pi discovers on its next start or `/reload`. Pi
counts as installed when that directory exists or `pi` is on PATH, so a machine provisioned before
pi's first run (which creates the directory) gets the extension too. It is a single file rather
than a pi package: `pi install` needs pi on PATH, network or a second
directory, and an edit to pi's `settings.json` to undo; the extensions folder works offline in a
throwaway VM.
`hooks disable pi` deletes it, and neither command touches a `dosu.ts` that is not Dosu's. The
extension shells out to `dosu` on PATH for everything, so it carries no credentials:

- `session_shutdown` (quit, `/new`, `/resume`, `/fork`; not `/reload`, which keeps the session)
  pipes `{hook_event_name: "session_shutdown", agent: "pi", session_id, transcript_path, cwd}` to
  `dosu knowledge sync --quiet --detach`, so the session ships right away. Pi waits at most 3 s for
  that process to take the payload, never for the upload.
- `before_agent_start` asks `dosu knowledge context --agent pi --format plain` for a digest and adds
  it to the run as a hidden custom message (`customType: "dosu-memory"`), which the trajectory
  normalizer does not ship back.
- `search_memory` and `get_memory_evidence` are pi tools that run
  `dosu memory search|evidence --client pi -- <arg>` in the session's directory.
- `/dosu-incognito` sends the incognito marker as the user's own message (which is what keeps the
  session from shipping), removes the two memory tools from the model's tool set, and stops digests;
  a resumed incognito session stays off. For pi only the user's turns are searched for the marker,
  so a session whose model read a file quoting it still ships. A fork or clone of an incognito
  session (or of a fork of one, at any depth) stays off too, in the extension and in the sync, even
  when it was forked from a message before the marker: it holds what the session did off the
  record and carries on from there.

Pi started with `--no-extensions` (`-ne`) loads none of this: no digest, no tools, and its sessions
ship only on a later sync once they have been quiet for five minutes, or with
`dosu knowledge sync --flush` (an explicit
`-e ~/.pi/agent/extensions/dosu.ts` still loads it). Every failure, a missing `dosu` included,
leaves pi running as if Dosu were not installed.

Pi keeps sessions at `<agent dir>/sessions/--<cwd>--/<timestamp>_<session id>.jsonl`; the scan lists
them under `~/.pi/agent` and `PI_CODING_AGENT_DIR`, plus the flat folder a
`PI_CODING_AGENT_SESSION_DIR` or absolute `sessionDir` setting points at, keyed `pi/<session id>`
with the id from the transcript's header (the one `PI_SESSION_ID` carries), whatever the file is
called. Ids pi accepts with dots (`pi --session-id rv.task.2`) end their session like any other, and
a transcript at an explicit `pi --session <path>` outside those folders ships when its session
ends and is remembered for later syncs. The header's `cwd` gives the project key, and a
`/fork`, `/clone` or `--fork` names the transcript it copied there, so it ships as a fork (see
[Forks](#what-a-sync-ships)): with `parent_session_id`, without the copied history.

## Manual check

```bash
DOSU_DEV=true bun run dev knowledge statusline enable claude
DOSU_DEV=true bun run dev knowledge incognito enable claude
# Open Claude Code in a synced repo → 📚 Dosu learning…
# Run /dosu-incognito → 👻 Dosu incognito
# End the session; `dosu logs --tail` shows "not shipping incognito session claude/<id>" right away
```
