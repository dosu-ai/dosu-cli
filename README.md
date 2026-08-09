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

Run the wizard from inside the Git project you want to configure. It authenticates
you via browser OAuth, lets you pick a Dosu deployment (or OSS / public-library
mode), mints an API key, detects installed AI tools, and writes their supported
MCP, instruction, and skill files into that project. Credentials stay in the
private Dosu user config and are never written into the repository.

Project MCP entries launch a pinned Dosu CLI through `npx`, so Node.js 22+ and
`npx` must also be available when the AI tool starts. See the
[project-scoped setup contract](docs/project-scoped-agent-setup.md) for paths,
migration safety, and clients that only support global configuration.

On a re-run, an exact Dosu project entry keeps the project pinned to its existing
deployment even if another deployment is active globally; an explicit target is
required to retarget it. After the project MCP completes an initialize check and
the whole project bundle is re-read successfully, setup removes only exact,
proven legacy Dosu MCP and rule globals. Ambiguous or unsupported entries are
preserved; old global skills are always kept because setup and explicit standalone
installs cannot be distinguished. Recoverable backups and receipts stay in the
private Dosu config directory.

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
| `dosu mcp list` | List supported AI tools |
| `dosu mcp add <tool>` | Add the Dosu MCP server to a specific tool |
| `dosu logs` | View or manage debug logs (`--tail`, `--clear`) |

`dosu mcp add` takes `-g, --global` to install for all projects instead of project-local, and `--show-secret` to print the full manual config.

### Platform commands

Once authenticated against a deployment, you can drive the Dosu platform without leaving the terminal:

| Command | Description |
|---|---|
| `dosu ask` | Ask a question and get an AI-generated answer |
| `dosu knowledge` | Search and browse your knowledge base |
| `dosu docs` | Manage documents (list, create, update, import, publish, AI-generate) |
| `dosu suggest` | Review and manage AI document suggestions |
| `dosu threads` | List and manage conversation threads |
| `dosu review` | Document review workflow |
| `dosu sources` | Manage connected data sources (list, sync, update) |
| `dosu integrations` | List and inspect platform integrations (Slack, GitHub, …) |
| `dosu tags` | List knowledge base tags and tagged pages |
| `dosu members` | Manage team members and access requests |
| `dosu org` | Show organization information |
| `dosu deployments` | List / show / switch deployments |
| `dosu analytics` | View usage statistics |
| `dosu insights` | Open a visual report of your Dosu space activity |
| `dosu skill` | Install / update / remove the Dosu agent skill |
| `dosu hooks` | Install / remove / diagnose Dosu coding-agent hooks |

Run `dosu <command> --help` for subcommands and flags.

### Supported AI tools

The setup wizard supports project-scoped configuration for `claude`, `cursor`,
`vscode`, `codex`, `gemini`, `zed`, `copilot`, `opencode`, `antigravity`,
`mcporter`, and `factory`. `dosu mcp add <id> --global` remains available as an
explicit opt-in for global-only clients such as Claude Desktop, Windsurf, and
Cline; the wizard does not silently fall back to global scope.
The `manual` ID only prints connection values for a user-managed client; it does
not accept `--global` because the CLI has no target path on which to record safe
ownership intent.

Project-default `dosu mcp add <id>` checks every supported client in the
repository before writing, so it cannot create conflicting project targets. Use
`--retarget` only to replace that agent's existing Dosu pin (and any client that
shares the same project MCP file); use `dosu setup` when several independent
project agents must move together.

| ID | Tool |
|---|---|
| `claude` | Claude Code |
| `claude-desktop` | Claude Desktop |
| `cursor` | Cursor |
| `vscode` | VS Code |
| `codex` | Codex CLI |
| `gemini` | Gemini CLI |
| `windsurf` | Windsurf |
| `zed` | Zed |
| `cline` | Cline |
| `cline-cli` | Cline CLI |
| `copilot` | GitHub Copilot CLI |
| `opencode` | OpenCode |
| `antigravity` | Antigravity |
| `mcporter` | MCPorter |
| `factory` | Factory |
| `manual` | Manual Configuration (prints config to paste yourself) |

### Non-interactive / agent setup

For coding agents and CI, `setup` has a non-interactive mode:

```bash
dosu setup --agent --tool claude
```

Combine with `dosu login --request` / `--check <ticket>` for human-in-the-loop authentication, and `--mode oss|cloud` to skip the mode prompt.

## Configuration

The login session and active deployment live in
`~/.config/dosu-cli/config.json`. Project MCP credentials are stored separately as
private per-user, per-target records under
`~/.config/dosu-cli/project-mcp-credentials.v1/`; repository files contain no API
key or endpoint. `dosu logout` clears both credential stores. Set `DOSU_DEV=true`
to isolate config under `~/.config/dosu-cli-dev/`.

To repoint a published build at a different backend without rebuilding, set any of these runtime overrides:

- `DOSU_WEB_APP_URL_OVERRIDE`
- `DOSU_BACKEND_URL_OVERRIDE`
- `SUPABASE_URL_OVERRIDE`
- `SUPABASE_ANON_KEY_OVERRIDE`

## Development

```bash
bun install        # install dependencies
bun run dev        # run the CLI from source
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
