# dosu-cli

> Connect [Dosu](https://dosu.dev) to your AI coding tools. `dosu` authenticates you, picks a Dosu deployment, and wires the Dosu MCP server into Claude Code, Cursor, Codex, and more — plus commands to drive the Dosu platform from your terminal.

[![npm version](https://img.shields.io/npm/v/@dosu/cli.svg)](https://www.npmjs.com/package/@dosu/cli)
[![CI](https://github.com/dosu-ai/dosu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/dosu-ai/dosu-cli/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/dosu-ai/dosu-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/dosu-ai/dosu-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

## Quick Start

```bash
npx @dosu/cli setup
```

The interactive wizard authenticates you via browser OAuth, lets you pick a Dosu deployment (or OSS / public-library mode), mints an API key, detects which AI tools you have installed, and writes the Dosu MCP server entry into each one's config. Restart your AI tool and Dosu is available.

Run `dosu` with no arguments any time to open the interactive menu.

## Installation

### npx / npm (Recommended)

Requires Node.js 22+.

```bash
npx @dosu/cli setup
```

Or install globally:

```bash
npm install -g @dosu/cli
dosu setup
```

### curl / install (macOS / Linux)

Requires Node.js 22+. Installs `@dosu/cli` globally via npm and runs `dosu setup` interactively.

```bash
curl -fsSL https://cli.dosu.dev/install.sh | sh
```

To install a specific release tag:

```bash
DOSU_INSTALL_VERSION=v0.2.0-rc1 curl -fsSL https://cli.dosu.dev/install.sh | sh
```

### Homebrew

```bash
brew install dosu-ai/dosu/dosu
```

Or tap first:

```bash
brew tap dosu-ai/dosu
brew install dosu
```

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
| `dosu status` | Show current authentication and MCP status |
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

`dosu mcp add <id>` and the setup wizard support:

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
