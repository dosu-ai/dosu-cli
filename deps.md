# deps.md

> **Audience**: Contributors and maintainers. This page documents the dependency architecture and packaging conventions for the `@dosu/cli` repository.

## Overview

`@dosu/cli` uses an unconventional but deliberate dependency model: the `package.json` declares **zero runtime `dependencies`**. Every library the CLI uses at runtime lives in `devDependencies` instead. This is safe because the npm package ships only a single pre-built file — `bin/dosu.js` — that is produced by `bun build --target node` and contains every dependency inlined [[1]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L60-L64).

The practical consequence is that `npm install @dosu/cli` (or `npx @dosu/cli`) pulls **no transitive packages** for the end-user. There is nothing to resolve, nothing to conflict with, and no `node_modules` subtree to audit.

**Rule of thumb for contributors**: Keep all new runtime dependencies in `devDependencies`. Only add an entry to `dependencies` if something genuinely cannot be bundled — for example, a native binary addon — and verify the isolated-bundle behavior before doing so [[2]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L64).

## Key Dependencies

All of the following come from `devDependencies` in [`package.json`](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L37-L56). They are grouped by whether they end up in the final bundle or are used only during development.

### Bundled at Build Time (end up in `bin/dosu.js`)

| Package | Version | Purpose |
|---|---|---|
| `commander` | `^15.0.0` | CLI framework — registers subcommands, flags, and argument parsing. The program is assembled in `src/cli/cli.ts`. |
| `@clack/prompts` | `^1.6.0` | Interactive terminal prompts. Used in the setup wizard (`src/setup/`) and the main-menu TUI (`src/tui/`). |
| `@trpc/client` | `11.18.0` | Type-safe RPC client for communicating with the Dosu backend API (`src/client/`). |
| `@trpc/server` | `11.18.0` | tRPC server-side types required to derive the typed client. Must stay in sync with `@trpc/client` (see [Version Constraints](#version-constraints)). |
| `superjson` | `^2.2.6` | JSON serializer that handles rich types (Dates, Maps, Sets, etc.). Used as the tRPC transformer so these types survive the wire. |
| `picocolors` | `^1.1.1` | Minimal terminal color formatting. Used throughout for colored output with no overhead. |
| `open` | `^11.0.0` | Opens the system browser for the OAuth flow (`src/auth/`). |
| `write-file-atomic` | `^8.0.0` | Writes config files atomically (temp file → rename) to prevent corruption if the process is interrupted during an MCP config update (`src/mcp/config-helpers.ts`). |
| `@dosu/api-types` | `0.0.36` | First-party generated TypeScript types from the Dosu backend's tRPC router. Pinned exact — see [Version Constraints](#version-constraints). |

### Development-Only (not included in the bundle)

| Package | Version | Purpose |
|---|---|---|
| `@biomejs/biome` | `^2.5.0` | Linter and formatter. Enforces 2-space indent, double quotes, semicolons, trailing commas, 100-character line width. Run via `bun run lint`, `bun run format`, or `bun run check` [[3]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L66-L70). |
| `vitest` | `^4.1.9` | Test framework. Uses `pool: "forks"` (not threads) — required for tests that mock `node:fs` [[4]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L54-L56). |
| `@vitest/coverage-v8` | `^4.1.9` | V8-based coverage provider for Vitest. Enforces thresholds: 95% statements, 90% branches, 80% functions, 95% lines. |
| `typescript` | `^6.0.3` | Used only for `tsc --noEmit` type-checking. Bun handles compilation and bundling. |
| `@types/bun` | `^1.3.14` | Type definitions for Bun-specific APIs used in source and build scripts. |
| `semantic-release` | `^25.0.5` | Automates version bumping and npm publishing based on [Conventional Commits](https://www.conventionalcommits.org/) [[5]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L72-L74). |
| `@semantic-release/changelog` | `^6.0.3` | Generates and updates `CHANGELOG.md` as part of the release pipeline. |
| `@semantic-release/exec` | `^7.1.0` | Runs shell commands during the semantic-release lifecycle (e.g. triggering cross-platform builds). |
| `@semantic-release/git` | `^10.0.1` | Commits the updated `CHANGELOG.md` and `package.json` version back to the repo after release. |

## Build Process

### npm bundle (`bin/dosu.js`)

The npm-published bundle is produced by the `build:npm` script [[6]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L24):

```bash
bun run build:npm
# expands to:
DOSU_INSTALL_CHANNEL=npm bun --env-file=.env.production run scripts/build-npm.ts
```

[`scripts/build-npm.ts`](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-npm.ts) calls Bun's bundler with `--target node`, which tree-shakes and inlines all imports into a single JavaScript file [[7]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-npm.ts#L35-L37):

```bash
bun build --target node [--define ...] src/index.ts --outfile bin/dosu.js
```

After bundling, the script normalizes the output [[8]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-npm.ts#L15-L30):

- **Replaces the shebang** with `#!/usr/bin/env node` (Bun's default shebang is `#!/usr/bin/env bun`, which won't work for npm consumers running Node).
- **Strips the `// @bun` comment** that Bun inserts at the top of its output — this comment is meaningless to Node.js and would appear in the published file.
- **Ensures a trailing newline** for POSIX compliance.

The `prepack` lifecycle hook in `package.json` [[9]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L32) automatically runs `build:npm` before every `npm pack` or `npm publish`, so the bundle is always fresh:

```json
"prepack": "bun run build:npm"
```

The `files` field limits the published npm package to just the generated bundle [[10]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L16-L18):

```json
"files": ["bin/dosu.js"]
```

### Baked-in environment variables

Build-time configuration is inlined via `bun build --define` by `buildDefines()` in [`scripts/build-all.ts`](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-all.ts). The following values become string literals in the bundle and **cannot be changed at runtime**:

| Variable | Source |
|---|---|
| `DOSU_VERSION` | `package.json` version or `$DOSU_VERSION` env |
| `DOSU_WEB_APP_URL` | `.env.production` |
| `DOSU_BACKEND_URL` | `.env.production` |
| `SUPABASE_URL` | `.env.production` |
| `SUPABASE_ANON_KEY` | `.env.production` |
| `DOSU_INSTALL_CHANNEL` | `"npm"` for npm builds |

> **Runtime overrides**: The `*_OVERRIDE` variants (`DOSU_BACKEND_URL_OVERRIDE`, etc.) are read on every invocation and take precedence — useful for pointing a published `@alpha` build at a staging backend without rebuilding [[11]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L127-L143).

### Other build targets

| Script | Output | Target |
|---|---|---|
| `build` / `build:dev` | `bin/dosu` | Native Bun binary for the current platform (`--compile`) |
| `build:all` | `dist/dosu-*` | Cross-platform binaries for 7 targets (macOS, Linux, Windows) |

Binary builds use `bun build --compile` and are used for the Homebrew and direct-download distribution channels [[12]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-all.ts).

## Supply-Chain Security

### `minimumReleaseAge` gate

[`bunfig.toml`](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/bunfig.toml) configures a 3-day delay before Bun will resolve newly published package versions:

```toml
[install]
# Supply-chain hardening: ignore package versions published less than 3 days ago.
minimumReleaseAge = 259200
```

`259200` is the number of seconds in 72 hours. When you run `bun install` or `bun update`, Bun will refuse to select any package version that was published within the preceding 3 days [[13]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/bunfig.toml#L1-L3).

**Why this matters**: Typosquatting attacks and compromised package releases are typically detected and reverted within 24–72 hours. By delaying consumption of fresh releases, the project gets a window in which the wider ecosystem (npm security monitoring, community reports, automated scanners) can surface problems before they land in `bun.lock`.

### First-party exclusion

`@dosu/api-types` is excluded from the gate [[14]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/bunfig.toml#L4-L7):

```toml
minimumReleaseAgeExcludes = ["@dosu/api-types"]
```

This package is generated automatically from the Dosu backend's tRPC router (in the `dosu-ai/dosu` repository). Because the publish pipeline is entirely internal, the 3-day cool-off would only slow down adoption of freshly regenerated API types without providing any security benefit.

### `bun.lock` is committed

The lockfile is checked into version control for reproducible installs. This means every developer machine and every CI run resolves the exact same transitive dependency tree. To upgrade dependencies, run `bun update` (the `minimumReleaseAge` gate applies here too) and commit the resulting `bun.lock` changes.

## Version Constraints

### Node.js ≥ 22

The `engines` field in `package.json` [[15]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L34-L36) requires Node.js 22 or later:

```json
"engines": { "node": ">=22" }
```

The bundled `bin/dosu.js` targets the Node.js runtime used by end-users. Dropping support for older Node versions allows the codebase (and the bundle) to use modern JavaScript APIs without polyfills.

### `@trpc/client` and `@trpc/server` must match exactly

Both packages are pinned to the **same exact version** (currently `11.18.0`) [[16]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L44-L45):

```json
"@trpc/client": "11.18.0",
"@trpc/server": "11.18.0"
```

The typed client is derived from the server's router definition. If the two packages diverge — even by a patch version — you will see TypeScript type errors or subtle runtime mismatches. Always bump both together.

### `@dosu/api-types` is pinned exact

`@dosu/api-types` is pinned without a range operator [[17]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L40):

```json
"@dosu/api-types": "0.0.36"
```

The package is regenerated frequently from the backend's tRPC schema. Exact pinning makes version changes explicit and prevents silent drift when a new version is published. Update it deliberately after validating that the new types are compatible.

### TypeScript ^6.0.3

TypeScript is development-only and used solely for `tsc --noEmit` type-checking [[18]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L53). Bun handles compilation and bundling at every other step, so the TypeScript version constraint does not affect the produced bundle or runtime behavior.

## Rationale

The zero-runtime-dependency model is a deliberate tradeoff that benefits end-users at the cost of a slightly more complex build step. Here is why it is the right default for a CLI tool like `@dosu/cli` [[1]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L60-L64):

**Simpler installation**: Users run `npm install -g @dosu/cli` or `npx @dosu/cli` and receive a single file. There is no `node_modules` subtree to populate, no peer dependency conflict to resolve, and no risk of a broken install because a transitive package is incompatible with something else in the user's environment.

**Reduced attack surface at install time**: Every package that gets downloaded at install time is an opportunity for a supply-chain attack. By shipping a pre-built bundle, the supply-chain risk is limited to the maintainer's build environment. End-users do not run any untrusted install scripts.

**Consistent runtime behavior**: What the maintainer tests and publishes is exactly what the user runs. There is no version drift caused by `npm` or `bun` resolving a slightly different dependency graph in the user's environment.

**No peer-dependency conflicts**: Because nothing is resolved from the user's `node_modules` at runtime, the CLI works regardless of what other packages — including other versions of the same libraries — are installed in the user's project.

**Straightforward distribution across channels**: The same bundling approach works equally well for npm, Homebrew, and direct binary downloads. The only differences are the build target (`--target node` vs `--compile`) and the baked-in `DOSU_INSTALL_CHANNEL` value [[12]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-all.ts) [[19]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-release.sh).
