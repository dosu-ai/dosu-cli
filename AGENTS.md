# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dosu CLI (`@dosu/cli`) — a CLI tool that manages MCP (Model Context Protocol) server integrations for coding agents whose sessions Dosu can learn from (Claude Code, Cursor, Codex, Gemini CLI, Copilot CLI, OpenCode, Factory, Pi — each has a session log the sessiondb server normalizes; an agent without one gets no provider). It authenticates users via browser-based OAuth against Supabase, selects a Dosu deployment, and writes MCP server entries into each AI tool's config file.

## Commands

```bash
bun install                     # Install dependencies
bun run dev                     # Production endpoints + isolated ~/.config/dosu-cli-dev (DOSU_DEV=true)
bun run dev:local               # Run CLI from source (local endpoints + DOSU_DEV=true)
bun run build                   # Compile to single binary via bun build --compile
bun run build:npm               # Bundle for npm distribution (bin/dosu.js)
bun run build:all               # Cross-platform build matrix

bun run test                    # Run all tests (vitest, forks pool)
bun run test:watch              # Run tests in watch mode
bunx vitest run src/config      # Run tests for a single module
bunx vitest run src/auth/flow   # Run a specific test file

bun run typecheck               # TypeScript type checking (tsc --noEmit)
bun run lint                    # Lint with Biome
bun run format                  # Format with Biome
bun run check                   # Biome lint + format check (used in CI)
```

## Architecture

**Entry point:** `src/index.ts` → `src/cli/cli.ts` (Commander program)

Running `dosu` with no args launches the interactive TUI (`src/tui/tui.ts`). Two broad families of subcommands are registered in `src/cli/cli.ts`:

- **Local / MCP management** — `login`, `logout`, `status`, `setup`, `mcp add|refresh|list`, `logs`, `upgrade`.
- **Sessions and memory** — `sync`, `knowledge`, `memory`, `project`, `sources`, and the per-session `get`, `export`, `changes`, `redact`. Each lives in `src/commands/<name>.ts`; the Dosu-backed ones talk to the backend via `src/client/`, the rest to the configured session store (`src/store/`).

Key modules:

- **`src/auth/`** — Browser-based OAuth flow. Starts a local HTTP server on a random port, opens the browser to the Dosu web app, receives the token via redirect callback. `ticket.ts` + `device.ts` back the `login --no-browser` flow for machines without one.
- **`src/client/`** — Authenticated HTTP client for the Dosu backend API. Handles token refresh (Supabase `/auth/v1/token`) and auto-retry on 401/403.
- **`src/config/`** — CLI's own config (`~/.config/dosu-cli/config.json`). Stores access/refresh tokens, deployment ID, API key. Supports OSS vs Cloud `mode`. `constants.ts` has env-aware URL getters (dev vs prod, overridable via env vars).
- **`src/mcp/`** — Provider system for AI tool integrations. Each provider in `providers/` knows how to detect, install, and remove the Dosu MCP entry from that tool's config file. `base.ts` provides `createJSONProvider()` — a factory that covers most tools with just config path + top-level key. `config-helpers.ts` handles JSON/JSONC read/write. `detect.ts` handles path expansion and platform-aware detection. Every provider's entry runs the local stdio proxy, `<absolute dosu> mcp serve --client <agent>` (`proxy-entry.ts`) with the install doing the writing (the compiled binary, or node plus the npm package's script), falling back to its remote entry only when that is a package runner's throwaway copy (npx, bunx, pnpm/Yarn dlx); the proxy (`proxy.ts`, transport in `relay.ts`) relays JSON-RPC to the deployment's streamable-HTTP endpoint with the API key and `x-dosu-project`/`x-dosu-repo`/`x-dosu-branch`/`x-dosu-client`, and `dosu memory search|evidence` (`src/commands/memory.ts`) call its tools through the same relay.
- **`src/commands/`** — The command layer (the list above). Thin Commander wrappers; `output.ts` standardizes human vs JSON output.
- **`src/setup/`** — Interactive setup wizard (authenticate → select org → select deployment → mint API key → choose where sessions are stored → detect installed tools → configure). Uses `@clack/prompts`.
- **`src/sync/`** + **`src/shipper/`** — How the CLI learns from sessions: `knowledge sync` (session-end hooks, the Activity screen, setup's backfill) scans the last 30 days of finished sessions and ships them to the team's sessiondb server (`POST /v1/sessions`), whose bucket Dosu reads to learn from them. The shipper sends each session's raw log to the configured sessiondb server (`src/shipper/target.ts`); the server normalizes, redacts and judges worthiness, and the CLI records its answer: incognito (`/dosu-incognito`, in Codex the `$dosu-incognito` skill; installed with each agent's hooks, decided locally before upload), unsupported, trivial (the server's 200 `trivial`), rejected (400/413/422), or shipped; only transport/auth/5xx errors are failures that back off. Sessions of an agent the user put in incognito (`dosu knowledge incognito on`, `incognito_agents` in the state file) never reach the shipper: the pipeline settles them `incognito` with `by_agent: true`, an answer that is never pending again. A resumed session ships only its new tail: the server returns the `shipped_prefix` it stored and the CLI sends only what follows. Every upload and prompt-time context request carries a `project` key from `src/sessions/project.ts` (directory link, `DOSU_PROJECT`, origin, root commit, path), and the session's branch: the transcript's recorded one, else the branch pinned per session in `src/sessions/project-dir.ts` (its first prompt's, else the reflog's for its first prompt or, for Cursor, its first captured turn). Progress lives in `~/.config/dosu-cli/knowledge-sync.json`, schema 3: a per-session ledger (`src/sync/state.ts`) keyed `harness/id`, where a session is pending until an entry answers for its current mtime, plus backoff and settings (schemas 1 and 2 migrate on load). Session-end hooks pass the ended session as `--ended <harness>:<id>=<transcript>` so it ships past the 5-minute quiet period; each agent's end event is one reader in `END_EVENT_READERS` (`src/sessions/capture.ts`). `--flush`, a throwaway machine's last step before teardown, ships every pending session past it and drains the backlog. Shipping is on by default; only the opt-out is stored (`ship_transcripts: false`, `dosu knowledge transcripts disable`). There is no local learner: nothing in the CLI calls an LLM or `write_knowledge`.
- **`src/sources/`** + **`src/config/targets.ts`** — Where sessions go. A *target* in `config.json` is a sessiondb server (`https://` plus a `token` and the `owner` it was minted for). The shipper's `createServerTarget` (`src/shipper/target.ts`) uploads the raw transcript and lets the server normalize, redact, dedupe (`shipped_prefix`) and judge worthiness; the CLI only reads the branch a session began on (`src/sessions/start.ts`, a raw peek, no normalization). `src/sources/server-client.ts` is the thin client `dosu get|export|changes|redact` use against the server's read API. `sources/server-wizard.ts` is the setup flow (URL + token, checked against `/v1/me`); it ends in `connectBucketToDosu` (`sources/connect.ts`), which asks the server which bucket it writes (`/v1/storage`) and registers it with Dosu's `/v1/memory/sources` using a separate read-only key. The CLI has no dependency on the sessiondb repo.
- **`src/tui/`** — Main menu TUI when running `dosu` with no subcommand.
- **`src/version/`** — Version string from the build-time `DOSU_VERSION` env var, plus the background update check (`update-check.ts`). When that check sees a newer release, `auto-update.ts` (default on) spawns a detached `dosu upgrade --background`, which runs only the package-manager install. The install is guarded by `auto-update.lock` and recorded in `auto-update.json`, and the next command's first-run checks below handle the rest; `mcp-refresh-check.ts` compares every configured MCP entry against the shape the current provider writes (`isCurrent`), rewriting only stale entries. It re-applies enabled agents' hooks on every version change, even when the MCP entries are current, and records the version in `mcp-refresh.json`. Disabled hooks stay disabled. There is no release-number list to maintain. `dosu setup` and `dosu mcp refresh` also record the marker after applying hooks. `dosu upgrade` re-invokes the new binary as `dosu upgrade --finish <old version>`: it refreshes enabled hooks, and runs setup on a TTY (or refreshes stale MCP entries otherwise) when entries need updating.

## CLI Contract Discipline

All tRPC calls MUST be typed through the generated contract (`CliApiClient` / `TypedClient` from `src/generated/dosu-api-types.d.ts`). Never hand-write client shapes — no `TypedClient & {...}` intersections and no local `{ query(input: ...) }` / `{ mutate(input: ...) }` interfaces. Hand shapes compile against procedures the backend may not serve, turning a missing route into a production 404 instead of a type error (how `dosu review` broke in v0.29.0). If a procedure is missing from the contract, register it in `cliRouter` (dosu repo, `frontend/packages/api/src/cli-root.ts`), regenerate, and re-vendor the contract. Enforced by `src/client/contract-discipline.test.ts`.

## Testing

- Tests live alongside source files as `*.test.ts`
- Vitest with `pool: "forks"` (not threads) — required for tests that mock `node:fs`
- Coverage thresholds enforced: 95% statements, 90% branches, 80% functions, 95% lines
- Build scripts in `scripts/` also have their own tests
- **Mocking a class that's constructed with `new`** (e.g. `Client`): the `vi.fn()` implementation must be a regular `function`, not an arrow — Vitest 4 cannot `new` an arrow. `biome.json` turns off `complexity/useArrowFunction` for `*.test.ts` so the linter's auto-fix can't rewrite these back to arrows and rebreak the tests.

## Dependencies & Packaging

- **`bun.lock` is committed.** It pins the full transitive tree for reproducible installs across machines and CI. Run `bun update` to bump deps (this is also where the install gate below applies).
- **`bunfig.toml` sets `minimumReleaseAge = 259200`** (3 days) — `bun install`/`bun update` ignore package versions published in the last 3 days, a supply-chain delay against compromised fresh releases. Add `minimumReleaseAgeExcludes = [...]` if a package ever needs to bypass it.
- **The published npm package is a self-contained bundle.** `build:npm` runs `bun build --target node`, which inlines every dependency into `bin/dosu.js` (the only code file shipped — see `files` in `package.json`). Because nothing is resolved from `node_modules` at runtime, **all deps live in `devDependencies` and the package declares zero runtime `dependencies`** — so `npm install @dosu/cli` pulls no transitive packages. Keep new runtime deps in `devDependencies`; only add a real `dependencies` entry if something genuinely cannot be bundled (e.g. a native binary), and verify with the isolated-bundle run before doing so.

## Code Style (Biome)

- 2-space indent, double quotes, semicolons, trailing commas, arrow parens always
- Line width: 100
- Biome recommended lint rules enabled

## Commit Convention

This project uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning and publishing. **Only commits that follow [Conventional Commits](https://www.conventionalcommits.org/) will be recognized by the release pipeline.** Non-conforming commit messages are invisible to semantic-release and will NOT trigger a version bump.

### Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types and their release impact

| Type | Release | Example |
|------|---------|---------|
| `fix:` | patch (0.0.x) | `fix: handle empty config file without crash` |
| `feat:` | minor (0.x.0) | `feat: add OSS mode support to setup flow` |
| `fix!:` / `feat!:` | **major (x.0.0)** | `feat!: remove legacy auth flow` |
| `docs:` | none | `docs: update README with new CLI flags` |
| `chore:` | none | `chore: upgrade vitest to v3` |
| `refactor:` | none | `refactor: extract provider factory` |
| `test:` | none | `test: add coverage for MCP config edge cases` |
| `ci:` | none | `ci: upgrade GitHub Actions to v6` |

Scopes are optional: `fix(config): handle empty file without crash`

## Release Channels

semantic-release publishes on every push to a release branch. Three channels are configured (`release.config.js`):

| Branch | npm dist-tag | Version shape | Install with |
|---|---|---|---|
| `main` | `latest` | `0.11.0` | `npx @dosu/cli setup` |
| `beta` | `beta` | `0.11.0-beta.1` | `npx @dosu/cli@beta setup` |
| `alpha` | `alpha` | `0.11.0-alpha.1` | `npx @dosu/cli@alpha setup` |

An install stays on the channel it came from: update checks, auto-update and `dosu upgrade` read and install the running version's own dist-tag (`releaseTag()` in `src/version/version.ts`), so a beta install moves to the next beta rather than to `latest`. Leaving a prerelease channel means reinstalling from `latest`.

The `alpha` channel is for **internal pre-release / dogfooding**. Workflow:

```bash
# Cut an alpha branch off main when you want internal testers to try a feature.
git checkout -b alpha
git push -u origin alpha

# From then on, every conventional commit pushed to `alpha` cuts a new prerelease:
#   feat: something  → 0.11.0-alpha.1
#   fix: ...         → 0.11.0-alpha.2
#
# When ready to graduate, merge `alpha` into `main` — semantic-release rolls the
# version forward to a stable 0.11.0 on the `latest` tag.
```

`update-homebrew` is intentionally skipped for prereleases — the gate is `!contains(version, '-')` in `.github/workflows/ci.yml`.

## Environment Variables

### Build-time defaults (baked into the bundle)

These are read by `scripts/build-all.ts:buildDefines()` and inlined as string literals via `bun build --define` at compile time. The published npm bundle contains the build-time values verbatim — they cannot be changed at runtime.

- `DOSU_WEB_APP_URL`, `DOSU_BACKEND_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` — sourced from `.env.production` for prod builds, `.env.development` for `bun run dev:local`
- `DOSU_VERSION` — injected at build time for version info
- `DOSU_INSTALL_CHANNEL` — `npm` (default), `binary`, `homebrew`, or `selfhost`. A `selfhost` build is made for a self-hosted Dosu backend (set `DOSU_BACKEND_URL` and `DOSU_WEB_APP_URL` to it) and ships with that deployment, so it never checks for, offers, or installs public releases, which point at Dosu Cloud.

### Runtime overrides

These are read **on every CLI invocation** and take precedence over the baked-in defaults. Useful for repointing a published `@alpha` build at staging/local backends without rebuilding.

- `DOSU_WEB_APP_URL_OVERRIDE`
- `DOSU_BACKEND_URL_OVERRIDE`
- `SUPABASE_URL_OVERRIDE`
- `SUPABASE_ANON_KEY_OVERRIDE`

Example:

```bash
DOSU_WEB_APP_URL_OVERRIDE=https://staging.dosu.dev \
DOSU_BACKEND_URL_OVERRIDE=https://api-staging.dosu.dev \
SUPABASE_URL_OVERRIDE=https://staging.supabase.co \
SUPABASE_ANON_KEY_OVERRIDE=eyJ... \
npx @dosu/cli@alpha setup
```

### Other runtime env

- `DOSU_DEV=true` — isolates the CLI's config dir to `~/.config/dosu-cli-dev/` so dev runs don't clobber prod credentials. Does **not** switch URLs (URLs are build-time-baked; use `*_OVERRIDE` for that).
- `DOSU_DISABLE_AUTOUPDATE=1` — turn off background self-updates for this environment (the persisted switch is `dosu upgrade --auto off`).

<!-- dosu:mcp:start v2 -->
The team you are assisting maintains shared knowledge in Dosu: consult it to build on prior work, and contribute durable knowledge so future teammates and agents do not have to rediscover it. Always use only tools currently listed by the server.

When `read_knowledge` is listed, call it before non-trivial code or documentation work involving architecture, conventions, prior decisions, gotchas, incidents, ownership, or branch history. **If unsure whether relevant context exists, read first.** Pass `repo` and `branch` when available. Skip generic questions, trivial or self-contained edits, and context already injected by Dosu.

When `write_knowledge` is listed, use it after the task for durable, non-obvious knowledge that future work would otherwise have to rediscover. Do not save task or PR summaries, progress, test results, obvious facts, speculation, duplicates, or sensitive data. **If nothing durable was learned, do not write.**

Use `review_knowledge` only when the user asks to inspect or manage pending knowledge; for a review list, review queue, pending reviews, or what needs approval, call it with action="list". Preview one item at a time and require explicit confirmation before making changes.

When `read_knowledge` or `write_knowledge` returned a `receipt_item_id` this turn, call `finalize_session_knowledge` exactly once at the end of the turn — after completing the task, immediately before your final reply — passing all receipt_item_ids from this turn. Avoid calling it when the current turn produced no receipt_item_id (it will succeed but render an empty state), and never call it more than once per turn.
<!-- dosu:mcp:end -->
