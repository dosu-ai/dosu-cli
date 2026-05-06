# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dosu CLI (`@dosu/cli`) — a CLI tool that manages MCP (Model Context Protocol) server integrations for AI tools (Claude Code, Cursor, VS Code, Windsurf, Zed, etc.). It authenticates users via browser-based OAuth against Supabase, selects a Dosu deployment, and writes MCP server entries into each AI tool's config file.

## Commands

```bash
bun install                     # Install dependencies
bun run dev                     # Run CLI from source (loads .env.development; Bun's NODE_ENV default)
bun run dev:local               # Run CLI from source (local dev endpoints, DOSU_DEV=true)
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

Running `dosu` with no args launches the interactive TUI (`src/tui/tui.ts`). Subcommands: `login`, `logout`, `status`, `setup`, `mcp add|list`.

Key modules:

- **`src/auth/`** — Browser-based OAuth flow. Starts a local HTTP server on a random port, opens the browser to the Dosu web app, receives the token via redirect callback.
- **`src/client/`** — Authenticated HTTP client for the Dosu backend API. Handles token refresh (Supabase `/auth/v1/token`) and auto-retry on 401/403.
- **`src/config/`** — CLI's own config (`~/.config/dosu-cli/config.json`). Stores access/refresh tokens, deployment ID, API key. `constants.ts` has env-aware URL getters (dev vs prod, overridable via env vars).
- **`src/mcp/`** — Provider system for AI tool integrations. Each provider in `providers/` knows how to detect, install, and remove the Dosu MCP entry from that tool's config file. `base.ts` provides `createJSONProvider()` — a factory that covers most tools with just config path + top-level key. `config-helpers.ts` handles JSON/JSONC read/write. `detect.ts` handles path expansion and platform-aware detection.
- **`src/setup/`** — Interactive setup wizard (authenticate → select org → select deployment → mint API key → detect installed tools → configure). Uses `@clack/prompts`.
- **`src/tui/`** — Main menu TUI when running `dosu` with no subcommand.
- **`src/version/`** — Version string from build-time env vars (`DOSU_VERSION`, `DOSU_COMMIT`, `DOSU_DATE`).

## Testing

- Tests live alongside source files as `*.test.ts`
- Vitest with `pool: "forks"` (not threads) — required for tests that mock `node:fs`
- Coverage thresholds enforced: 95% statements, 90% branches, 80% functions, 95% lines
- Build scripts in `scripts/` also have their own tests

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

semantic-release publishes on every push to a release branch. Two channels are configured (`release.config.js`):

| Branch | npm dist-tag | Version shape | Install with |
|---|---|---|---|
| `main` | `latest` | `0.11.0` | `npx @dosu/cli setup` |
| `alpha` | `alpha` | `0.11.0-alpha.1` | `npx @dosu/cli@alpha setup` |

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
- `DOSU_VERSION`, `DOSU_COMMIT`, `DOSU_DATE` — injected at build time for version info

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
