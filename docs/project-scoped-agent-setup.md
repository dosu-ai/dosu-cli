# Project-scoped agent setup

This change moves the automatic Dosu agent bundle from user-global files into the
current Git project. The project receives only non-secret MCP launch metadata,
instructions, and supported skills. Authentication remains in the user's private
Dosu config.

The released `v0.43.0` behavior being migrated installed MCP entries, rules, and
skills globally, while its `AGENTS.md` block was already project-local:
[setup flow](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/setup/flow.ts#L805-L839),
[rules](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/rules/installer.ts#L17-L105),
[skills](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/commands/skill.ts#L13-L115).
Hooks were available through a separate, explicit project command but were never
installed by setup, so this migration has no legacy hook footprint:
[hooks command](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/commands/hooks.ts#L491-L559).

## Current project bundle

`dosu setup` must run inside a Git worktree and resolves the canonical repository
root before writing anything. The implementation is split between the
[project-root resolver](https://github.com/dosu-ai/dosu-cli/blob/main/src/setup/project-root.ts),
[project MCP providers](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers.ts),
[instruction adapters](https://github.com/dosu-ai/dosu-cli/blob/main/src/setup/project-instructions.ts), and
[skill installer](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/skill.ts).

| Agent/client | Project MCP written by this branch | Project instructions | Dosu skill |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` | `AGENTS.md` plus a marker-owned `CLAUDE.md` bridge containing `@AGENTS.md` | `.claude/skills/dosu` (direct for Claude alone; a link to `.agents/skills/dosu` when shared) |
| Cursor | `.cursor/mcp.json` | `AGENTS.md` | `.agents/skills/dosu` |
| VS Code / Copilot extension | `.vscode/mcp.json` | `AGENTS.md` | `.agents/skills/dosu` |
| Gemini CLI | `.gemini/settings.json` | `AGENTS.md` plus a marker-owned `GEMINI.md` bridge containing `@AGENTS.md` | `.agents/skills/dosu` |
| Codex CLI, app, and IDE | `.codex/config.toml` | `AGENTS.md` | `.agents/skills/dosu` |
| Zed | `.zed/settings.json` | `AGENTS.md` | `.agents/skills/dosu` |
| GitHub Copilot CLI | `.mcp.json` | `AGENTS.md` | `.agents/skills/dosu` |
| OpenCode | `opencode.json` | `AGENTS.md` | `.agents/skills/dosu` |
| Antigravity 2.0 | `.agents/mcp_config.json` | `AGENTS.md` plus `.agents/rules/dosu.md` | `.agents/skills/dosu` |
| Factory / Droid | `.factory/mcp.json` | `AGENTS.md` | `.factory/skills/dosu` (direct for Factory alone; a link to `.agents/skills/dosu` when shared) |
| MCPorter | `config/mcporter.json` | N/A: MCP router, not an agent | N/A |

These paths follow the clients' documented project contracts: [Claude](https://code.claude.com/docs/en/mcp),
[Cursor](https://cursor.com/docs/mcp),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[Gemini](https://geminicli.com/docs/reference/configuration/),
[Codex](https://developers.openai.com/codex/mcp),
[Zed](https://zed.dev/docs/ai/mcp),
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
[OpenCode](https://opencode.ai/docs/mcp-servers),
[Antigravity](https://antigravity.google/docs/mcp),
[Factory](https://docs.factory.ai/harness/mcp), and
[MCPorter](https://github.com/openclaw/mcporter/blob/main/docs/config.md).
The shared `AGENTS.md` and skill paths are likewise documented by
[Codex](https://developers.openai.com/codex/guides/agents-md),
[Claude](https://code.claude.com/docs/en/memory),
[Gemini](https://geminicli.com/docs/cli/gemini-md/),
[Cursor](https://cursor.com/docs/skills), and
[VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills). Factory documents
repository skills at `<repo>/.factory/skills/<skill-name>/SKILL.md` in its
[Droid skill configuration](https://docs.factory.ai/cli/configuration/skills), and the pinned
[`skills@1.5.22` agent table](https://github.com/vercel-labs/skills/blob/v1.5.22/README.md#L269-L273)
maps agent ID `droid` to `.factory/skills/` for project installs.

Claude Code and Copilot CLI both read the root `.mcp.json`. Dosu therefore writes
one compatible `stdio` entry rather than competing provider-specific entries.
Project trust/approval is still controlled by each client; writing a valid file is
not proof that the client has approved or started it.

## Secretless MCP proxy

The checked-in project entry contains only an exact CLI version and either a
deployment identifier or `--oss`:

```text
npx -y @dosu/cli@<exact-version> mcp proxy --deployment <deployment-id>
```

At agent startup, the proxy:

1. uses the authenticated user and project target to read a private per-target
   credential record from `<Dosu config dir>/project-mcp-credentials.v1/`;
2. rejects a missing key or an endpoint whose exact path does not match the
   project deployment (or OSS target); and
3. starts the pinned HTTP-to-stdio bridge, passing the key through the child
   process environment rather than the repository file or command arguments.

See the [proxy implementation](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/project-proxy.ts) and
[credential store](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/project-credential-store.ts). The released CLI's
private credential model and remote endpoint shape are visible in the fixed
[config source](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/config/config.ts#L71-L97)
and [MCP helpers](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/mcp/config-helpers.ts#L27-L49).

Records are separated by authenticated user and target, so switching the active
deployment does not break another project's saved target. The directory is mode
`0700` and records are mode `0600` on POSIX systems; `dosu logout` clears the
store, including a strictly validated temporary record left by an interrupted
save. A malformed, foreign, nested, or symlinked entry makes logout preserve the
whole credential directory instead of guessing. Credentials remain user-private because project files are commonly
committed, copied, and reviewed. A remote container or another user's checkout
does not inherit them; the proxy fails closed and that user must run `dosu setup`
in their own environment.

### Existing project target and retargeting

Without an explicit target, setup recognizes only the exact secretless Dosu proxy
shape emitted by a released CLI version and reuses that project's deployment or
OSS target. This takes precedence over a different globally active deployment.
Any foreign, invalid, or ambiguous project entry named `dosu` stops setup before
authentication or project writes. Conflicting exact pins across client files, or
a project deployment unavailable to the signed-in account, also stop before
project writes. An explicit `--deployment <id>` or `--mode oss|cloud` authorizes
retargeting only the clients selected in that run (and clients sharing their
canonical project file); an unselected client that would retain a different pin
stops the run. Ordinary re-runs do not silently switch a project. See the
[project-target resolver](https://github.com/dosu-ai/dosu-cli/blob/main/src/setup/project-target.ts).

### Runtime prerequisite and known limitation

The project entry requires `npx`, and the npm package requires Node.js 22 or later.
Before writing project files, setup starts the exact pinned command that it plans
to write, sends an MCP `initialize` request, validates the response, and requires
the complete spawned process tree to disappear after graceful and forced
shutdown. POSIX uses a dedicated process group; Windows uses `taskkill /T /F`.
SIGINT, SIGTERM, and SIGHUP wait for this cleanup, and an early direct-child exit
does not count as proof that descendants are gone. The round trip has an
eight-second deadline; failure leaves project files and legacy global files
unchanged. See the [preflight implementation](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/project-proxy-preflight.ts),
the fixed
[installation instructions](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/README.md#L22-L48)
and [Node engine requirement](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/package.json#L34-L36).
On Windows, Node requires `.cmd` launchers such as `npx.cmd` to run through a
shell; Dosu takes that path only after validating the fixed command and the
restricted deployment identifier ([Node child-process contract](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)).

This proves the command can initialize in setup's terminal environment. It cannot
prove that a GUI client inherits the same `PATH`, has already trusted the project,
or will use the same startup timeout. Users may still need to restart/reload the
client and approve the project MCP server.

Replacing or removing an existing project config also requires same-directory
hard links so Dosu can retain a no-clobber recovery reference during the atomic
mutation. Filesystems without that capability fail before the original entry is
moved; creating a brand-new project file is unaffected.

## Legacy global migration

Global cleanup runs only after the runtime preflight succeeds and the selected
provider's project MCP, instructions, and applicable skill have all been written
and re-read as one exact bundle. Ordinary targets re-check that bundle before
their mutation. Cleanup is automatic for proven Dosu-owned MCP and instruction
data and conservative for anything ambiguous.

The migration removes only:

- a child/table named `dosu` whose complete provider-specific shape matches a
  released Dosu MCP entry, including the released production origin and an exact `/v1/mcp` or
  `/v1/mcp/deployments/<id>` path and the expected Dosu API-key header; legacy
  stdio entries also require the exact released pinned bridge shape;
- one complete Dosu marker block in a known global instruction file, or a
  standalone legacy rule whose full content matches a known released version.

The migration preserves:

- every sibling MCP server and all unrelated bytes, comments, and formatting;
- same-named entries with extra fields, edited rules, real skill directories,
  foreign links, duplicate keys/tables, invalid files, and any other ownership
  ambiguity;
- legacy entries pointed at dev, staging, localhost, or a runtime backend
  override, because origin provenance cannot be proven safely;
- global entries for clients without a verified project equivalent;
- every legacy global Dosu skill, because the old setup flow and the
  public standalone `dosu skill install` command produced indistinguishable
  lock metadata and files. The migration never touches global skill paths or
  creates a skill migration receipt;
- the user's Dosu login, API key, endpoint, deployment selection, and all other
  private CLI state; and
- all hooks. Released setup never installed a global hook, so there is no legacy
  global hook footprint to clean.

Cleanup must also stop for a target if backup creation fails or if the source file
changes between planning and mutation. Per-target locks and pending receipts make
an interrupted run recoverable. Successful, not-found, and preserved terminal
receipts prevent a later user-created global entry from being mistaken for the old
one; a pre-mutation failure is retried only when the complete file still equals its
recorded `beforeHash`. The
historical shapes are grounded in the fixed
[provider sources](https://github.com/dosu-ai/dosu-cli/tree/84f5d6f392add23e30a636506efa73148acf57ad/src/mcp/providers),
[rule installer](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/rules/installer.ts#L17-L105), and
[skill installer](https://github.com/dosu-ai/dosu-cli/blob/84f5d6f392add23e30a636506efa73148acf57ad/src/commands/skill.ts#L53-L115).

### Backup, receipt, and recovery entry

Migration state is a flat, deterministic directory under the private Dosu config:

```text
<Dosu config dir>/migrations/project-scope-v1/
  target-<target-path-hash>.receipt.json
  <target-id>-<target-path-hash>-<preimage-hash>.bak
<Dosu config dir>/migrations/global-mcp-intent-v1/
  <provider>-<target-path-hash>.json
```

Before each mutation, the migration saves and verifies the exact preimage. Each
receipt records the original absolute path, outcome/reason, hashes, and backup
path without duplicating the file contents. Backups can contain the original
secret-bearing global configuration, so the receipt root is private (`0700`) and
receipt/regular backup files are mode `0600` on POSIX systems. Setup reports the
absolute receipt root when it removes or preserves legacy data.

An explicit `dosu mcp add <id> --global` writes its private intent marker before
touching the client config, then binds it to the installed file hash. Pending,
damaged, replaced, or content-mismatched markers all preserve the global target;
only an absent marker leaves a v0.43 entry eligible for strict legacy cleanup.
The project-default `dosu mcp add <id>` also scans every supported project client
before writing, refuses mixed or ambiguous targets, and requires `--retarget` to
replace that agent's existing Dosu pin plus any client sharing its project MCP
file.

Recovery is deliberately manual: inspect the target's receipt, verify that the
current target has not since been edited, then restore its recorded backup to the
original path. There is no `dosu restore` command.

## Unsupported clients are preserved

| Client | Why project-only MCP is not configured | Safe behavior |
| --- | --- | --- |
| Claude Desktop | Its documented local-server config is application/user scoped, not repository scoped. | Leave any existing global Dosu entry untouched. [Docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| Legacy Windsurf Cascade | Its documented MCP file is `~/.codeium/windsurf/mcp_config.json`; the project-scoped `.devin` contract belongs to the newer Devin Local Agent surface. | Keep the legacy global entry. Do not silently relabel it as Devin. [Cascade](https://docs.windsurf.com/windsurf/cascade/mcp) · [Devin](https://docs.devin.ai/cli/extensibility/mcp/configuration) |
| Cline IDE / Cline CLI | Official documentation exposes user/application MCP settings but no stable repository MCP file. | Keep the global entry; project instructions/skills alone are not an equivalent migration. [MCP](https://docs.cline.bot/mcp/mcp-overview) · [scopes](https://docs.cline.bot/getting-started/config) |
| Devin Local Agent | It supports project MCP, but this branch does not yet model it as a separate provider from legacy Windsurf. | Do not claim it was configured. Add a separate detected provider in a later change. [Docs](https://docs.devin.ai/cli/extensibility/mcp/configuration) |

If product policy later requires deleting every global entry regardless of client
support, these clients will lose Dosu MCP access. That would be an explicit
breaking decision, not this migration's behavior. Users who intentionally want a
global install can still opt in with `dosu mcp add <id> --global`. The CLI records
that intent in its private migration state so the first later project setup does
not mistake the current-version install for a v0.43 legacy entry. Setup never
silently falls back from project scope to global scope. The `manual` ID only
prints connection values and rejects `--global`, because it has no canonical file
path to bind to an ownership marker.
