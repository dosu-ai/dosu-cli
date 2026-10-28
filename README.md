# dosu-cli

> Connect [Dosu](https://dosu.dev) to your AI coding tools. `dosu` authenticates you, picks a Dosu deployment, and wires the Dosu MCP server into Claude Code, Cursor, Codex, and more — plus commands to drive the Dosu platform from your terminal.

[![npm version](https://img.shields.io/npm/v/@dosu/cli.svg)](https://www.npmjs.com/package/@dosu/cli)
[![CI](https://github.com/dosu-ai/dosu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/dosu-cli/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/dosu-ai/dosu-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/dosu-ai/dosu-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

## Quick Start

```bash
curl -fsSL https://cli.dosu.dev/install | sh
```

The interactive wizard authenticates you via browser OAuth, lets you pick a Dosu deployment (or OSS / public-library mode), mints an API key, detects which AI tools you have installed, and writes the Dosu MCP server entry into each one's config. Restart your AI tool and Dosu is available.

Run `dosu` with no arguments any time to open the interactive menu.

## Installation

### curl / install (macOS / Linux) (Recommended)

Downloads and installs the latest stable release binary.

```bash
curl -fsSL https://cli.dosu.dev/install | sh
```

To install a specific release tag:

```bash
DOSU_INSTALL_VERSION=v0.2.0-rc1 curl -fsSL https://cli.dosu.dev/install | sh
```

### npx / npm

Requires Node.js 22+.

```bash
npx @dosu/cli setup
```

Or install globally:

```bash
npm install -g @dosu/cli
dosu setup
```

### Homebrew

```bash
brew install dosu-ai/dosu/dosu
```

The fully qualified name works on every Homebrew version: it taps the repo if needed and, on Homebrew 6.0+, records trust for just the `dosu` formula. To use tapped short names instead:

```bash
brew tap dosu-ai/dosu
brew trust dosu-ai/dosu   # Homebrew 6.0+ only — skip on older versions
brew install dosu
```

**Homebrew 6.0+ only** ([tap trust](https://docs.brew.sh/Tap-Trust), since June 2026): third-party taps start untrusted, so short-name installs or upgrades — including on machines that tapped `dosu-ai/dosu` before upgrading Homebrew — fail with `Error: Refusing to load formula dosu-ai/dosu/dosu from untrusted tap dosu-ai/dosu` until a one-time `brew trust dosu-ai/dosu` (the tap also ships [decant](https://github.com/dosu-ai/decant)). Homebrew 5 and earlier has no trust step and needs none. Tap trust is Homebrew's own consent step, separate from the macOS Gatekeeper warning below — Homebrew installs never trigger Gatekeeper.

### Manual Download

Download the appropriate archive from the [Releases](https://github.com/dosu-ai/dosu-cli/releases) page.

#### macOS Gatekeeper Warning

When downloading directly from GitHub releases on macOS, you may see:

> "Apple could not verify dosu is free of malware that may harm your Mac or compromise your privacy."

This happens because the binary is not signed with an Apple Developer certificate. To bypass this:

```bash
# After extracting the archive, remove the quarantine attribute:
xattr -d com.apple.quarantine ./dosu
```

Or right-click the binary, select "Open", and click "Open" in the dialog.

**Note:** Installing via Homebrew avoids this issue automatically.

## Usage

### Core commands

| Command | Description |
|---|---|
| `dosu` | Launch the interactive TUI menu |
| `dosu setup` | Run the setup wizard (auth → deployment → detect tools → configure) |
| `dosu login` | Authenticate with Dosu via browser OAuth |
| `dosu logout` | Clear saved credentials |
| `dosu status [--json]` | Show current authentication and MCP status |
| `dosu upgrade` | Update Dosu through the package manager that installed it, re-running `dosu setup` when the update changes agent config |
| `dosu mcp list` | List supported AI tools |
| `dosu mcp add <tool>` | Add the Dosu MCP server to a specific tool |
| `dosu mcp refresh` | Rewrite the Dosu MCP entry in every already-configured tool from the current setup |
| `dosu logs` | View or manage debug logs (`--tail`, `--clear`) |

`dosu mcp add` takes `-g, --global` to install for all projects instead of project-local, and `--show-secret` to print the full manual config.

`dosu upgrade` delegates to npm, pnpm, Yarn Classic, or Homebrew only after confirming which manager owns the current installation. Temporary package-runner invocations stay ephemeral, ambiguous or local installs are left unchanged, and standalone binaries receive the latest safe manual download path. After a successful update it hands off to the new version, which, only when a configured agent's MCP entry is out of date, runs `dosu setup` (or the non-interactive `dosu mcp refresh` without a TTY). An entry is out of date when it doesn't match the shape the current provider code writes. Upgrades done outside `dosu upgrade` (npm, brew, `npx @dosu/cli@latest`) get a safety net: on the first command of a new version, the CLI checks each configured provider, silently rewrites only the out-of-date entries, and prompts you to run `dosu setup` for the rest.

Dosu also updates itself automatically. When the update check (every six hours) finds a newer release, npm, pnpm, Yarn Classic, and Homebrew installs start the same package-manager update in a detached background process. The current command runs unchanged, and your next command uses the new version, whose first run applies the MCP refresh above. Hooks, rules, and the status line still need `dosu setup` when a release changes them. Background updates never run for `npx` invocations, standalone binaries, CI, or `DOSU_DEV=true`. A failed install (for example, a global npm prefix that needs `sudo`) falls back to the "Run `dosu upgrade`" notice and is retried after six hours. Turn background updates off with `dosu upgrade --auto off` (and back on with `--auto on`), or with `DOSU_DISABLE_AUTOUPDATE=1` for a single environment.

### Session commands

| Command | Description |
|---|---|
| `dosu sync` | Ship finished local agent sessions to Dosu memory or your own session store |
| `dosu knowledge` | Capture finished agent sessions: `sync`, `hooks`, `incognito`, `scope`, `statusline`, `transcripts` |
| `dosu memory` | Search Dosu memory, learned from earlier agent sessions, as an agent's MCP tools do |
| `dosu project` | Show or link the project key Dosu memory scopes a directory's sessions by |
| `dosu sources` | Bucket targets connected to Dosu, which pulls their sessions into memory (`setup`, `connect`, `status`, `sync`, `disconnect`) |
| `dosu get <session>` | Show a shipped session: its metadata and current trace |
| `dosu export <session>` | Write a shipped session's current trace as JSON |
| `dosu changes` | List a target's change feed: traces published, sessions redacted |
| `dosu redact <session>` | Remove a shipped session from its target |

Run `dosu <command> --help` for subcommands and flags.

### Supported AI tools

`dosu mcp add <id>` and the setup wizard support the coding agents whose sessions Dosu can learn from — each one keeps a session log on disk that [`@letta-ai/trajectory`](https://github.com/letta-ai/trajectory) normalizes:

| ID | Tool |
|---|---|
| `claude` | Claude Code |
| `cursor` | Cursor |
| `codex` | Codex CLI |
| `gemini` | Gemini CLI |
| `copilot` | GitHub Copilot CLI |
| `opencode` | OpenCode |
| `factory` | Factory (droid) |
| `pi` | Pi (installs the Dosu pi extension; global only) |
| `manual` | Manual Configuration (prints config to paste yourself) |

Tools with no such log (Claude Desktop, VS Code, Windsurf, Zed, Cline, Antigravity, MCPorter, ...) can still reach Dosu's MCP server: `dosu mcp add manual` prints the entry to paste into their config. The CLI no longer writes it for them, since nothing it does for them beyond that entry could learn from their sessions.

### Non-interactive / agent setup

For CI and headless machines, `dosu login --no-browser` prints a URL to open elsewhere and waits
for the sign-in, and `dosu setup --mode oss|cloud` skips the mode prompt.

### Studying sessions: status line and incognito

With `dosu knowledge hooks enable`, Dosu studies finished coding-agent sessions in the background
and turns what it learns into shared knowledge. Two switches make that visible and controllable per
session. `dosu setup` installs both alongside the hook; they can also be managed directly:

```bash
dosu knowledge statusline enable|disable [claude|cursor]   # status-bar line in Claude Code / Cursor CLI
dosu knowledge incognito on|off [claude|cursor|codex]      # stop/resume studying an agent's sessions
dosu knowledge incognito status                            # which agents are incognito
```

The status line shows one of `📚 Dosu studying…` (a sync run is live), `📚 Dosu on`,
`👻 Dosu incognito`, `⚪ Dosu paused`, `⚪ Dosu not studying this repo`, or `⚪ Dosu off`. Every
session is studied unless you limit studying to picked repos under `dosu` → settings → study
scope. In an interactive terminal with more than one repo, `dosu setup` asks which repos' sessions
to ship before offering the backfill of recent sessions. Selecting every repo clears the scope, so
new repos are included automatically. The choice is saved as the study scope; change it later under
`dosu` → settings → study scope or with `dosu knowledge scope set`. Notes from a session with a
known repo and branch are anchored to that branch; the rest are unanchored and reach topics
immediately. Neither setup nor `enable` replaces a status line you
already have; they print the one-liner to add to your own script instead.

`incognito on` is a saved per-agent setting: none of that agent's sessions are studied until you
turn it off. Turning it off resumes studying only new sessions going forward; sessions that
finished while incognito was on stay unstudied permanently, even if a later sync picks them up.
To keep a single chat out instead, type `/dosu-incognito` in it; setup installs that command with
the hook. It marks the session's transcript so studying skips it (the whole session, and for the
rest of it — start a new session to turn Dosu back on) and tells the model not to use Dosu
tools. See [docs/syncing.md](docs/syncing.md).

## Configuration

Credentials and the selected deployment live in `~/.config/dosu-cli/config.json`. Set `DOSU_DEV=true` to isolate config under `~/.config/dosu-cli-dev/`.

To repoint a published build at a different backend without rebuilding, set any of these runtime overrides:

- `DOSU_WEB_APP_URL_OVERRIDE`
- `DOSU_BACKEND_URL_OVERRIDE`
- `SUPABASE_URL_OVERRIDE`
- `SUPABASE_ANON_KEY_OVERRIDE`

## Development

```bash
bun install        # install dependencies
bun run dev        # run the CLI from source
bun run dev:local  # same, against the local Dosu stack (.env.development)
bun run test       # run tests (vitest)
bun run check      # lint + format check (Biome)
bun run typecheck  # tsc --noEmit
```

See [AGENTS.md](AGENTS.md) for architecture and contributor notes.

## Releasing (for maintainers)

Releases are fully automated with [semantic-release](https://github.com/semantic-release/semantic-release) — there are no manual version tags. Every push to a release branch is analyzed for [Conventional Commit](https://www.conventionalcommits.org/) messages, which determine the version bump.

| Branch | npm dist-tag | Version shape |
|---|---|---|
| `main` | `latest` | `0.20.1` |
| `alpha` | `alpha` | `0.20.1-alpha.1` |

On a qualifying push, the CI pipeline bumps the version, builds binaries for all platforms, creates a GitHub release with the archives, publishes to npm, and (for stable releases only) updates the Homebrew formula.

Commit messages that don't follow Conventional Commits are invisible to semantic-release and won't trigger a release. See [AGENTS.md](AGENTS.md) for the full type → release-impact table and the alpha channel workflow.

## License

MIT — see the `license` field in [package.json](package.json).
