# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dosu CLI (`@dosu/cli`) — a CLI tool that manages MCP (Model Context Protocol) server integrations for AI tools (Claude Code, Cursor, VS Code, Windsurf, Zed, etc.). It authenticates users via browser-based OAuth against Supabase, selects a Dosu deployment, and writes MCP server entries into each AI tool's config file.

## Commands

```bash
bun install                     # Install dependencies
bun run dev                     # Run CLI from source (production endpoints)
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

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `fix: xxx` — patch release
- `feat: xxx` — minor release
- `feat!:` / `fix!: xxx` — major release (breaking change)
- `docs` / `chore` / `refactor` / `test` / `ci: xxx` — no release

Scopes are optional: `fix(config): handle empty file without crash`

## Environment Variables

- `DOSU_DEV=true` — switches all URLs to localhost dev endpoints
- `DOSU_WEB_APP_URL`, `DOSU_BACKEND_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` — individual URL overrides
- `DOSU_VERSION`, `DOSU_COMMIT`, `DOSU_DATE` — injected at build time for version info

## Release Process

Tag-driven via GitHub Actions. Push a tag like `v0.2.0` to `main` to trigger builds for all platforms, npm publish, and Homebrew formula update. Pre-release tags (`-alpha`, `-beta`, `-rc`) publish to npm `next` dist-tag.
