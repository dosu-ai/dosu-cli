# Syncing sessions to Dosu memory

`dosu knowledge hooks enable` installs a session-end hook (Claude Code, Cursor, Codex), for
OpenCode a plugin (see [OpenCode](#opencode)) and for pi the Dosu pi extension (see [Pi](#pi)),
each running `dosu knowledge sync --quiet --detach`; for Claude Code it also installs the prompt-time memory hook
(`UserPromptSubmit` → `dosu knowledge context`) unless transcript shipping is off. Every agent's
`enable` also installs its incognito command (`/dosu-incognito`, `$dosu-incognito` in Codex; see
[Per-session incognito](#per-session-incognito)), so the way to keep a session out is there before
the first session ships, and `disable` removes everything `enable` installed, except that the
incognito command stays while transcript shipping is on: any sync (another agent's hook, a
`--flush`) still ships every agent's sessions, hooks or not, so `disable` says it kept the command
and that `dosu knowledge incognito on <agent>` keeps all of that agent's sessions out (see
[Per-agent incognito](#per-agent-incognito)). Pi's command is part of its extension and goes with
it; `hooks disable pi` says that pi's sessions still ship and that `dosu knowledge incognito on pi`
keeps them out. `hooks status` says
when the command is missing (as an older CLI left it). With no agent named it installs for every
agent it detects and names the ones it skipped. Claude Code counts as detected when `~/.claude` (or `CLAUDE_CONFIG_DIR`) exists or
`claude` is on PATH, so a freshly provisioned machine can set Dosu up before Claude Code's first
run (which is what creates `~/.claude`); `dosu knowledge transcripts enable` and `dosu setup` detect
it the same way, and say so when they skip it. The sync scans the last 30 days of agent sessions, keeps the
ones its ledger has no answer for, applies the repo scope and pause switch from
`~/.config/dosu-cli/knowledge-sync.json`, and ships them to Dosu memory (secrets redacted locally
first), which learns from each session server-side. Shipping is on by default;
`dosu knowledge transcripts disable` turns it off. This document covers how a sync decides what to
ship, the project key sessions are scoped by, the repo scope, and the switches layered on top: a
per-agent incognito setting, a per-session opt-out, and a status-bar indicator. On a machine torn
down after its last task, run `dosu knowledge sync --flush` as the last step (see
[Throwaway machines](#throwaway-machines)).

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
leaves the 30-day window, except those the per-agent incognito switch settled (see
[Per-agent incognito](#per-agent-incognito)).

| Outcome | Meaning |
|---|---|
| `shipped` | Accepted by the ingest API (202) |
| `trivial` | No user record, nothing answering it, or under 2,000 characters of content |
| `incognito` | `/dosu-incognito` (`$dosu-incognito` in Codex) was run in the session |
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
hook, which keeps the prompt waiting, then sends no key (and no branch, nor asks git for one) for
the rest of that session, and the sync, which can wait minutes, resolves it. A root commit found once is reused for later sessions in the
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
send the same headers from the current directory. Run from an agent's shell, they name the agent
session the call comes from by what the agent sets for the commands it runs (Claude Code
`CLAUDE_CODE_SESSION_ID`, Codex `CODEX_THREAD_ID`, OpenCode `DOSU_OPENCODE_SESSION` through Dosu's
plugin, pi `PI_SESSION_ID` and `PI_SESSION_FILE`; `--session` overrides, `--client` looks only at
that agent's), and send nothing when that session, or one it was started from, is off the record.
An agent started from another's shell inherits the outer one's variable too; its calls are then
named under neither session. A value with characters outside ASCII (a linked key, a checkout path, a branch
name) goes as an RFC 8187 value, `UTF-8''` followed by its percent-encoded UTF-8, which the server
decodes; any other value goes as it is.

## Branch

Every upload, and every prompt-time memory request, also carries the branch the session ran on
(`metadata.branch`, and `branch` on the prompt request), which memory is scoped by beside the
project. An upload sends the branch its transcript recorded, when it recorded one: Claude Code's
`gitBranch` and Codex's `session_meta`, as the trajectory's `git_branch` (the value the server
read before the CLI sent one), verbatim: redaction leaves the branch alone, as it does ids, since
its entropy pass takes a Jira-style name like `feature/PROJ-4821-AddRetryLogicForPayments` for a
secret, and a placeholder would scope every such session together. OpenCode, pi and Cursor record
none, so their sessions ship with the branch their prompts were served under, else the one the
session's directory had checked out at its first prompt, read from the reflog, so a session that
starts a branch for its change ships with the branch it started from, as Claude Code and Codex
sessions do (a fork's first prompt is its own, not the one it copied). Cursor's transcripts carry
no times, so the reflog is asked about its first turn, when its `stop` hook first captured the
session, and the branch that capture recorded serves when the reflog cannot answer; later turns
change neither. The branch checked out now counts only when the reflog shows no checkout since.
A detached HEAD is no branch, and the upload then sends none.

Like the project key, a session's branch is cached in `project-dirs.json` the first time it is
resolved: the first prompt pins the branch checked out then, the session's later prompts send
that one even after a checkout, and its transcript ships with it, the tail of a resumed session
included. A session the prompt hook first serves partway through (the hook went in, or Dosu was
set up, after it began, and it was resumed on another branch) is read the way its upload will
be: the transcript the payload names (Claude Code, Codex, pi) or opencode's DB (read directly,
without starting opencode) gives the branch it recorded, else when its first prompt was, and the
reflog answers for then; only a session's first prompt takes the branch checked out now.

## Repo scope

A session's repo is the `origin` remote of its working directory, normalized to a `host/owner/repo`
key (`git@github.com:dosu-ai/dosu-cli.git` → `github.com/dosu-ai/dosu-cli`). A session outside a
repo, or in a repo without an `origin`, has no repo. The lookup is cached per session in
`project-dirs.json`, so a checkout deleted later still resolves. Cursor's transcripts record no
working directory, so its `stop` hook records it to `session-captures/cursor/<id>.json` before the
detached sync starts, with the time and branch of the session's first turn.

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
the plugin, the command once transcript shipping is off (see above), and the directories it made
for them if they are left empty. A `plugin/dosu.js` that is not
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

## Per-agent incognito

```bash
dosu knowledge incognito on                 # all detected agents
dosu knowledge incognito on cursor          # or any of: claude, cursor, codex, opencode, pi
dosu knowledge incognito off [agents...]
dosu knowledge incognito status [--json]
```

`on` adds the agents' ids (their session harnesses) to `incognito_agents` in
`knowledge-sync.json`, sorted, and records when each went in under `incognito_since`; `off` removes
them, and each key goes once it is empty. While an
agent is listed, `dosu knowledge sync` sets its sessions and its subagents' transcripts aside before
the repo scope, the gate log line ("N ready, M in flight") and the batch limit. Every one past the
quiet period settles in the ledger as `incognito` with `by_agent: true`, whatever the scope and all
in the same run, without reaching the ship step; the debug log records
`not shipping incognito session <harness>/<id>: its agent is incognito` and the run summary counts
it as passed over. Settling them alone is no attempt to ship, so failure backoff stays as it was.
The sync reads the switch again once it holds the lock, so an agent put in incognito after the scan
keeps its sessions out of that run too.

A `by_agent` entry is final. A `/dosu-incognito` entry stays out because the marker is still in
the transcript, and a newer CLI re-checks it so detector fixes reach it. Nothing in a transcript
records the switch, so a `by_agent` entry is never pending again: not once the switch is off, the
session is resumed, another CLI version runs, or `--retry-rejected` is passed. It keeps no shipped
prefix (`records`, `prefix_sha256`), since nothing more of the session is ever sent.

- **Lineage.** A session whose parent (`parentId`: a Claude Code or Codex subagent, an OpenCode
  child session) or fork origin (`forkOf`: pi's `/fork`, `/clone`; a Codex fork, whose
  `session_meta` names `forked_from_id`; a Claude Code `/branch` or `--fork-session`, whose copied
  records each carry `forkedFrom`) has a `by_agent` entry is agent-incognito too, at any depth: a
  subagent or fork started after the switch is off still carries on from what its session did while
  it was on, and a branch holds a copy of it. The scan lists subagents and pi's forks; the Codex and
  Claude Code fork links are read off the transcript's head when it matters (only once the switch
  has settled some session of that agent's), and the ledger's `parent` stands in for a session no
  transcript leads to. It settles as `by_agent` in turn.
- **Resumed sessions.** When a `by_agent` session's transcript changes, the sync re-stamps the
  entry's `updated` to the new mtime and ships nothing (`incognito agents: N sessions they settled
  changed; still not shipped` in the debug log). The entry records where the transcript is
  (`path`; OpenCode's database for an OpenCode session), and pruning keeps it for as long as that
  is on disk, however long the session sits unused: a session resumed or forked months later stays
  out. It goes once the transcript does (Claude Code's own cleanup, say).
- **`off` seals first.** In the same load-modify-save that takes the agents out of the list, `off`
  settles every session of theirs active since the agent went in (`incognito_since`, which `on`
  records; for a list carried over from 0.66, which kept no time, since 0.66.0's release) that the
  ledger has no answer for its current contents (no entry, or a pending one) as `incognito` with
  `by_agent`: those still inside the quiet period, outside the repo scope, past a batch, or never
  synced (paused, backing off, shipping off, signed out), however long ago, past the 30-day window
  too. A shipped session that grew while the agent was listed is sealed too, so its incognito tail
  never ships; one that went quiet before the agent went in is left to ship. Only agents that were
  listed are sealed. If the scan fails, nothing is saved: the agents stay incognito and `off`
  reports the error and exits 1.
- The Activity screen and `dosu knowledge sessions` set a listed agent's sessions aside as
  incognito: out of the queue, the still-open list and the subagent count.
- Setup's backfill offer does not count a listed agent's sessions (the sync sets them aside before
  it reports a backlog), and `dosu knowledge skip-backlog` settles them as `by_agent` incognito
  rather than `skipped_by_user`.
- The Activity screen's clear (`resetSyncState`) keeps the list, `incognito_since` and the
  `by_agent` entries, trimmed to `updated`, `outcome`, `at`, `cli_version`, `by_agent`, `parent` and
  `path`.
- The status line shows `👻 Dosu incognito` in a listed agent, and in a session the switch settled
  once it is off (see [Status line](#status-line)).
- `status` shows each agent's switch and whether its command is installed (`--json` rows: `agent`,
  `name`, `installed`, `incognito`, `command_installed`, `invocation`, `command_path`). `on` and
  `off` reinstall the agent's incognito command when it is missing; a failure there leaves the
  switch as set.
- The list carries over from a 0.66 state file (schema 1, which kept `incognito_agents` at the top
  level) and from schema 2. So does what 0.66 promised for an agent already taken out of it: its
  learner's watermark passed that agent's sessions by unstudied, so the first sync after the upgrade
  settles every session the watermark passed since 0.66.0's release that its learner did not study
  (`mined_sessions`) and the ledger has no answer for as `by_agent` incognito, once (the state
  keeps them as `legacy_passed` until then). Trivial sessions it passed that day go with them. A state file with a schema this CLI does not know (a newer one, after a
  downgrade) starts the ledger over but keeps `incognito_agents` and `ship_transcripts: false`, so
  it never widens what ships.
- Pi switches like the others, but its `/dosu-incognito` is part of the Dosu pi extension, which
  only `hooks enable pi` (or setup) installs: `on` and `off` never install it (it would also turn on
  pi's session-end trigger, prompt-time memory and MCP server), only rewrite an extension Dosu
  already wrote, never a user's own `dosu.ts`. `status` reports pi's `command_installed` as the
  extension being installed, and says `'dosu knowledge hooks enable pi' adds it` when it is not.

Shipping is not all a listed agent keeps on the machine: it gets what `/dosu-incognito` gives one
session, so neither its prompts nor its Dosu tool calls reach Dosu. Each check reads the switch
from `knowledge-sync.json` when it runs, so `on` holds from the agent's next prompt or call, with
no restart.

- **Prompt-time memory.** `dosu knowledge context` maps its `--agent` to the agent's id
  (`claude-code` → `claude`, `codex`, `opencode`, `pi`; Claude Code's and Codex's prompt hooks,
  OpenCode's plugin and pi's extension all run it) and, when that agent is listed, sends no request
  (the prompt is the retrieval query the server logs) and prints no digest.
- **Claude Code's tool guard.** Its `PreToolUse` hook on `search_memory` and `get_memory_evidence`
  denies them with a reason that names `dosu knowledge incognito off claude` rather than
  `/dosu-incognito`, and records no session for the proxy.
- **The MCP proxy.** `dosu mcp serve --client <agent>` answers every `tools/call` itself, for any
  tool and whether or not the call names a session, with an `isError` result saying how to turn the
  switch off; nothing is relayed. `initialize` and `tools/list` still relay, as they do for
  `/dosu-incognito`, so the tools stay listed (also in OpenCode and pi, whose plugin and extension
  do not read the switch) and refuse when called. A call that names a session of a listed agent is
  refused too, whichever server it reaches.
- **`dosu memory search|evidence`** refuse, with the same message, when `--client` names a listed
  agent or a session they run in (from `--session` or the shell's environment) is one of its.
- **Sessions that ran while it was listed** stay out of all of these once it is off: a session
  whose ledger entry has `by_agent`, or one that descends from or was branched from such a session
  (for a Claude Code subagent's tool call, the session the hook payload names), gets no prompt-time
  request, and its tool calls are refused with "ran while its agent was incognito". These checks
  have no scan: they read the lineage off the session's own transcript (the rollout a Codex thread
  names, the transcript a hook payload or `PI_SESSION_FILE` names, a pi session found by the id in
  its file name, an OpenCode row), so a fork or subagent made after `off` is refused before any sync
  has settled it.
- `dosu knowledge sync --status` prints `Incognito: <agents> (not shipped)` while the list is not
  empty.

Clients with no session of their own on this machine (Claude Desktop, VS Code, Windsurf, ...) are no
agent's to switch: `incognito on claude` leaves Claude Desktop's Dosu tools working. A remote-HTTP
Dosu entry (a one-off `npx @dosu/cli setup` writes one, having no install for the proxy to run)
bypasses the proxy for `/dosu-incognito` and the switch alike; there the switch has only Claude
Code's guard.

The old `enable`/`disable` subcommands (which installed and removed the command) are gone rather
than aliased: reusing `enable` for "stop shipping" would silently change what existing scripts do.

## Per-session incognito

`dosu knowledge hooks enable` and `dosu setup` install each agent's command with its hooks, and
`dosu knowledge incognito on|off` reinstall it when it is missing. Users who enabled the hooks
before the command existed get it on upgrade: the first command on a newer CLI installs it for
every agent whose hooks are on, once (`src/version/incognito-backfill-check.ts`, marker
`incognito-backfill.json` in the config dir).

The command is a file per agent:

| Agent | Run it as | File |
|---|---|---|
| Claude Code | `/dosu-incognito` | `~/.claude/commands/dosu-incognito.md` (honors `CLAUDE_CONFIG_DIR`) |
| Cursor | `/dosu-incognito` | `~/.cursor/commands/dosu-incognito.md` |
| Codex | `$dosu-incognito` | `~/.codex/skills/dosu-incognito/SKILL.md` (honors `CODEX_HOME`) |
| OpenCode | `/dosu-incognito` | `~/.config/opencode/command/dosu-incognito.md` (honors `XDG_CONFIG_HOME`) |

Only the user runs it: the Claude Code command sets `disable-model-invocation: true` and the
Codex skill `allow_implicit_invocation: false` (in `agents/openai.yaml`), since both agents
otherwise offer their commands or skills to the model, which may run one on its own when a prompt
or project rule seems to ask for Dosu to be off. OpenCode offers custom commands to the user
only.

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
- The command **instructs** the model to avoid Dosu tools, and the CLI stops the calls it can tie
  to the session: Claude Code's `PreToolUse` hook denies the memory tools, the MCP proxy answers
  any tool call that names the session itself (Codex, Claude Code, OpenCode and pi name it; Cursor
  does not, so there the instruction is all there is), and `dosu memory` refuses.
- An OpenCode subagent's session is incognito when the session that spawned it is.
- Pi's `/dosu-incognito` comes with the Dosu pi extension rather than this command (see [Pi](#pi)).
- The marker itself works anywhere: a prompt containing `dosu:incognito:v1` takes its session off
  the record in any agent, with or without the command installed.

### Codex: `$dosu-incognito`

Codex has no user slash commands: 0.140 and 0.160 run only their built-in `/` commands and no longer
load custom prompts (`~/.codex/prompts`, where CLIs before this one installed the command;
installing the skill removes that file). What a user can invoke is a skill, so the command is the
skill `$CODEX_HOME/skills/dosu-incognito`, run by mentioning it: type `$dosu-incognito` in the TUI
(the `$` menu lists it) or anywhere in a `codex exec` prompt. Codex adds the skill's text to the
conversation as a user turn, so the rollout carries the marker. The skill sets
`allow_implicit_invocation: false` in `agents/openai.yaml`: Codex leaves it out of the skills it
lists to the model, which therefore never opens it on its own and carries the marker into a session
the user did not take off the record. It lives under `$CODEX_HOME/skills` rather than
`~/.agents/skills`, which other agents read too. `/dosu-incognito` typed into Codex is an
unrecognized command.

The prompt that runs the command (Claude Code hands its prompt hook `/dosu-incognito` as typed;
Codex expands `$dosu-incognito` anywhere in a prompt) is never sent to the prompt-time memory hook
either, even though the transcript shows the marker only after it.

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
| `📚 Dosu shipping…` | As `on`, and a knowledge-sync run is live right now (the lock check behind the TUI's "shipping sessions...") |
| `📚 Dosu on` | The hook is installed and this session ships to Dosu memory when it ends |
| `👻 Dosu incognito` | The agent is incognito (`dosu knowledge incognito on`), this session ran while it was (or descends from or was branched from one that did), or `/dosu-incognito` was run in this session |
| `⚪ Dosu paused` | Syncing is paused (Activity screen stop, or `paused` in the state file) |
| `⚪ Dosu not learning from this repo` | A repo scope is set and `cwd` is not in one of its repos |
| `⚪ Dosu off` | No Dosu hook is installed for this agent, or shipping is disabled |

States are checked from the bottom of the table up: `off` (no hook, or shipping disabled), then
incognito (the agent's switch, including a session it settled, then the transcript's marker),
paused, and the repo scope; a line
that passes them all is `on`, or `shipping…` while a sync holds the lock. Incognito outranks paused
and not-studied because it is the user's own action and the line is how they confirm it took.

Neither setup nor `enable` replaces an existing status line. If one is configured, it is left
alone and the line to add to your own script is printed instead:

```bash
printf '%s' "$input" | dosu knowledge statusline render --agent claude
```

Rendering is on the hot path (harnesses re-run the command at most every 300 ms, Cursor kills it
after 2 s), so `src/index.ts` dispatches `knowledge statusline render` before loading the rest of
the CLI, and the renderer reads only the hook config, the sync state and lock files, and the
transcript, plus one `git remote get-url origin` in `cwd` (1 s timeout) once the earlier states have
not matched. It never throws; anything unreadable renders as `⚪ Dosu off`.

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
extension runs `dosu` for everything, so it carries no credentials:

- `session_shutdown` (quit, `/new`, `/resume`, `/fork`; not `/reload`, which keeps the session)
  pipes `{hook_event_name: "session_shutdown", agent: "pi", session_id, transcript_path, cwd}` to
  `dosu knowledge sync --quiet --detach`, so the session ships right away. Pi waits at most 3 s for
  that process to take the payload, never for the upload.
- `before_agent_start` asks `dosu knowledge context --agent pi --format plain` for a digest (with
  `transcript_path` beside `prompt`, `session_id` and `cwd` once pi has a transcript, so the CLI
  can tell whether the session began before this prompt) and adds it to the run as a hidden custom
  message (`customType: "dosu-memory"`), which the trajectory normalizer does not ship back.
  The CLI gives the server 4 s and then gives up on its own; for
  every agent it records the outcome of each lookup in `debug.log` as a `[context]` line (memories
  injected, the server's reason for none, an HTTP status, or the budget running out), never the
  prompt or the digest. The extension stops only a CLI that has not answered in 10 s, which leaves
  room for a slow first start.
- `session_start` registers Dosu's MCP server with pi's built-in MCP (pi 1.0+;
  `pi.registerMcpServer`): the same `dosu mcp serve --client pi` proxy entry `dosu mcp add` writes
  for every other agent, run in the session's directory with `exposure: "direct"`, so
  `search_memory` and `get_memory_evidence` reach the model as `mcp__dosu__search_memory` and
  `mcp__dosu__get_memory_evidence`. It registers again for every session pi starts (`/new`,
  `/resume`, `/fork`, `/reload`), since a registration lasts only as long as that load of the
  extension; an incognito session (resumed, forked or cloned) does not start it. Pi tells an MCP server nothing about the session,
  and one pi serves its sessions through one proxy, so a `tool_call` handler adds
  `_dosu_session: <session id>` to the arguments of each call to those two tools, after pi has
  validated them; the proxy takes it out and sends it as `x-dosu-session`, as for OpenCode's plugin.
  The extension registers the server rather than writing it to pi's `mcp.json`, so installing,
  refreshing and removing Dosu for pi stays one file; a `dosu` entry of the user's own in
  `mcp.json` takes precedence (and gets the argument too, which only the proxy accepts).
  `dosu mcp refresh` rewrites the extension, which moves an install from the extension's own
  memory tools (before pi had built-in MCP) to the proxy. A pi without built-in MCP, or one that
  refuses the server, runs on without the tools.
- `/dosu-incognito` records the opt-out as an extension entry
  (`{type: "custom", customType: "dosu-incognito", data: {marker}}`, which is what keeps the session
  from shipping), adds a note telling the model Dosu is off (shown in the TUI), stops digests, hides
  the memory tools from the model (pi connects MCP servers in the background, so the first run of a
  session that went incognito before it waits, as pi's own MCP does, for the proxy to declare its
  tools and hides them before that run's first request), and blocks `search_memory` and `get_memory_evidence` in a `tool_call`
  handler, from any MCP server name (`mcp__<server>__<tool>`, so a user's own `mcp.json` entry for
  Dosu too) and from codemode scripts. `dosu memory search|evidence` run from the session's bash
  refuse as well, since pi names the session to the commands it runs, and the extension blocks
  such a bash command itself (pi with `--no-session` leaves the CLI no transcript to check). So none
  of the session's queries reach Dosu. A proxy already
  running stays connected, unused: a `pi -p` run that unregisters an MCP server never exits
  (pi 1.0.0). It starts no turn of its own, so it
  works the same in the TUI, mid-run, and in print mode: `pi -p "/dosu-incognito" "<task>"` runs
  the task off the record. For the same reason it does not run a task typed after it on the same
  line (`/dosu-incognito fix the tests`, unlike Claude Code's command): Dosu still goes off, and
  the extension says the task did not run, on stderr in print mode, while the TUI puts the task
  back in the editor to send with Enter. Pi saves a session only once it has a message, so a print
  run with nothing after the command saves none, and says so on stderr: a later run with the same
  `--session-id` would be a new session. A resumed incognito session stays off: no MCP server, the tools blocked. Only that entry,
  or a user turn carrying the marker (what the extension sent before it kept a record), counts, so
  a session whose model read a file quoting the marker still ships. A fork or clone of an incognito
  session (or of a fork of one, at any depth) stays off too, in the extension and in the sync, even
  when it was forked from a message before the marker: it holds what the session did off the
  record and carries on from there.

Pi started with `--no-extensions` (`-ne`) loads none of this: no digest, no MCP server, and its sessions
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
DOSU_DEV=true bun run dev knowledge hooks enable claude   # installs /dosu-incognito too
# Open Claude Code in a synced repo → 📚 Dosu on (📚 Dosu shipping… while a sync runs)
# Run /dosu-incognito, or `dosu knowledge incognito on claude` → 👻 Dosu incognito
# (with the switch, the log line ends "its agent is incognito"; prompts get no Task Memory
# digest, and asking the model to search Dosu memory gets "Dosu is off for this agent")
# End the session; `dosu logs --tail` shows "not shipping incognito session claude/<id>" right away
# `dosu knowledge incognito off claude`, then resume that session: its entry in
# knowledge-sync.json keeps `by_agent: true`, and it never ships
```
