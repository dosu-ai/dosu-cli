# Dependency Management

## Overview

`@dosu/cli` ships **zero runtime dependencies**. The `package.json` `"dependencies"` field is intentionally absent — every library the CLI needs at runtime is listed under `"devDependencies"` and bundled into a single self-contained file at build time [[1]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L16-L18).

When a user installs the CLI via npm, all they receive is `bin/dosu.js` — a pre-built JavaScript bundle with all dependencies already inlined. There is no transitive `node_modules` tree to install, no version resolution to perform, and nothing to upgrade on the end-user's machine.

```json
// package.json (abridged)
{
  "files": ["bin/dosu.js"],
  "bin": { "dosu": "bin/dosu.js" }
}
```

[[2]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L12-L18)

This architecture has several benefits:

- **Portability** — a single file is trivially distributable, symlinkable, or pinned in CI.
- **Simpler deployment** — no `npm install` step is required after package installation; the bundle is immediately executable.
- **Reduced attack surface** — supply-chain risk is confined to build time, not end-user install time.
- **Determinism** — the bundle published to npm is exactly what was built and tested in CI.

The runtime target is **Node.js ≥ 22**, declared via the `"engines"` field [[3]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L34-L36). npm will surface a warning to users on older Node versions before the CLI even runs.

## Key Dependencies

All dependencies live under `devDependencies` [[4]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L37-L56). They split into two groups: **runtime libraries** that are bundled into `bin/dosu.js`, and **tooling** that is only used during development and CI.

### Runtime Libraries (bundled into `bin/dosu.js`)

#### `commander` · `^15.0.0`

The CLI framework that powers every command and sub-command in Dosu. Commander parses `process.argv`, maps tokens to command handlers, validates option types, and generates `--help` output automatically. The top-level `Program` instance in `src/index.ts` is the root of the CLI tree [[5]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L48).

#### `@clack/prompts` · `^1.6.0`

An interactive terminal prompts library used throughout onboarding and setup flows. It provides spinners, text inputs, select menus, multi-selects, and confirmation prompts with a polished UX. Replacing lower-level readline handling with `@clack/prompts` keeps prompt logic declarative and consistent [[6]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L39).

#### `@trpc/client` · `11.18.0` *(exact pin)*

The tRPC client used to make type-safe HTTP calls to the Dosu backend. It is pinned alongside `@trpc/server` at the exact same version because both sides share the same inferred router types — any version skew causes TypeScript errors at build time [[7]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L44-L45).

#### `@trpc/server` · `11.18.0` *(exact pin)*

Paired with `@trpc/client`. Although the CLI is a tRPC *client*, the server package is required at build time to import shared router-type utilities and infer the procedure contract from `@dosu/api-types` [[8]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L45).

#### `@dosu/api-types` · `0.0.36` *(exact pin)*

First-party type package generated directly from the `dosu-ai/dosu` backend's tRPC router. It gives the CLI compile-time knowledge of every available API procedure, its input schema, and its output shape. The package is pinned exactly because the CLI and backend must share the same router revision — a mismatch causes silent type drift or runtime errors [[9]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L40).

> **Note:** `@dosu/api-types` is excluded from the 3-day supply-chain age gate (see [Supply Chain Security](#supply-chain-security)) because it is first-party and needs to be adopted immediately when the backend router changes.

#### `superjson` · `^2.2.6`

The tRPC transformer used on the client link. It extends JSON serialization to handle JavaScript types that vanilla `JSON.stringify` cannot round-trip faithfully — `Date`, `Map`, `Set`, `BigInt`, `undefined`, and `RegExp`. Without a shared transformer, dates would arrive at the client as plain strings [[10]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L52).

#### `picocolors` · `^1.1.1`

A tiny, zero-dependency terminal styling library used to colorize CLI output. It provides the standard ANSI color/style helpers (`red`, `green`, `bold`, `dim`, etc.) with a minimal footprint — important in a bundled CLI where every kilobyte matters [[11]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L50).

#### `open` · `^11.0.0`

Opens a URL in the user's default system browser. Used for OAuth authentication flows and directing users to the Dosu web app. The package abstracts cross-platform differences (`xdg-open` on Linux, `open` on macOS, `start` on Windows) [[12]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L49).

#### `write-file-atomic` · `^8.0.0`

Writes files atomically by writing to a temporary path and renaming into place. Used when persisting CLI configuration so that a crash or interrupt mid-write cannot leave a half-written, corrupted config file [[13]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L55).

***

### Tooling (not bundled into the output)

#### `@biomejs/biome` · `^2.5.0`

A fast all-in-one linter and formatter that replaces separate ESLint and Prettier configurations. Run via the `lint`, `format`, and `check` scripts .

```sh
bun run lint     # bunx biome lint .
bun run format   # bunx biome format .
bun run check    # bunx biome check .  (lint + format + apply safe fixes)
```

#### `vitest` · `^4.1.9` + `@vitest/coverage-v8` · `^4.1.9`

The test runner. `vitest` provides the test API and runner; `@vitest/coverage-v8` adds V8-native coverage instrumentation. Tests are executed with :

```sh
bun run test         # bunx vitest run (single pass)
bun run test:watch   # bunx vitest (watch mode)
```

#### `typescript` · `^6.0.3`

Used exclusively for type checking. The build pipeline uses Bun's native TypeScript transpiler and does not invoke `tsc` to emit output. TypeScript is only called for the `typecheck` script :

```sh
bun run typecheck   # bunx tsc --noEmit
```

#### `semantic-release` · `^25.0.5`

Automates version bumping, CHANGELOG generation, and npm publishing from conventional commit messages. Three plugins extend its behavior :

| Plugin | Role |
|---|---|
| `@semantic-release/changelog` | Writes `CHANGELOG.md` |
| `@semantic-release/exec` | Runs shell commands during the release lifecycle |
| `@semantic-release/git` | Commits back the updated changelog and `package.json` |

#### `@types/bun` · `^1.3.14`

TypeScript type definitions for Bun runtime APIs (e.g., `Bun.spawn`, `Bun.build`, `import.meta.dir`). Used in the `scripts/` build files, which are authored as Bun-native TypeScript [[18]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L46).

## Version Constraints

### Caret ranges (`^`) — the default

Most dependencies use caret ranges (e.g., `^15.0.0`), which allow Bun/npm to adopt newer **minor and patch** releases automatically while blocking major-version bumps. This keeps the dependency set reasonably up to date with bug fixes and non-breaking features without requiring manual intervention for each release [[4]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L37-L56).

### Exact pins — used where version parity is mandatory

Two dependency groups are pinned to exact versions:

| Package | Version | Reason |
|---|---|---|
| `@trpc/client` | `11.18.0` | Must match `@trpc/server` exactly; version skew causes TypeScript type errors |
| `@trpc/server` | `11.18.0` | See above |
| `@dosu/api-types` | `0.0.36` | First-party router contract; must match the deployed backend revision |



The tRPC packages are exact-pinned because the client infers its procedure types directly from the server's router definition. If the two packages are at different semver positions, the shared type utilities may diverge and cause build-time failures or silent runtime mismatches.

`@dosu/api-types` is exact-pinned for a similar reason: the package is auto-generated from the live `dosu-ai/dosu` backend router. A stale version means the CLI's type signatures do not reflect the actual API surface, which could cause undetected request/response shape mismatches.

### Adding a new dependency

When introducing a new runtime library:

1. Add it to `devDependencies` — **never** to `dependencies`.
2. Prefer a caret range unless version parity with another package is required.
3. Run `bun install` and verify the package passes the [supply chain age gate](#supply-chain-security) (new packages published within the last 3 days will be blocked).
4. Verify the bundle builds and the final `bin/dosu.js` size remains reasonable.

## Supply Chain Security

### `bunfig.toml` configuration

The repository's `bunfig.toml` configures a **3-day minimum release age gate** for all package installs [[19]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/bunfig.toml):

```toml
[install]
# Supply-chain hardening: ignore package versions published less than 3 days ago.
minimumReleaseAge = 259200
# Exception: @dosu/api-types is first-party — its publishes are generated from our own
# tRPC router (dosu-ai/dosu), not an external supply-chain risk — so the 3-day cool-off
# doesn't apply. Needed to adopt the regenerated 0.0.10 types (dosu PR #11218) promptly.
minimumReleaseAgeExcludes = ["@dosu/api-types"]
```

The value `259200` is 72 hours expressed in seconds (3 × 24 × 60 × 60 = 259,200).

### Why the gate exists

A common supply-chain attack pattern involves publishing a malicious version of a widely-used package, waiting for automated `bun install` or `npm install` runs to pull it in, then withdrawing the package before the community notices. The window of maximum impact is typically within the first hours after publication.

By refusing to install any package version published less than 3 days ago, the gate ensures:

1. **Community visibility** — 72 hours is enough time for the npm ecosystem to flag a compromised release before it lands in this codebase.
2. **Registry audit trails** — registries such as npmjs.com have more opportunity to act on abuse reports.
3. **Automated tooling buffer** — Dependabot and similar bots may surface an advisory before the cooling period expires.

The gate is enforced at `bun install` time. If a lock-file update attempts to pull in a too-new version, Bun will print an error and abort the install, forcing a human to review the situation.

### The `@dosu/api-types` exception

`@dosu/api-types` is excluded via `minimumReleaseAgeExcludes` for two reasons [[20]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/bunfig.toml#L4-L7):

- **First-party origin** — the package is auto-generated from the `dosu-ai/dosu` internal tRPC router. Its publishes originate from the same organization and are not an external supply-chain risk.
- **Operational urgency** — when the backend router changes, the CLI must adopt the new type contract promptly to remain compatible. The 3-day delay would block legitimate same-day deployments.

## Build Process

The project has three build modes, all driven by [Bun](https://bun.sh) and all starting from the same entry point: `src/index.ts`.

### npm bundle — `bin/dosu.js`

**Script:** `bun run build:npm`  
**Build script:** `scripts/build-npm.ts`

```sh
bun build --target node [...defines] src/index.ts --outfile bin/dosu.js
```

[[21]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-npm.ts#L35-L36)

This is the artifact distributed via npm. The `--target node` flag tells Bun to produce a plain JavaScript bundle compatible with any Node.js ≥ 22 runtime, rather than a self-contained executable. All imported modules — commander, @clack/prompts, @trpc/client, superjson, picocolors, and every other runtime library — are inlined into the single output file.

After bundling, `normalizeNodeBundle()` post-processes the file to [[22]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-npm.ts#L15-L29):

1. Set the shebang to `#!/usr/bin/env node` (replacing any Bun-specific shebang).
2. Remove the `// @bun` comment marker that Bun injects.
3. Ensure the file ends with a newline.

The result is a portable, directly-executable JavaScript file. It is the only file listed in `"files"` in `package.json` [[1]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L16-L18), so it is the only file shipped to npm consumers.

### Single-platform binary — `bin/dosu`

**Script:** `bun run build`  
**Build script:** `scripts/build-compile.ts`

```sh
bun build --compile [...defines] src/index.ts --outfile bin/dosu
```

[[23]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-compile.ts#L24)

The `--compile` flag produces a self-contained native binary for the current host platform using Bun's embedded runtime. This is the recommended local development binary — it runs without any Node.js installation and starts up faster than the JavaScript bundle.

### Cross-platform binaries — `dist/`

**Script:** `bun run build:all`  
**Build script:** `scripts/build-all.ts`

Compiles for all seven supported targets in a sequential loop :

| Target | Output file |
|---|---|
| `bun-darwin-arm64` | `dosu-darwin-arm64` |
| `bun-darwin-x64` | `dosu-darwin-x64` |
| `bun-linux-x64-baseline` | `dosu-linux-x64` |
| `bun-linux-arm64` | `dosu-linux-arm64` |
| `bun-linux-x64-musl` | `dosu-linux-x64-musl` |
| `bun-linux-arm64-musl` | `dosu-linux-arm64-musl` |
| `bun-windows-x64-baseline` | `dosu-windows-x64.exe` |

Both musl variants cover Alpine Linux and similar minimal container images.

### Environment variable injection

Neither compiled binaries nor the npm bundle inherit `process.env` from the build machine at runtime — compiled binaries embed only what is baked in at compile time. All six configuration values are injected via `--define` flags by the shared `buildDefines()` function [[25]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/scripts/build-all.ts#L41-L63):

| Variable | Default |
|---|---|
| `DOSU_VERSION` | `package.json` `version` field |
| `DOSU_WEB_APP_URL` | `""` |
| `DOSU_BACKEND_URL` | `""` |
| `SUPABASE_URL` | `""` |
| `SUPABASE_ANON_KEY` | `""` |
| `DOSU_INSTALL_CHANNEL` | `"npm"` |

Production builds source these from `.env.production` via `--env-file=.env.production` [[26]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L22-L25). Development builds use `.env.development`.

### `prepack` hook

The `"prepack"` script in `package.json` runs `build:npm` automatically before `npm pack` or `npm publish` [[27]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/package.json#L32). This guarantees that the published bundle is always freshly built from source and is never accidentally stale.
