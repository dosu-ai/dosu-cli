# Contributing to Dosu CLI

Thanks for helping improve Dosu CLI. This project installs and manages Dosu's MCP
configuration across local developer tools, so changes should be careful with
credentials, local files, and cross-platform behavior.

## Development Setup

Install dependencies:

```bash
bun install
```

Run the CLI from source:

```bash
bun run dev
```

Run against local development config paths:

```bash
bun run dev:local
```

`DOSU_DEV=true` keeps CLI config under `~/.config/dosu-cli-dev/` so development
runs do not overwrite your normal Dosu CLI credentials.

## Common Checks

Before sending a change, run the smallest useful checks for your edit:

```bash
bun run typecheck
bun run check
bun run test
```

Focused test runs are encouraged while iterating:

```bash
bunx vitest run src/config
bunx vitest run src/auth/flow
bunx vitest run src/mcp/providers/providers-install.test.ts
```

## Pull Request Expectations

Please keep pull requests focused and include:

- A short summary of the user-facing behavior.
- The validation commands you ran.
- Any known cross-platform impact, especially macOS, Linux, Windows, or shell differences.
- Screenshots or terminal output only when they clarify behavior.

For CLI output changes, include tests that assert the exact important text. For
config-writing changes, include tests that use temporary directories and avoid
touching a contributor's real home directory.

## Commit Messages

This repository uses semantic-release. Use Conventional Commits so releases can
be calculated automatically:

```text
fix: handle missing API key before writing MCP config
feat: add provider support for a new agent
docs: update setup instructions
test: cover JSONC config parsing
```

Use `fix!:` or `feat!:` only for intentional breaking changes.

## Security and Secrets

Do not include real access tokens, refresh tokens, API keys, customer data, or
private repository contents in issues, pull requests, screenshots, tests, or
fixtures. Prefer obviously fake values such as `sk_user_test`, `tok_test`, or
`dep_test`.

Security-sensitive reports should follow [SECURITY.md](./SECURITY.md), not a
public issue.

## AI-Assisted Contributions

AI tools are welcome, but the contributor is responsible for the submitted
change. Please review generated code for correctness, licensing, secrets, and
fit with the existing architecture before opening a pull request.

## License and Contribution Rights

By submitting a contribution, you agree that your contribution is provided under
the license in this repository. Only submit code, documentation, or assets that
you have the right to contribute.
