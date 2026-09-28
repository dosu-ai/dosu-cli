# `.dosu/audit.json` — audit findings schema

The codebase audit (see [audit.md](audit.md)) writes its result to `.dosu/audit.json` at the
repo root. This file is the contract between the audit you run in the coding agent and the
`dosu audit` CLI command, which reads it, asks the user which docs to generate, and kicks off
generation on Dosu cloud.

Write valid JSON matching this shape exactly. Do not add fields the CLI doesn't expect.

```json
{
  "version": 1,
  "generated_at": "2026-06-24T12:00:00Z",
  "repo": {
    "remote": "git@github.com:org/repo.git",
    "slug": "org/repo"
  },
  "items": [
    {
      "task": "generate-agents-md",
      "type": "agents",
      "file": "AGENTS.md",
      "status": "missing",
      "action": "create",
      "can_help": true,
      "confidence": "high",
      "rationale": "No AGENTS.md found; the repo has a clear src/ layout, a documented test command, and commit conventions worth capturing for agents.",
      "evidence": ["package.json", "src/cli/cli.ts", "CONTRIBUTING.md"]
    }
  ]
}
```

## Top-level fields

| Field | Type | Notes |
|---|---|---|
| `version` | number | Always `1`. The CLI rejects other versions. |
| `generated_at` | string | ISO 8601 timestamp of when the audit ran. |
| `repo.remote` | string | The `git remote origin` URL, verbatim. |
| `repo.slug` | string | `owner/name` parsed from the remote (e.g. `dosu-ai/dosu-cli`). |
| `items` | array | One entry per doc type you assessed. Include an entry for every type you looked at, even when `can_help` is `false` — the CLI uses these to explain what it skipped. |

## Item fields

| Field | Type | Allowed values | Notes |
|---|---|---|---|
| `task` | string | `generate-agents-md`, `refresh-readme`, `generate-architecture-md`, `generate-deps-md` | The backend capability id this item maps to. Must be one of these exact strings. |
| `type` | string | `agents`, `readme`, `architecture`, `deps` | Short doc-type key. |
| `file` | string | — | The target filename in the repo (e.g. `AGENTS.md`, `README.md`, `architecture.md`, `deps.md`). Use the casing already present in the repo when updating an existing file. |
| `status` | string | `missing`, `outdated`, `present_ok` | What you found in the working tree. |
| `action` | string | `create`, `update`, `skip` | What Dosu should do. `create` when `missing`; `update` when `outdated`; `skip` when `present_ok` (or when not enough info). |
| `can_help` | boolean | — | Whether Dosu should offer this. `false` ⇒ the CLI shows it as not recommended (or omits it). |
| `confidence` | string | `high`, `medium`, `low` | Your confidence in the recommendation. |
| `rationale` | string | — | One or two sentences explaining the recommendation, citing what you saw. This is passed to Dosu cloud as generation guidance, so make it specific. |
| `evidence` | string[] | — | Repo-relative paths (and optionally `path:line`) that justify the finding. |

## Mapping of `task` ↔ `type` ↔ `file`

| `task` | `type` | typical `file` |
|---|---|---|
| `generate-agents-md` | `agents` | `AGENTS.md` |
| `refresh-readme` | `readme` | `README.md` |
| `generate-architecture-md` | `architecture` | `architecture.md` |
| `generate-deps-md` | `deps` | `deps.md` |
