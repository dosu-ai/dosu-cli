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

The interactive wizard authenticates you via browser OAuth, lets you pick a Dosu deployment (or OSS / public-library mode), mints an API key, detects which AI tools you have installed, and writes the Dosu MCP server entry into each one's config. Restart your AI tool and Dosu is available. [[1]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L10-L18) [[2]](https://app.dosu.dev/documents/6c889b78-08e3-43cf-8519-2cea8d086db6)

Run `dosu` with no arguments any time to open the interactive menu.

## Installation

### npx / npm (Recommended)

Requires Node.js 22+. [[3]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L22-L35)

```bash
npx @dosu/cli setup
```

Or install globally:

```bash
npm install -g @dosu/cli
dosu setup
```

### curl / install (macOS / Linux)

Downloads and installs the latest stable release binary. [[4]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L37-L49)

```bash
curl -fsSL https://raw.githubusercontent.com/dosu-ai/dosu-cli/main/install.sh | sh
```

To install a specific release tag:

```bash
DOSU_INSTALL_VERSION=v0.2.0-rc1 curl -fsSL https://raw.githubusercontent.com/dosu-ai/dosu-cli/main/install.sh | sh
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

Download the appropriate archive from the [Releases](https://github.com/dosu-ai/dosu-cli/releases) page. [[5]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L64-L66)

#### macOS Gatekeeper Warning

When downloading directly from GitHub releases on macOS, you may see: [[6]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L68-L83)

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

`dosu mcp add` takes `-g, --global` to install for all projects instead of project-local, and `--show-secret` to print the full manual config. [[7]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L87-L101) [[8]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/src/cli/cli.ts#L232-L296)

### Platform commands

Once authenticated against a deployment, you can drive the Dosu platform without leaving the terminal: [[9]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L102-L125) [[10]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/src/cli/cli.ts#L299-L314)

| Command | Description |
|---|---|
| `dosu ask` | Ask a question and get an AI-generated answer |
| `dosu audit` | Consume coding-agent audit findings (`.dosu/audit.json`), ensure the repo is connected and indexed in Dosu, then fire server-side doc-generation tasks non-blocking; the resulting PR is surfaced on the next CLI run [[11]](https://github.com/dosu-ai/dosu-cli/pull/95) |
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

#### `dosu audit` flags

The `dosu audit` command supports both interactive and agent-driven modes [[11]](https://github.com/dosu-ai/dosu-cli/pull/95) [[12]](https://github.com/dosu-ai/dosu-cli/pull/95):

| Flag | Description |
|---|---|
| `--tasks <ids>` | Fire specific task IDs non-interactively (agent-driven mode — never prompts or opens a browser) |
| `--findings` | Path to a findings file to use instead of `.dosu/audit.json` |
| `--data-source-id` | Scope audit to a specific connected data source |
| `--yes` | Auto-confirm all prompts |
| `--json` | Emit machine-readable JSON output |

In interactive mode, `dosu audit` presents a multiselect of available documentation tasks pre-populated with the most confident, actionable items from the agent's findings. Generated documentation PRs are surfaced on the next CLI run via a `✓ Dosu PR ready: <url>` notice. [[12]](https://github.com/dosu-ai/dosu-cli/pull/95)

### Supported AI tools

`dosu mcp add <id>` and the setup wizard support: [[13]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L127-L149) [[14]](https://app.dosu.dev/documents/9c2ce81b-ea49-475a-bd8e-a10e7975599b)

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

For coding agents and CI, `setup` has a non-interactive mode: [[15]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L150-L158)

```bash
dosu setup --agent --tool claude
```

Combine with `dosu login --request` / `--check <ticket>` for human-in-the-loop authentication, and `--mode oss|cloud` to skip the mode prompt.

## Configuration

Credentials and the selected deployment live in `~/.config/dosu-cli/config.json`. Set `DOSU_DEV=true` to isolate config under `~/.config/dosu-cli-dev/`. [[16]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L160-L162) [[17]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L155-L158)

To repoint a published build at a different backend without rebuilding, set any of these runtime overrides: [[18]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L138-L153)

- `DOSU_WEB_APP_URL_OVERRIDE`
- `DOSU_BACKEND_URL_OVERRIDE`
- `SUPABASE_URL_OVERRIDE`
- `SUPABASE_ANON_KEY_OVERRIDE`

## Contributing

### Development setup

```bash
bun install        # install dependencies
bun run dev        # run the CLI from source
bun run test       # run tests (vitest)
bun run check      # lint + format check (Biome)
bun run typecheck  # tsc --noEmit
```

See [AGENTS.md](AGENTS.md) for architecture and contributor notes. [[19]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L9-L27)

### Code style

The project uses [Biome](https://biomejs.dev) for linting and formatting: 2-space indent, double quotes, semicolons, trailing commas, line width 100. Run `bun run check` before opening a pull request. [[20]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L66-L70)

### Commit convention

This project uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning. **Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) to trigger a release.** Non-conforming messages are ignored by the pipeline. [[21]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L72-L98)

```
<type>[optional scope]: <description>
```

| Type | Release impact | Example |
|---|---|---|
| `fix:` | patch (0.0.x) | `fix: handle empty config file without crash` |
| `feat:` | minor (0.x.0) | `feat: add OSS mode support to setup flow` |
| `fix!:` / `feat!:` | **major (x.0.0)** | `feat!: remove legacy auth flow` |
| `docs:` | none | `docs: update README with new CLI flags` |
| `chore:` | none | `chore: upgrade vitest to v3` |
| `refactor:` | none | `refactor: extract provider factory` |
| `test:` | none | `test: add coverage for MCP config edge cases` |
| `ci:` | none | `ci: upgrade GitHub Actions to v6` |

### Testing

Tests live alongside source files as `*.test.ts` and run with Vitest using `pool: "forks"`. Coverage thresholds are enforced at 95% statements, 90% branches, 80% functions, and 95% lines. [[22]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L52-L58)

Run a single module's tests with:

```bash
bunx vitest run src/commands/audit
```

### Reporting issues and pull requests

Open an issue or pull request on [GitHub](https://github.com/dosu-ai/dosu-cli). When reporting a bug, include the output of `dosu status` and any relevant logs from `dosu logs --tail 50`.

## Releasing (for maintainers)

Releases are fully automated with [semantic-release](https://github.com/semantic-release/semantic-release) — there are no manual version tags. Every push to a release branch is analyzed for [Conventional Commit](https://www.conventionalcommits.org/) messages, which determine the version bump. [[23]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L183-L194)

| Branch | npm dist-tag | Version shape |
|---|---|---|
| `main` | `latest` | `0.20.1` |
| `alpha` | `alpha` | `0.20.1-alpha.1` |

On a qualifying push, the CI pipeline bumps the version, builds binaries for all platforms, creates a GitHub release with the archives, publishes to npm, and (for stable releases only) updates the Homebrew formula. [[24]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/AGENTS.md#L101-L125)

Commit messages that don't follow Conventional Commits are invisible to semantic-release and won't trigger a release. See [AGENTS.md](AGENTS.md) for the full type → release-impact table and the alpha channel workflow.

## License

MIT — see the `license` field in [package.json](package.json). [[25]](https://github.com/dosu-ai/dosu-cli/blob/0097d4bdbd680baee4bcee8f9a881820e8f2397e/README.md#L196-L199)
