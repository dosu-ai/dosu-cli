# Dosu codebase audit

This is the full procedure for the **codebase audit** referenced from [../SKILL.md](../SKILL.md).
The goal: inspect the current repository and decide, with evidence, whether Dosu can help the
user by creating or refreshing four docs. Write the result to `.dosu/audit.json`
(see [audit-findings-schema.md](audit-findings-schema.md)), then tell the user to run
`dosu audit` so the Dosu CLI can ask them which docs to generate and open a PR.

You (the coding agent) only do the **triage** here — you have the live working tree, so you can
tell what exists, what's stale, and whether there's enough signal. You do **not** write the docs
themselves; Dosu cloud generates them and opens the PR after the user picks via `dosu audit`.

## When to run this

Run when the user asks Dosu to audit the repo, asks "what can Dosu do for this codebase?", or
asks to set up / refresh their agent docs, README, architecture doc, or dependency doc.

## The four doc types

| `task` | File | When Dosu can help |
|---|---|---|
| `generate-agents-md` | `AGENTS.md` | Missing, or present but stale/thin given the repo's structure, commands, and conventions. |
| `refresh-readme` | `README.md` | Present but **outdated** — references removed scripts/deps, missing setup steps, or describes features that no longer match the code. |
| `generate-architecture-md` | `architecture.md` | **Missing AND** there is genuinely enough structure to describe (multiple modules/services, clear layering). Do not recommend for a tiny or single-file repo. |
| `generate-deps-md` | `deps.md` | Missing, or present but out of sync with the actual dependency manifests. |

## Rules

- **Be evidence-based.** Prefer direct repo evidence over inference. Cite concrete `evidence`:
  file paths (and `path:line` where useful), manifest entries, config keys.
- **Gate `architecture.md` strictly.** Only set `can_help: true` for `generate-architecture-md`
  when the repo is large/structured enough that a useful architecture doc can be written. When in
  doubt, set `can_help: false`, `action: "skip"`, and a `rationale` saying why.
- **Distinguish status from action.** `status` is what you found (`missing` / `outdated` /
  `present_ok`); `action` is what Dosu should do (`create` / `update` / `skip`).
- **Include every type you assessed**, even when `can_help` is `false`, so the CLI can explain
  what it skipped and why.
- **Make `rationale` specific** — it is forwarded to Dosu cloud as generation guidance. "README's
  install section references a `make bootstrap` target that no longer exists" beats "README looks
  old."
- **Don't write the docs.** Producing the actual files is Dosu cloud's job, triggered by the user
  through `dosu audit`.

## Use Dosu MCP for org knowledge

Before finalizing recommendations, use the Dosu MCP tools to pull organization knowledge that
should inform the docs (architecture decisions, naming, conventions, prior docs). The exposed
tool set depends on the connection — always use what's actually listed:

1. Read first: call `read_knowledge` when listed (or `init_knowledge` on older connections) to
   get task-relevant context from the knowledge base.
2. Go deeper with whichever search/ask tools the server exposes — check whether the org already
   documents the architecture, dependencies, or agent conventions elsewhere. If it does, factor
   that into `status`/`rationale` (e.g. an existing architecture doc in Dosu may mean a repo
   `architecture.md` should mirror it).

If no Dosu deployment is connected (only public-library tools are available), skip the MCP step
and rely on repo evidence alone; note in the `rationale` that org knowledge wasn't consulted.

## Procedure

1. **Identify the repo.** Get the remote and slug:
   ```bash
   git config --get remote.origin.url
   ```
   Parse `owner/name` from it for `repo.slug`. If there is no GitHub remote, tell the user the
   audit needs a GitHub repo connected to Dosu and stop.

2. **Inspect the working tree** for each doc type. Useful starting points:
   ```bash
   ls -a
   # existing docs (any casing)
   ls AGENTS.md README.md architecture.md ARCHITECTURE.md deps.md DEPS.md docs/ 2>/dev/null
   # dependency manifests
   ls package.json pyproject.toml requirements*.txt go.mod Cargo.toml Gemfile pom.xml build.gradle 2>/dev/null
   ```
   - **AGENTS.md** — does it exist? If yes, is it consistent with the current build/test commands,
     directory layout, and contribution conventions? Read it and compare against `package.json`
     scripts / Makefile / CI config.
   - **README.md** — read it. Are the setup/build/run steps still accurate? Do referenced scripts,
     commands, env vars, and features still exist in the code? Mark `outdated` only with evidence.
   - **architecture.md** — does it exist? Is the repo structured enough to warrant one? Look at the
     top-level layout, number of modules/services, and whether there's a clear separation worth
     documenting.
   - **deps.md** — does it exist? If yes, does it match the actual manifests/lockfiles? If missing,
     are there real dependencies worth documenting?

3. **Consult Dosu MCP** (see above) to enrich and cross-check.

4. **Write `.dosu/audit.json`** following [audit-findings-schema.md](audit-findings-schema.md).
   Create the `.dosu/` directory if needed. Write one `items` entry per type you assessed.

5. **Tell the user to run the CLI.** End with a short message, e.g.:

   > Audit complete — I wrote `.dosu/audit.json`. Run `dosu audit` to choose which docs Dosu
   > should generate; it will open a PR with the ones you pick.

   Do not attempt to generate or commit the docs yourself.

## Example `.dosu/audit.json`

```json
{
  "version": 1,
  "generated_at": "2026-06-24T12:00:00Z",
  "repo": { "remote": "git@github.com:acme/widget.git", "slug": "acme/widget" },
  "items": [
    {
      "task": "generate-agents-md", "type": "agents", "file": "AGENTS.md",
      "status": "missing", "action": "create", "can_help": true, "confidence": "high",
      "rationale": "No AGENTS.md; repo has documented `pnpm test`/`pnpm build` scripts and a clear packages/ layout worth capturing for agents.",
      "evidence": ["package.json", "packages/", "CONTRIBUTING.md"]
    },
    {
      "task": "refresh-readme", "type": "readme", "file": "README.md",
      "status": "outdated", "action": "update", "can_help": true, "confidence": "medium",
      "rationale": "README's Getting Started references a `make bootstrap` target that no longer exists; setup now uses `pnpm install`.",
      "evidence": ["README.md:24", "Makefile", "package.json"]
    },
    {
      "task": "generate-architecture-md", "type": "architecture", "file": "architecture.md",
      "status": "missing", "action": "skip", "can_help": false, "confidence": "high",
      "rationale": "Single-package repo with one entry point; not enough structure to justify a separate architecture doc yet.",
      "evidence": ["src/index.ts"]
    },
    {
      "task": "generate-deps-md", "type": "deps", "file": "deps.md",
      "status": "missing", "action": "create", "can_help": true, "confidence": "medium",
      "rationale": "No deps doc; package.json has ~30 runtime deps across HTTP, DB, and queue concerns worth summarizing.",
      "evidence": ["package.json", "pnpm-lock.yaml"]
    }
  ]
}
```
