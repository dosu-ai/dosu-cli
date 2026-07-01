# Architecture

## Overview

Dosu CLI (`@dosu/cli`) is a TypeScript/Node.js command-line tool that bridges local AI coding agents with the Dosu platform. It does two related jobs:

1. **Set up the Dosu MCP Server** for the coding agents you already run (Claude Code, Cursor, VS Code, Windsurf, Zed, and others), so agents can query your team's Libraries on demand through the `init_knowledge`, `search_documentation`, `ask`, and `save_topic` tools.
2. **Install knowledge-injection hooks** for supported agents (Claude Code, Codex, Factory) so Dosu pushes relevant context into an agent's session automatically at the right lifecycle events, without requiring an explicit query.

The CLI is distributed on npm as a self-contained bundle — all runtime dependencies are inlined at build time via `bun build`, so `npm install @dosu/cli` pulls no transitive packages. [[1]](https://github.com/dosu-ai/dosu-cli/blob/main/AGENTS.md#L72-L81) Two release channels exist: `latest` (stable, from `main`) and `alpha` (pre-release dogfooding).

The architecture is organized around a small set of well-separated modules under `src/`. Each module has a single clear responsibility — authentication, HTTP transport, config persistence, MCP provider management, onboarding wizard, agent-mode setup, knowledge-injection hooks, and version management — with a thin Commander-based CLI layer wiring everything together. [[2]](https://github.com/dosu-ai/dosu-cli/blob/main/AGENTS.md#L30-L50)

## Repository Layout

```
src/
├── index.ts               # Binary entry point → execute()
├── cli/
│   └── cli.ts             # Commander program, all subcommand registrations
├── tui/
│   └── tui.ts             # Interactive TUI (default action when no subcommand)
├── commands/              # Platform command layer (one file per subcommand)
│   ├── hooks.ts           # Knowledge-injection hook entrypoints + lifecycle commands
│   ├── ask.ts, docs.ts, knowledge.ts, threads.ts, …
│   └── output.ts          # Shared human/JSON output helpers
├── client/
│   └── client.ts          # Authenticated HTTP client with token refresh
├── config/
│   ├── config.ts          # Config schema, load/save, XDG path resolution
│   └── constants.ts       # Build-time URL constants with runtime overrides
├── auth/
│   ├── flow.ts            # Browser-based OAuth flow
│   ├── device.ts          # Device flow (headless/SSH)
│   ├── ticket.ts          # Ticket-based auth for agent non-interactive flows
│   └── headless.ts        # Headless environment detection
├── setup/
│   ├── flow.ts            # Interactive onboarding wizard (runSetup)
│   ├── github-step.ts     # GitHub repo connect step
│   └── github-doc-import-step.ts  # GitHub docs import step
├── agent/
│   ├── flow.ts            # Non-interactive agent setup (runAgentSetup)
│   ├── login-commands.ts  # dosu login --request / --check
│   └── output.ts          # NDJSON event emitters for agent consumption
├── mcp/
│   ├── providers.ts       # Provider registry (allProviders, getProvider, …)
│   ├── providers/
│   │   ├── base.ts        # createJSONProvider factory
│   │   ├── claude.ts, cursor.ts, vscode.ts, … (per-tool providers)
│   │   ├── codex.ts       # TOML-format provider
│   │   └── manual.ts      # Console-output-only provider
│   ├── config-helpers.ts  # JSON/JSONC read/write helpers
│   └── detect.ts          # Path expansion + platform-aware detection
├── hooks/
│   ├── claude-code.ts     # Claude Code hook installer/uninstaller
│   ├── codex.ts           # Codex hook installer/uninstaller
│   ├── factory.ts         # Factory hook installer/uninstaller
│   ├── ticket-client.ts   # API-key-authenticated ticket client
│   ├── prompts.ts         # SAVE_NUDGE, buildReadyEnvelope, LOOKUP_STARTED_NOTE
│   └── state.ts           # Per-session ticket state persistence
├── version/
│   ├── version.ts         # Build-time VERSION, COMMIT, DATE, INSTALL_CHANNEL
│   ├── update-check.ts    # Background npm registry check (24h cache)
│   ├── skill-update-check.ts
│   └── pending-tasks-check.ts
├── insights/              # HTML report generation (dosu insights)
└── debug/
    └── logger.ts          # Structured debug logger (stderr)
```

The entry point `src/index.ts` immediately delegates to `execute()` in `src/cli/cli.ts`, which builds and parses the Commander program. Running `dosu` with no arguments launches the TUI; every other path dispatches to a named subcommand. [[3]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L1-L75)

## Major Components

### `src/cli` — Entry Point & Commander Program

`src/cli/cli.ts` exports `createProgram()`, which builds the Commander tree and registers every subcommand. The `preAction` hook runs version checks on each invocation — **with one important exception**: hook entrypoints (`user-prompt-submit`, `post-tool-use`, `stop`) are detected early via `isHookEntrypointInvocation()` and bypass the version/update/skill checks entirely, because those checks would add latency and stderr noise on the agent's hot path. [[4]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L43-L57)

When invoked with no subcommand, the default `.action()` lazily imports and launches `src/tui/tui.ts`.

Two broad families of subcommands are registered:

- **Local / MCP management**: `login`, `logout`, `status`, `setup`, `mcp add|list`, `logs`.
- **Dosu platform** (require authentication + deployment): `ask`, `knowledge`, `docs`, `suggest`, `threads`, `review`, `sources`, `integrations`, `tags`, `members`, `org`, `deployments`, `analytics`, `insights`, `skill`, `hooks`.

***

### `src/tui` — Interactive Terminal UI

When `dosu` is run without a subcommand, `runTUI()` displays a menu of top-level actions using `@clack/prompts`: **Setup**, **View Insights** (shown only when fully configured), **Authenticate**, **Clear Credentials**, and **Exit**. It acts as a discoverable entry point for users unfamiliar with the CLI's subcommand structure. [[5]](https://github.com/dosu-ai/dosu-cli/blob/main/src/tui/tui.ts)

***

### `src/commands` — Platform Command Layer

`src/commands/` contains one file per Dosu platform subcommand (`ask.ts`, `threads.ts`, `knowledge.ts`, and so on). Each file exports a `*Command()` factory that returns a Commander `Command` object with its own options, argument parsing, and action handler.

These command handlers are intentionally thin: they load config, construct a `Client`, call the appropriate API methods, and format the result using `output.ts`. Business logic lives in the client and the domain modules, not in the command handlers. This separation means output formatting (human-readable vs. `--json`) can change without touching the transport layer. [[6]](https://github.com/dosu-ai/dosu-cli/blob/main/AGENTS.md#L40-L48)

`src/commands/hooks.ts` is the largest command module; it serves double duty as both the agent lifecycle hook entrypoints (`user-prompt-submit`, `post-tool-use`, `stop`) and the hook management commands (`install`, `uninstall`, `doctor`). [[7]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L1-L25)

***

### `src/client` — Authenticated HTTP Client

`Client` is the single HTTP transport used by every command. It wraps `fetch` with two auth modes:

| Mode | Header | Used by |
|---|---|---|
| OAuth (Supabase session) | `Supabase-Access-Token` | All platform commands, setup wizard |
| API key (long-lived) | `X-Dosu-API-Key` | Knowledge-injection hooks, MCP queries |

`doRequest()` performs pre-emptive token expiry checking before a request and will retry once with a refreshed token on 401/403. All requests carry a 10-second `AbortController` timeout. [[8]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L46-L75)

The token refresh path (`refreshToken()`) is written to be safe under concurrent CLI processes. GoTrue refresh tokens are single-use; replaying a stale one revokes the whole session. The client handles this by adopting the newest on-disk tokens before each refresh attempt and retrying once from the refreshed file if the first attempt fails, covering the race where a sibling process rotated the token mid-flight. [[9]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L147-L175)

The API-key path (`getWithApiKey()`, `postWithApiKey()`) intentionally bypasses OAuth and token refresh — hooks run as frequent short-lived processes, and an hourly-expiring OAuth token would silently fail on the agent hot path. [[10]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L112-L135) [[11]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/ticket-client.ts#L1-L15)

***

### `src/config` — Configuration Store

All persistent state lives in a single JSON file at `~/.config/dosu-cli/config.json` (or `$XDG_CONFIG_HOME/dosu-cli/config.json`). The `Config` interface holds:

```typescript
{
  access_token: string;
  refresh_token: string;
  expires_at: number;
  deployment_id?: string;
  deployment_name?: string;
  api_key?: string;
  mode?: "oss";
  org_id?: string;
  space_id?: string;
}
```

`saveConfig()` uses a write-then-rename pattern (temp file with the process PID in the name, then `renameSync`) to ensure that concurrent CLI processes never observe a partially written config. The rename is atomic within a single filesystem. [[12]](https://github.com/dosu-ai/dosu-cli/blob/main/src/config/config.ts#L72-L84)

`isTokenExpired()` returns `true` when the token is within 5 minutes of expiry, giving `doRequest()` a window to refresh before the server would reject it. [[13]](https://github.com/dosu-ai/dosu-cli/blob/main/src/config/config.ts#L102-L107)

`DOSU_DEV=true` redirects the config dir to `~/.config/dosu-cli-dev/`, isolating dev credentials from production.

***

### `src/auth` — OAuth & Ticket Authentication

Authentication takes three paths:

1. **Browser OAuth** (`src/auth/flow.ts`): starts a local HTTP server on a random port, opens the browser to the Dosu web app, and receives the token via redirect callback. This is the default for interactive `dosu login` and the setup wizard.
2. **Device flow** (`src/auth/device.ts`): used on headless machines (SSH, CI) when no browser is available. The user opens a URL manually on another device and the CLI polls for the result.
3. **Ticket flow** (`src/auth/ticket.ts`): used in agent-mode setup. `mintTicket()` creates a short-lived URL and ticket ID; `exchangeTicket()` redeems it after the user authenticates. This allows the CLI process to exit after printing the URL, with a subsequent invocation carrying the ticket to complete setup.

`src/auth/headless.ts` detects headless environments automatically; `dosu login --no-browser` forces the device flow explicitly. [[14]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L114-L160) [[15]](https://github.com/dosu-ai/dosu-cli/blob/main/AGENTS.md#L30-L35)

***

### `src/setup` — Interactive Onboarding Wizard

`runSetup()` in `src/setup/flow.ts` is the interactive, multi-step setup experience launched by `dosu setup`. It handles authentication, MCP deployment binding, API key issuance, AI agent configuration, Dosu skill installation, and GitHub repository/documentation import in a single guided session using `@clack/prompts`.

**Flow kind detection**: After authentication, `resolveCloudSetupContext()` queries the server-side profile to distinguish first-run (`onboarding`) from returning (`setup`) users. The `finished_onboarding` and `cli_onboarding_enabled` profile fields drive this branch. [[16]](https://app.dosu.dev/documents/02a0c3c0-00df-4352-ba7a-1f00d5bc7154)

**Steps**:

1. **Authenticate** — Verify or refresh session token; fall back to OAuth.
2. **Deployment binding** — Auto-bind on first run; interactive picker on repeat run or when `--deployment` flag is passed.
3. **API key** — Validate existing key or mint a new one (idempotent).
4. **One-shot confirm** — Single multiselect with all pending actions pre-ticked.
5. **MCP tool configuration** — Detect installed agents → select → call `provider.install()` or `provider.remove()`.
6. **Skill installation** — Install the Dosu skill (agent instructions set).
7. **GitHub connect + docs import** — First-run only; skipped for returning users.

**OSS mode**: When `--mode oss` is passed, the wizard skips all cloud steps and proceeds only through MCP configuration and skill installation, using public Dosu libraries as the knowledge source. [[17]](https://app.dosu.dev/documents/02a0c3c0-00df-4352-ba7a-1f00d5bc7154)

***

### `src/agent` — Non-Interactive Agent Setup

`runAgentSetup()` in `src/agent/flow.ts` is the parallel non-interactive setup path, activated via `dosu setup --agent --tool <id>`. It composes the same building blocks as the wizard (Client, providers, config) but differs fundamentally in how it interacts with the caller:

- **Never prompts**: every step emits a single NDJSON event to stdout via `emitStep`, `emitError`, or `emitNeedUserAction`.
- **Ticket-based auth**: instead of holding a browser callback open, it mints a ticket and emits `need_user_action` with a sign-in URL, then exits. A subsequent invocation with `--login-ticket` redeems it.
- **Exit codes**: `0` = success or waiting; `1` = recoverable error with `agent_next_steps`; `2` = CLI usage error.

Steps mirror the wizard: auth → deployment resolution → API key → MCP install. Each step emits structured JSON so the driving agent can relay instructions to the user or proceed automatically. [[18]](https://github.com/dosu-ai/dosu-cli/blob/main/src/agent/flow.ts#L1-L20)

`src/agent/login-commands.ts` provides `runLoginRequest()` and `runLoginCheck()` which back the `dosu login --request` / `--check` commands, enabling agent-initiated authentication without a browser.

***

### `src/mcp` — Provider System

The MCP module manages the installation and removal of the Dosu MCP server entry in each AI tool's configuration file.

**Provider interfaces** [[19]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers.ts#L8-L31):

- `Provider`: base interface — `name()`, `id()`, `supportsLocal()`, `install(cfg, global)`, `remove(global)`.
- `SetupProvider` extends Provider with detection: `detectPaths()`, `isInstalled()`, `isConfigured()`, `globalConfigPath()`, `priority()`.

**Registry functions** [[20]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers.ts#L51-L98):

| Function | Returns |
|---|---|
| `allProviders()` | All 16 providers |
| `allSetupProviders()` | `SetupProvider` implementations sorted by priority |
| `detectInstalledProviders()` | Only providers where `isInstalled()` is true |
| `getProvider(toolID)` | A single provider by ID, throws on unknown |

**`createJSONProvider()` factory** (`src/mcp/providers/base.ts`): 12 of the 16 providers share identical install/remove behavior — they differ only in config file path, the top-level JSON key, and whether local (project-level) config is supported. The factory encapsulates all of that in one object literal: [[21]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/base.ts#L33-L85)

```typescript
createJSONProvider({
  providerName: "Claude Code",
  providerID: "claude",
  local: true,
  priorityValue: 1,
  paths: ["~/.claude"],
  globalPath: "~/.claude.json",
  topKey: "mcpServers",
  localConfigPath: (cwd) => join(cwd, ".mcp.json"),
});
```

At install time, the factory writes a server entry object at `cfg[topKey].dosu` with an `http` type, the deployment URL, and the API key header. OSS mode substitutes the public MCP base URL. [[22]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/base.ts#L34-L50)

Notable deviations from the JSON pattern:

- **Codex**: TOML format (`[mcp_servers.dosu]` section).
- **Copilot**: adds a `tools: ["*"]` field; local install targets `.vscode/mcp.json`.
- **MCPorter**: strips comments before parsing JSONC.
- **Manual**: no file operations; prints the config block to stdout for manual copying.

***

### `src/hooks` — Knowledge-Injection Hot Path

The hooks system has two layers: a **config layer** (installer/uninstaller, in `src/hooks/`) and an **entrypoint layer** (the hot-path runners, in `src/commands/hooks.ts`).

**Config layer** (`src/hooks/claude-code.ts`, `codex.ts`, `factory.ts`):
`installClaudeHooks()` merges Dosu-owned hook entries into `.claude/settings.local.json`. Each entry carries a `__dosu` ownership marker, making the install idempotent (reinstall replaces existing Dosu groups) and the uninstall surgical (only Dosu groups are removed, user hooks are preserved). [[23]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/claude-code.ts#L98-L130)

**Entrypoint layer** (`src/commands/hooks.ts`):
Three lifecycle functions run on the agent's turn: [[24]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L117-L300)

| Function | Fires when | Action |
|---|---|---|
| `runUserPromptSubmit()` | User sends a prompt | Creates a knowledge ticket (fire-and-forget); saves pending state |
| `runPostToolUse()` | After each tool use | Polls ticket with a cooldown; injects knowledge exactly once on ready |
| `runStop()` | At end of agent turn | Waits up to 8s for in-flight ticket; last-chance delivery |

All three functions are designed to never disrupt the agent: any unhandled error is caught at the top-level dispatcher (`runHookEntrypoint`), logged to stderr, and results in no stdout (or `{continue: true}` for the Stop hook). [[25]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L285-L305)

The no-op path — no active ticket, already delivered, within cooldown — uses only Node built-ins and a small state-file read. Network and auth modules are **lazy-imported** only when an actual create or poll is required, keeping startup time minimal. [[26]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L1-L20)

**Ticket client** (`src/hooks/ticket-client.ts`):
Authenticates with the long-lived API key (`X-Dosu-API-Key`) rather than the OAuth token. This matters because hooks run as frequent short-lived processes; an hourly-expiring token subject to rotation races would silently fail mid-session. [[27]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/ticket-client.ts#L1-L18)

`TicketResult.save_recommended` is a boolean flag the server sets when it found no prior knowledge on the topic. When true, `buildReadyEnvelope()` in `src/hooks/prompts.ts` appends a `SAVE_NUDGE` to the injected context, prompting the agent to call `save_topic` after it finishes. [[28]](https://app.dosu.dev/documents/b2c3b36a-9fa9-401d-a308-1710b8ab1a12)

***

### `src/version` — Version & Update Management

Build-time constants (`VERSION`, `COMMIT`, `DATE`, `INSTALL_CHANNEL`) are injected via `bun build --define` and baked into the bundle. They cannot be changed at runtime.

`checkForUpdates()` follows a "check now, display next run" pattern: it reads a cached latest version from `~/.config/dosu-cli/update-check.json` and displays a notice to stderr if outdated. It then fires a background fetch to the npm registry (not awaited) to refresh the cache for the next run. The fetch is throttled to once per 24 hours. `buildUpdateHint()` adapts the upgrade command to the install channel: `npm update -g`, `brew upgrade dosu`, or a direct GitHub releases link for binary installs. [[29]](https://github.com/dosu-ai/dosu-cli/blob/main/src/version/update-check.ts#L11-L30)

`checkForSkillUpdates()` and `checkForReadyTasks()` follow the same non-blocking pattern. All three are skipped on hook entrypoint invocations to avoid adding latency or stderr noise on the agent hot path. [[4]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L43-L57)

## How Components Interact

### Dependency Map

```
src/index.ts
    └─ src/cli/cli.ts (Commander)
           ├─ src/tui/tui.ts           (default, no-subcommand path)
           ├─ src/commands/*           (platform subcommands)
           │       └─ src/client/      (authenticated HTTP)
           │               └─ src/config/   (load/save tokens)
           ├─ src/setup/flow.ts        (interactive wizard)
           │       ├─ src/client/
           │       ├─ src/mcp/providers.*
           │       ├─ src/auth/flow.ts
           │       └─ src/config/
           ├─ src/agent/flow.ts        (non-interactive agent setup)
           │       ├─ src/client/
           │       ├─ src/mcp/providers.*
           │       ├─ src/auth/ticket.ts
           │       └─ src/config/
           ├─ src/commands/hooks.ts    (hook entrypoints + lifecycle)
           │       ├─ src/hooks/ticket-client.ts  ─► src/client/ (API key)
           │       ├─ src/hooks/claude-code.ts
           │       ├─ src/hooks/state.ts
           │       └─ src/hooks/prompts.ts
           └─ src/version/             (update/skill/task checks)
```

### Authentication Flows

**Interactive OAuth** (used by `dosu login` and the setup wizard):

1. `src/cli/cli.ts` calls `loadConfig()` to check existing credentials.
2. If no valid session exists, `startOAuthFlow()` from `src/auth/flow.ts` opens a local HTTP callback server and launches the browser.
3. On redirect, the token is written to `src/config/config.ts` via `saveConfig()`.
4. All subsequent `Client` calls use `Supabase-Access-Token` from the stored token.
5. On expiry, `Client.refreshToken()` adopts the newest disk tokens and calls Supabase `/auth/v1/token` before retrying. [[30]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L135-L200)

**API key** (used by hooks and MCP queries):

1. During setup, `stepMintAPIKey()` calls `client.createAPIKey()` and stores the key in config.
2. Hook entrypoints read the key directly from `loadConfig()` and pass it to `requestCreateTicket()` / `requestGetTicket()` via `X-Dosu-API-Key`.
3. No refresh is needed — the API key is long-lived by design. [[31]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/ticket-client.ts#L8-L18)

### Interactive Setup Flow

```
dosu setup
  └─ cli.ts: runSetup()
        ├─ stepAuthenticate()     ← src/auth + src/client
        ├─ resolveCloudSetupContext()  ← src/client (profile query)
        ├─ bindOnboardingDeployment()  ← src/client (deployments API)
        │   or resolveDeployment()     ← interactive picker
        ├─ stepMintAPIKey()        ← src/client (API key endpoint)
        ├─ stepOneShotConfirm()    ← @clack/prompts
        ├─ stepConfigureMcpTools()
        │       ├─ stepDetectTools()   ← src/mcp (detectInstalledProviders)
        │       ├─ stepSelectTools()   ← @clack/prompts multiselect
        │       └─ stepConfigureTools()  ← provider.install() / provider.remove()
        ├─ runInstallSkill()       ← src/commands/skill
        └─ stepConnectGitHubRepo() + stepImportGitHubDocs()  (first-run only)
```

[[32]](https://app.dosu.dev/documents/02a0c3c0-00df-4352-ba7a-1f00d5bc7154)

### Agent Setup Flow

```
dosu setup --agent --tool claude
  └─ cli.ts: runAgentSetup()
        ├─ [no existing session] mintTicket() → emitNeedUserAction → exit 0
        │       ↑ (user signs in at the provided URL)
        │
        ├─ [with --login-ticket] exchangeTicket() → save tokens → emitStep("auth")
        ├─ resolveDeployment()   ← src/client (never prompts; errors with candidates)
        ├─ ensureAPIKey()        ← src/client (validate or create)
        └─ provider.install()   ← src/mcp (global install)
             └─ emitStep("done")
```

[[33]](https://github.com/dosu-ai/dosu-cli/blob/main/src/agent/flow.ts#L42-L110)

### Hook Knowledge-Injection Flow

```
[Claude Code: user sends prompt]
  └─ dosu hooks user-prompt-submit  (stdin: JSON event)
        └─ runUserPromptSubmit()
              ├─ loadState(sessionId)          ← src/hooks/state.ts
              ├─ loadConfig()                   ← src/config
              └─ requestCreateTicket()  ──────► Dosu backend (async, returns ticket_id)
                    └─ saveState(pending)
                    └─ printHookContext("UserPromptSubmit", LOOKUP_STARTED_NOTE)

[Claude Code: after each tool use]
  └─ dosu hooks post-tool-use
        └─ runPostToolUse()
              ├─ loadState(sessionId)
              ├─ cooldown check (default 3s)
              └─ requestGetTicket()  ──────────► Dosu backend (poll)
                    ├─ status=pending → saveState(lastCheckedAt); return
                    └─ status=ready  → buildReadyEnvelope()
                          └─ printHookContext("PostToolUse", envelope)
                          └─ saveState(delivered)   [terminal, no re-fire]

[Claude Code: agent stops]
  └─ dosu hooks stop
        └─ runStop()
              └─ poll up to 8s for ready ticket
                    ├─ ready + context → decision:"block" + envelope → stdout
                    └─ ready (gap only) or timeout → {continue:true} → stdout
```

[[24]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L117-L300) [[34]](https://app.dosu.dev/documents/b2c3b36a-9fa9-401d-a308-1710b8ab1a12)

## Data Flow

### CLI Command Data Flow

For a typical platform command like `dosu threads list`:

1. `src/index.ts` calls `execute()` → `program.parseAsync(process.argv)`.
2. Commander routes to `threadsCommand()`, registered in `src/cli/cli.ts`.
3. The command action calls `loadConfig()` to read stored credentials and deployment context.
4. `new Client(cfg)` is constructed. If `isTokenExpired(cfg)`, `refreshToken()` is called before the first request.
5. The action calls a `client.get()` or `client.post()` method, which sends an authenticated HTTP request to the Dosu backend.
6. The JSON response is formatted by `output.ts` helpers — either human-readable table output or `--json` passthrough — and printed to stdout. [[35]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L1-L50) [[8]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L46-L75)

### Hook Knowledge-Injection Data Flow

The hook system uses a **fire-and-poll** model with a per-session state file. Each hook invocation is a short-lived process that reads a small JSON state file, optionally makes a network call, and exits:

1. **UserPromptSubmit**: The prompt text is extracted from stdin. If no active ticket exists for the session, `requestCreateTicket()` POSTs to `/v1/tickets/knowledge` using the deployment API key. The backend enqueues the knowledge lookup asynchronously and returns a `ticket_id` immediately. The state `{status: "pending", ticketId, expiresAt}` is written to disk, and a `LOOKUP_STARTED_NOTE` is injected into the agent's context so it knows a lookup is in progress.

2. **PostToolUse**: The state file is read. If the ticket is pending and past the cooldown window (default 3s), `requestGetTicket()` polls `/v1/tickets/knowledge/:id`. On status `ready`, `buildReadyEnvelope()` assembles the final context block (with optional `SAVE_NUDGE` if `save_recommended` is true) and injects it once. The state is immediately updated to `"delivered"` before printing, so a crash after disk write falls toward "no duplicate injection." [[36]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L163-L225)

3. **Stop**: A final wait loop polls for up to 8 seconds. If the ticket becomes ready with real context, the hook `decision:"block"` response causes Claude Code to inject the knowledge before the turn ends. A bare knowledge-gap nudge (no context) does **not** block; the agent is allowed to continue. [[37]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L230-L285)

This design means the Dosu backend lookup runs in parallel with the agent's tool calls, and the result lands in the agent's context without requiring the agent to call any tool itself.

### Onboarding / Config Data Flow

Configuration state accumulates progressively through the setup wizard:

| Wizard Step | Config Fields Written |
|---|---|
| Authentication | `access_token`, `refresh_token`, `expires_at` |
| Deployment binding | `deployment_id`, `deployment_name`, `org_id`, `space_id`, `mode` |
| API key | `api_key` |

Each `saveConfig()` call writes the entire config atomically via the temp-rename pattern, so any step can be safely interrupted and retried. The MCP provider `install()` calls write **the tool's own config file** (e.g., `~/.claude.json`), not the Dosu config, using the API key and deployment URL from the Dosu config. [[38]](https://github.com/dosu-ai/dosu-cli/blob/main/src/config/config.ts#L61-L84) [[39]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/base.ts#L55-L75)

After setup completes, the same config file is used by every subsequent CLI invocation, hook run, and MCP server query — it is the single source of truth for the user's Dosu session.

### MCP Tool Configuration Data Flow

When `provider.install(cfg, global)` is called (either from the wizard, the agent setup, or `dosu mcp add`):

1. The factory builds a server entry object: `{ type: "http", url: mcpURL(cfg.deployment_id), headers: { "X-Dosu-API-Key": cfg.api_key } }`.
2. The existing tool config file is read (or created if absent).
3. The entry is written at `cfg[topKey]["dosu"]` — e.g., `mcpServers.dosu` in `~/.claude.json`.
4. The file is written atomically with `0o600` permissions.

The provider writes exactly one key (`"dosu"`) into the tool's config. `remove()` deletes only that key, leaving the rest of the tool's MCP config intact. `isConfigured()` checks for the presence of that key without reading its value. [[40]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/base.ts#L55-L85)

## Key Design Decisions

### Command Layer Separated from Client Layer

`src/commands/` and `src/client/` are kept strictly separate: command handlers deal with argument parsing, config loading, and output formatting; the client deals with authentication and HTTP transport. This separation means:

- **Output format changes** (adding `--json` flags, changing table layouts) never touch the transport layer.
- **New commands** can be added by composing existing client methods without any auth concerns.
- **Testing** the client independently from Commander glue is straightforward.

The command layer is also where the hook entrypoints live, which reinforces the separation: `src/commands/hooks.ts` contains both the hot-path entrypoints and the lifecycle commands (`install`/`uninstall`/`doctor`), because those are all Commander-facing surfaces, while the pure config-manipulation logic lives in `src/hooks/`. [[6]](https://github.com/dosu-ai/dosu-cli/blob/main/AGENTS.md#L40-L48) [[26]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L1-L20)

### The `createJSONProvider` Factory Pattern

Of the 16 MCP providers, 12 follow a nearly identical pattern: read a JSON file at a fixed path, add or remove one key under a fixed top-level section, write the file back. Rather than duplicate this logic across 12 files, `src/mcp/providers/base.ts` provides `createJSONProvider()`, a factory that accepts a config object and returns a full `SetupProvider` implementation.

Each tool's provider file is then a single `createJSONProvider({...})` call — often under 15 lines. This yields several benefits:

- A bug fix in the base (e.g., atomic writes, JSONC stripping) applies to all 12 providers simultaneously.
- A new tool can be added by creating a small config object rather than implementing an interface from scratch.
- The four exceptional providers (Codex, Copilot, MCPorter, Manual) are clearly differentiated as genuine deviations rather than copies with minor tweaks. [[41]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/base.ts) [[42]](https://github.com/dosu-ai/dosu-cli/blob/main/src/mcp/providers/claude.ts) [[43]](https://app.dosu.dev/documents/9c2ce81b-ea49-475a-bd8e-a10e7975599b)

### Interactive vs. Non-Interactive Setup Flows

The setup system has two parallel implementations: `src/setup/flow.ts` (interactive wizard) and `src/agent/flow.ts` (agent mode). They share the same building blocks — `Client`, `mcp/providers`, `config` — but differ fundamentally in their I/O contract:

| Dimension | Wizard (`src/setup/`) | Agent mode (`src/agent/`) |
|---|---|---|
| Prompts | `@clack/prompts` interactive UI | Never; exits immediately |
| Auth method | Browser OAuth (callback server) | Login ticket (mintTicket/exchangeTicket) |
| Output | Human-readable terminal output | NDJSON events (one per step) to stdout |
| Process model | Runs to completion in one invocation | May exit mid-flow; resumed with `--login-ticket` |
| Error handling | Re-prompts or aborts with a message | `emitError` with `agent_next_steps` field |

The separation is intentional: the wizard is optimized for human comprehension (progress indicators, interactive pickers, one-shot confirmation), while agent mode is optimized for programmatic consumption (structured output, fast exit, deterministic status codes). The shared building blocks ensure that both flows produce identical MCP config file changes. [[18]](https://github.com/dosu-ai/dosu-cli/blob/main/src/agent/flow.ts#L1-L20) [[44]](https://app.dosu.dev/documents/02a0c3c0-00df-4352-ba7a-1f00d5bc7154)

### Authentication and Token Refresh Architecture

Two credentials are used, each scoped to a different use case:

- **Supabase OAuth token** (access + refresh pair): used for platform commands and the setup wizard. Tokens expire hourly. The refresh path in `Client.refreshToken()` is hardened against multi-process races: GoTrue refresh tokens are single-use, and multiple CLI processes (e.g., a long-lived TUI and a background hook process) share a single config file. The solution is to adopt the newest on-disk token before each refresh and retry once from the re-read file if the first attempt fails — covering the race where a sibling process rotated the token between config read and the network request. [[30]](https://github.com/dosu-ai/dosu-cli/blob/main/src/client/client.ts#L135-L200)

- **Deployment API key**: used for hook entrypoints and MCP queries. The key is long-lived and does not require refresh. Hooks run as frequent short-lived processes (on every agent tool call), making hourly token expiry and the associated rotation races a reliability risk. Using a long-lived API key eliminates that risk entirely at the cost of a separate credential to manage. [[27]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/ticket-client.ts#L1-L18) [[45]](https://app.dosu.dev/documents/6c889b78-08e3-43cf-8519-2cea8d086db6)

Config writes use a pid-suffixed temp file + `renameSync` pattern to ensure that concurrent processes never observe a partially-written config, which is the root cause of corrupted refresh tokens. [[12]](https://github.com/dosu-ai/dosu-cli/blob/main/src/config/config.ts#L72-L84)

### Hooks as a Hot Path

Claude Code invokes `dosu hooks user-prompt-submit`, `dosu hooks post-tool-use`, and `dosu hooks stop` on **every agent turn** — meaning the CLI binary is spawned multiple times per user prompt. Several architectural decisions follow from this:

1. **Hook entrypoints skip the preAction update checks** in `src/cli/cli.ts`. Version checks, skill update checks, and ready-task notifications write to stderr and add latency; both are disruptive on a hot path that runs silently in the background. [[4]](https://github.com/dosu-ai/dosu-cli/blob/main/src/cli/cli.ts#L43-L57)

2. **Network and auth modules are lazy-imported** inside the hot-path handlers. The no-op path — no active ticket, already delivered, within cooldown — reads only a small JSON state file and exits without importing the HTTP client at all. [[46]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L15-L25)

3. **Hooks fail silently by design.** Any error in a hook entrypoint is caught, logged to stderr, and results in no stdout injection (or `{continue: true}` for Stop). The agent is never blocked or disrupted, even if the Dosu backend is unreachable. This is a deliberate reliability trade-off: false negatives (missed injections) are preferable to false positives (agent disruptions). [[25]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L285-L305)

4. **The API key replaces OAuth on the hot path** for the reasons described above — long-lived credential, no rotation races. [[31]](https://github.com/dosu-ai/dosu-cli/blob/main/src/hooks/ticket-client.ts#L8-L18)

5. **State is persisted per-session** in a small JSON file rather than in-process memory. Since each hook invocation is a new process, state must survive across process boundaries. A `"delivered"` state written to disk before printing ensures that a crash between disk write and stdout flush biases toward "missed injection" rather than "double injection." [[47]](https://github.com/dosu-ai/dosu-cli/blob/main/src/commands/hooks.ts#L204-L215)
