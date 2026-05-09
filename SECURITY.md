# Security Policy

Dosu CLI writes local MCP configuration and stores authentication material for
Dosu. Please report security issues privately so we can investigate before
details are public.

## Supported Versions

Security fixes target the current stable release line published to npm as
`@dosu/cli` and the current `main` branch. Pre-release or alpha builds may receive
fixes when they are part of the same upcoming release.

| Version | Supported |
| --- | --- |
| Current stable `@dosu/cli` | Yes |
| `main` | Yes |
| Older releases | Best effort |

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting from the repository Security tab when
available. If that is unavailable, email `security@dosu.dev` with:

- A description of the issue and expected impact.
- Steps to reproduce.
- Affected versions or commit SHAs.
- Any proof of concept code, with fake tokens and test data only.

We aim to acknowledge reports within 3 business days and share a remediation
plan or status update once we have reproduced the issue.

## Scope

Reports that are especially useful for this repository include:

- Token, refresh token, API key, or OAuth callback leakage.
- Writing credentials to unsafe file locations or unsafe permissions.
- Config injection in generated MCP server entries.
- Command execution or path traversal through provider configuration.
- Supply-chain issues in the published npm package or compiled binaries.

## Safe Harbor

We will not pursue legal action for good-faith security research that avoids
privacy violations, service disruption, data destruction, and persistence. Stop
testing and report promptly if you encounter sensitive data or credentials.
