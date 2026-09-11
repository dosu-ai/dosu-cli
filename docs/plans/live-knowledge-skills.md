# Live Knowledge Skills — implementation plan

Status: plan, not implemented. Prepared 2026-09-11 on branch `teedole/live-knowledge-skills`.

**The feature in one line.** `dosu skill link <document-id> --name migration-review --agent claude` installs a small Claude Code skill that, every time it runs, fetches the current *published* revision of one Dosu document through the CLI and follows it. Editing the document in Dosu changes what every agent using the skill does. `--revision N` pins a binding to one published revision instead.

The memorable demo moment: "I updated our team's procedure, and every agent using this skill now follows it." Both runs print the document and revision they used, so the link between stored knowledge and agent behavior is visible.

---

## 1. Feasibility against the one-hour constraint

| Target | Verdict |
|---|---|
| Working prototype (link + resolve, live and pinned, one client) in ~1 hour | Feasible. All required API procedures exist in the vendored contract; no backend change is needed. |
| Mergeable PR (95% statement / 90% branch coverage, Biome, knip, typecheck) | Not in one hour. Estimate 3–5 focused hours including tests and docs. |
| Same-day stable release on `latest` | Plausible if the PR is green and the Claude Code rehearsal passes. The demo does not depend on the release; it runs from a local build. |

Two facts drive the design and were verified live against production with the authenticated 0.52.2 binary (read-only calls):

1. `dosu docs get <missing-id> --json` prints `null` and **exits 0**. The same happens for `--revision 999`. A binding built directly on `docs get` cannot "stop with a useful error", so a narrow resolver command is required (decision 4).
2. `dosu docs versions <id> --json` returns every revision with its own `published` flag and `pending_status`. Older published revisions keep `published: true` after newer ones are published (checked on document `879cbca9…`, revisions 1–4). `dosu docs get <id> --revision N --json` returns that exact revision with `version`, `published`, `page_version_id`, and `knowledge_store_id`. So the CLI can deterministically select "highest published revision" without any backend change (decision 3).

Not verified live: a document whose *latest* revision is an unpublished draft (the current Library has none). Draft handling below is derived from the contract types (`published: boolean` on both `page.get` and `page.listVersions` output) and must be confirmed in the first ten minutes of the build by creating one draft revision in a scratch document.

## 2. Demo slice and minimum releasable scope

### Demo slice (what is rehearsed and shown)

1. `dosu skill link <doc> --name migration-review --agent claude` against a published, procedure-shaped document. Output shows the path written, the document title, the revision resolved at link time, and `tracking: live`.
2. Fresh Claude Code session in a prepared repo: `/migration-review` against a prepared code change (a migration file). The agent runs `dosu skill resolve …`, prints `Using Dosu procedure "…" (document …, revision 4, live)`, then reviews.
3. Add one legitimate check to the document in the Dosu web app and publish it. `dosu docs versions <doc> --json` shows revision 5 published.
4. New Claude Code session, identical code change, same `/migration-review`. The source line now says revision 5 and the review applies the new check. Nothing was reinstalled.
5. Second act: `dosu skill link <doc> --name migration-review-pinned --revision 4 --agent claude`. Invoking it after the update still prints revision 4.

Candidate document already in the Library: **"DB Enum Widening Checklist"** (`879cbca9-2fbf-45be-9a3e-1b74303238be`, topic page, 4 published revisions, `knowledge_store_id 66e1c189…`). It is a real migration-review procedure. Recommendation: duplicate it into a dedicated demo document so the team's checklist is not edited for a demo; keep the original as fallback.

### Minimum releasable scope (v1)

- Client: Claude Code only (`--agent claude`). Other agent ids fail with a clear "not supported yet" error.
- Commands: `skill link`, `skill resolve`, `skill links`, `skill unlink`.
- Tracking modes: live (default) and pinned (`--revision`).
- Scope: user scope by default (`$CLAUDE_CONFIG_DIR/skills/<name>` or `~/.claude/skills/<name>`), `--project` writes `<cwd>/.claude/skills/<name>`.
- No changes to `skill install|update|remove`, setup, or the `dosu-ai/dosu-skill` repo.
- No new config keys, no registry file: the generated `SKILL.md` is the binding.

Out of scope for v1 (follow-ups): other clients, dynamic `` !`command` `` injection, per-binding size override, distinct exit codes per failure class, setup-wizard integration, TUI entry.

## 3. Verified existing code and contracts to reuse

| Need | Reuse | Where |
|---|---|---|
| Exact document read with revision | `client.page.get.query({ page_id, version })` → `PageGetOutput \| null` (has `published`, `version`, `page_version_id`, `knowledge_store_id`, `body`, `title`, `archived`, `pending_status`) | `src/generated/dosu-api-types.d.ts:1226-1269` |
| Revision inventory with published flags | `client.page.listVersions.query({ page_id })` → array of `{ version, published, pending_status, created_at, origin, … }` | `src/generated/dosu-api-types.d.ts:1271-1306` |
| Expected knowledge store for the active Library | `client.knowledgeStore.getBySpaceId.query({ space_id })` (already used by `docs list`) | `src/commands/docs.ts:28-37`, contract line 1943 |
| Typed client + refresh/retry | `createTypedClient(cfg)` | `src/client/trpc.ts` |
| Login / Library context guards | `requireLoginConfig()`, and the `requireConfig()` pattern that demands `active_account.target.space_id` | `src/commands/auth.ts`, `src/commands/docs.ts:20-26` |
| Claude Code skills root | `CLAUDE_CONFIG_DIR` fallback to `~/.claude`, `skills/<name>` | `src/commands/skill.ts:66-73` (`skillInstallTargetForProvider`) |
| Safe name regex | `SAFE_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` | `src/commands/skill.ts:22` |
| Ownership marker convention | `<!-- dosu:rules:start v1 -->` / `<!-- dosu:mcp:start v2 -->` with "refuse to overwrite when markers are incomplete" | `src/rules/installer.ts:36-41,138-150`, `src/setup/agents-md-step.ts:25-30,79-89` |
| Git work tree gate for project scope | `inGitWorkTree()` | `src/setup/agents-md-step.ts:47-58` |
| Machine-readable error lines | `emitError({ step, reason, agent_next_steps })`, `emitStep()` | `src/agent/output.ts` |
| Human output helpers | `printInfo`, `printTable`, `printResult`, `formatDate` | `src/commands/output.ts` |
| UUID / positive-integer option parsing | `uuid`, `positiveInteger` | `src/commands/arguments.ts` |
| Confirmation for destructive paths | `confirmAction({ confirmed, json, message, preview })` | `src/commands/confirmation.ts` |
| Command test harness (mock tRPC proxy, config fixtures) | `createMockProxy`, `makeTestConfig` | `src/commands/docs.test.ts:20-45`, `src/config/config.test-utils.ts` |
| Telemetry naming | `commandTelemetryName` derives `skill link` etc. automatically; no allowlist edits | `src/cli/cli.ts:84-97` |

Contract discipline: every call above is on `TypedClient`; nothing new must be registered in `cliRouter`. `src/client/contract-discipline.test.ts` stays green as long as no hand-written `{ query() }` shapes are introduced.

Existing behavior that stays untouched: `skill install|update|remove` run `npx skills …` against `dosu-ai/dosu-skill` and enumerate via the skills lockfile, so linked skill directories are neither installed, updated, nor removed by them. `dosu upgrade`'s post-upgrade skill refresh (`src/commands/upgrade.ts:270-290`) is likewise unaffected.

## 4. Proposed CLI commands and binding behavior

### Commands

```
dosu skill link <document-id> --name <skill-name> --agent claude
                [--revision <n>] [--description <text>] [--project] [--force] [--json]

dosu skill resolve --document <document-id> --library <library-id>
                [--revision <n>] [--json]

dosu skill links [--agent claude] [--project] [--json]

dosu skill unlink <skill-name> --agent claude [--project] [--json]
```

`<document-id>` and `--library` are validated with the existing `uuid` parser. `--agent` uses Commander `choices(["claude"])` in v1. `--name` is validated by `SAFE_SKILL_NAME`, lowercased-hyphen recommended, max 64 chars, and must not be `dosu` (the official skill's name) or `.`/`..`.

### `skill link`

1. Guards: logged in; `active_account.target.space_id` present (same message as `docs`: "Run 'dosu setup' to reconfigure").
2. Resolve once, exactly as `skill resolve` would (live or pinned). Failure stops the command with the resolver's `reason`; nothing is written. This is how a missing, inaccessible, unpublished, or oversized source is rejected at link time.
3. Compute the target directory: `<root>/<name>` where root is `$CLAUDE_CONFIG_DIR/skills` (fallback `~/.claude/skills`) or `<cwd>/.claude/skills` with `--project`. `--project` requires `inGitWorkTree()`. After `path.resolve`, assert the target starts with `root + sep`; otherwise fail with `reason: invalid_name`.
4. Existing-target rules:
   - No `SKILL.md` → create.
   - `SKILL.md` without our marker → **refuse** (`reason: name_taken`). `--force` does not override foreign skills.
   - Marker present, same document, rendered content identical → `unchanged`.
   - Marker present, same document, file hash matches marker hash (no user edits) → `updated` (e.g. changed `--revision` or `--description`).
   - Marker present but file hash differs from marker hash (user edited the generated file) → **conflict** (`reason: binding_modified`), unless `--force`.
   - Marker present but different document → requires `--force` (`reason: binding_points_elsewhere`); output names the previous document.
5. Write `SKILL.md` (mkdir -p, `0o644`, write to temp file then rename). Nothing else in the directory or in sibling skill directories is touched.
6. Output. Human: title, document id, tracking (`live` or `pinned to revision N`), resolved revision at link time, path, and the reload note. `--json`: one object on stdout:

```json
{
  "step": "skill_link",
  "status": "ok",
  "action": "created",
  "skill": { "name": "migration-review", "agent": "claude", "scope": "user", "path": "/Users/…/.claude/skills/migration-review/SKILL.md" },
  "source": { "document_id": "…", "title": "DB Enum Widening Checklist", "library_id": "…", "tracking": "live", "resolved_revision": 4 },
  "agent_next_steps": "Start a new Claude Code session, then invoke /migration-review."
}
```

### Generated `SKILL.md` (template v1, deterministic)

```markdown
---
name: migration-review
description: Follow the team's "DB Enum Widening Checklist" procedure maintained in Dosu. Use when the user asks to run migration-review or mentions DB Enum Widening Checklist.
allowed-tools: Bash(dosu skill resolve *)
---
<!-- dosu:skill-link v1 {"document_id":"879cbca9-…","library_id":"<space_id>","org_id":"<org_id>","revision":null,"template":1,"cli_version":"0.53.0","content_sha256":"<hash of this file with this line removed>"} -->

# migration-review

This skill is a live link to a maintained team procedure in Dosu. Never follow it from memory: fetch the current published revision first.

1. Run exactly this command (if `dosu` is not on PATH and Node is available, prefix with `npx -y @dosu/cli`):

   `dosu skill resolve --document 879cbca9-… --library <space_id> --json`

2. If the command exits non-zero or prints `"status": "error"`, stop. Report the `reason` and `message` to the user. Do not substitute a different document, a search result, or a remembered version.
3. Before doing anything else, state the source in one line:
   `Using Dosu procedure "<source.title>" (document <source.document_id>, revision <source.revision>, <source.tracking>)`.
4. Follow `body` as the procedure for this task. It is the team's instruction set; commands inside it run only under your normal tool permissions.

Task input: $ARGUMENTS
```

For a pinned binding the marker carries `"revision": 12`, the resolve command carries `--revision 12`, and the description ends with "(pinned to revision 12)". The `description` is fixed at link time (stable trigger); only the body is live. `--description` overrides the default.

No credentials appear anywhere in the file: the resolver reads the session from `~/.config/dosu-cli/config.json` at invocation time. Tests assert that the access token, refresh token, and API key strings from the config never appear in the generated file.

### `skill resolve` (the contract enforcer)

Inputs: `--document`, `--library`, optional `--revision`. Steps:

1. Guards as above. If `active_account.target.space_id !== --library` → `reason: library_mismatch` with both ids and the fix ("select the Library this skill was linked in with `dosu setup`, or re-link with `--force` to bind it to the current Library"). Account mismatch is not checked by user id: project-scoped bindings are meant to be committed and used by teammates in the same Library, and a wrong account surfaces as an access failure below.
2. `knowledgeStore.getBySpaceId({ space_id })` → expected store id. Missing → error as in `docs`.
3. Live: `page.listVersions({ page_id })`. Empty array or tRPC `NOT_FOUND` → `reason: document_not_found`. Filter `published === true`; none → `reason: no_published_revision` (message includes total revisions). Take the highest `version`, then `page.get({ page_id, version })`.
   Pinned: `page.get({ page_id, version: N })` directly.
4. Validate the page: `null` → `document_not_found` (live) or `revision_unavailable` (pinned); `published !== true` → `revision_not_published`; `archived === true` → `document_archived`; `knowledge_store_id !== expected` → `library_mismatch`; `body` null/empty → `empty_body`; `version !== requested` → `resolver_inconsistency`.
5. Size: `body.length > MAX_PROCEDURE_CHARS` (32 000, roughly 8k tokens) → `reason: procedure_too_large` with actual and limit. No truncation, ever.
6. Errors: `TRPCClientError` with `data.code` `FORBIDDEN`/`UNAUTHORIZED` → `access_denied`; `fetch` `TypeError`/abort → `network_error` ("The procedure could not be loaded; check your connection and retry"). Exit code 1 for every failure. `--json` errors are a single JSON object on **stdout** with `status: "error"`, `reason`, `message`, `agent_next_steps` (the agent reads stdout); human mode prints red text to stderr.

Success output (`--json`):

```json
{
  "step": "skill_resolve",
  "status": "ok",
  "source": {
    "document_id": "879cbca9-…", "title": "DB Enum Widening Checklist",
    "revision": 4, "page_version_id": "c0a89ede-…", "published": true,
    "tracking": "live", "library_id": "…", "knowledge_store_id": "66e1c189-…",
    "updated_at": "2026-09-10T01:08:02.487426+00:00", "fetched_at": "2026-09-11T…"
  },
  "body": "…markdown…"
}
```

Human mode prints a header (`Source: "<title>" · document <id> · revision N · live`) followed by the body. The resolver never executes anything from the body. Each invocation resolves independently; a publish during a run does not affect the revision already returned.

### `skill links` and `skill unlink`

- `links` scans `<root>/*/SKILL.md` in the selected roots (user root always; project root when `--project` or when `<cwd>/.claude/skills` exists) and lists files carrying a parseable `dosu:skill-link` marker: name, document (short id), tracking, library (short id), path. Files without the marker are ignored, never parsed further.
- `unlink <name>` removes `SKILL.md` only when the marker is present (`reason: not_a_dosu_link` otherwise) and then removes the directory only if it is empty; leftover files are reported, not deleted.

### Edge-case matrix → behavior

| Situation | Behavior | `reason` |
|---|---|---|
| Wrong Library active | Stop; print linked vs active Library ids and the fix | `library_mismatch` |
| Wrong account | Access failure from the API; no broadening | `access_denied` / `document_not_found` |
| Document missing or inaccessible | Stop; never search by title | `document_not_found` |
| Unversioned read finds only drafts | Stop; do not use the draft | `no_published_revision` |
| Pinned revision unavailable | Stop; no fallback to current | `revision_unavailable` |
| Network fails | "Procedure could not be loaded" | `network_error` |
| Procedure changes mid-run | The revision already returned stands; next invocation resolves fresh | n/a |
| Existing skill with the name (foreign) | Preserve; `--force` does not apply | `name_taken` |
| Owned binding with user edits | Surface conflict; `--force` overwrites | `binding_modified` |
| Client needs reload | Print the reload requirement observed in rehearsal (see §6) | n/a |
| Procedure exceeds budget | Explain size and limit; never omit sections | `procedure_too_large` |
| Body references an unavailable dependency | Out of the resolver's control: the skill text tells the agent to report the missing requirement rather than claim completion | n/a |

## 5. File-level implementation steps

Order matters only where noted; write the failing test first for each step (repo TDD convention).

1. **Rebase the branch** onto `origin/main` (0.52.2). Local `main` is at 0.51.0; the branch currently has no commits of its own.
2. **`src/skills/binding.ts`** (new, pure, no I/O): `validateSkillName`, `LinkMarker` type + `serializeMarker`/`parseMarker`, `renderSkillMarkdown(binding, source)`, `contentHash(markdown)`, `SKILL_LINK_MARKER_RE`. Test: `src/skills/binding.test.ts`.
3. **`src/skills/resolve.ts`** (new): `resolveLinkedProcedure(client: TypedClient, input): Promise<ResolveResult>` returning `{ ok: true, source, body } | { ok: false, reason, message }`; `MAX_PROCEDURE_CHARS`; error mapping helpers. Depends on 2 only for types. Test: `src/skills/resolve.test.ts` with the mock-proxy client.
4. **`src/skills/store.ts`** (new, fs): `linkedSkillRoot(agent, scope, cwd)`, `targetPathFor(root, name)` with the containment assertion, `readExistingBinding(path)`, `writeSkillFile(path, content)` (temp + rename), `listLinkedSkills(roots)`, `removeLinkedSkill(path)`. Test with real temp dirs and `CLAUDE_CONFIG_DIR` pointed at them.
5. **`src/commands/skill.ts`**: add the four subcommands; wire guards, client, resolver, store, output. Keep `install|update|remove` untouched. Extend `src/commands/skill.test.ts` (the file already mocks `node:child_process`; add the tRPC proxy and config mocks used by `docs.test.ts`).
6. **Docs**: README platform-commands row for `dosu skill link|resolve|links|unlink`; a short `docs/live-skills.md` user guide (what is written where, how to update, how to pin, reload requirement). CLAUDE.md architecture list: add `src/skills/`.
7. **knip**: production mode reports exports used only by tests. Export from the new modules only what `skill.ts` consumes; test internals through the command surface or keep them unexported.
8. **Run the gate**: `bun run check && bun run typecheck && bunx vitest run --coverage && bun run deadcode`, then `bun run build` and smoke `./bin/dosu skill --help`.

Estimated effort for a mergeable PR: 3–5 hours. Prototype (steps 2–5 without full coverage): about 1 hour.

## 6. Tests and the real-client rehearsal

### Deterministic tests (must pass before any behavioral claim)

Resolver (`resolve.test.ts`, mocked client):

- Live binding picks the highest published revision when the latest is a draft: versions `[1 pub, 2 pub, 3 draft]` → fetches version 2; result reports revision 2.
- Live binding reflects a later publish without reinstall: first call sees `[1, 2]`, second call sees `[1, 2, 3]` → second resolve returns 3.
- Pinned binding keeps its revision when a newer one exists: `--revision 2` with versions `[1, 2, 3]` → fetches version 2 only.
- Unavailable pinned revision fails: `page.get` returns `null` → `revision_unavailable`; no second fetch.
- Draft cannot be used: only-draft inventory → `no_published_revision`; pinned draft → `revision_not_published`.
- Missing document never falls back: `page.get`/`listVersions` empty → `document_not_found`; assert `page.listWithTags` and `search.*` are never called.
- Library mismatch on config and on the fetched `knowledge_store_id`.
- `procedure_too_large` at `MAX_PROCEDURE_CHARS + 1`; body returned untruncated at the limit.
- `FORBIDDEN` → `access_denied`; thrown `TypeError` → `network_error`.

Store and binding (`store.test.ts`, `binding.test.ts`, temp dirs):

- Writes exactly one file at `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`; sibling skill directories are byte-identical before and after.
- `--project` writes under `<cwd>/.claude/skills`; refused outside a git work tree.
- Rejects `../x`, `/abs`, `.hidden`, `--all`, `dosu`, empty, 65 chars; asserts no file appears outside the root.
- Foreign `SKILL.md` preserved byte-for-byte; `--force` still refuses.
- Owned identical → `unchanged`; owned changed options → `updated`; owned user-edited → conflict, `--force` overwrites; different document → requires `--force`.
- Generated file contains no config secrets.
- `unlink` removes only owned files; refuses foreign; leaves non-empty directories.
- Marker round-trips through `serializeMarker`/`parseMarker`; a corrupted marker is reported, not overwritten.

Command layer (`skill.test.ts`):

- `--json` success and error objects are the only stdout content; human progress never mixes into JSON mode.
- Non-zero exit on every failure; `reason` present.
- Not logged in / missing Library → existing error text; `--agent cursor` → usage error.

### Real-client rehearsal (Claude Code 2.1.268 is installed locally)

The installed `dosu` is 0.52.2 and lacks `skill resolve`. Build first and put the build on PATH for the demo shell, so the agent's Bash inherits it:

```bash
bun run build && export PATH="$PWD/bin:$PATH" && dosu skill --help
```

1. **Discovery and reload.** Link into user scope. In an already-open Claude Code session, type `/migration-review`; then open a fresh session and try again. Record which one sees the skill and write that into the `link` output text. (Claude Code docs do not state hot-reload behavior; this step settles it.)
2. **Headless smoke** for repeatability: `claude -p "/migration-review review migration.sql" --allowedTools "Bash(dosu skill resolve *)" "Read"`. Confirm the transcript contains the `Using Dosu procedure … revision N` line and a `dosu skill resolve` call.
3. **Live update.** Publish revision N+1 with one added, legitimate check. Confirm with `dosu docs versions <id> --json`. Fresh session, identical input. Evidence: source line shows N+1 and the review mentions the new check.
4. **Pinned.** Link `--revision N` under a second name; invoke; source line shows N.
5. **Failure paths in the client.** Temporarily archive or use a bogus id in a throwaway binding: the agent must stop and report the `reason`. Switch Library with `dosu deployments switch` (or edit the marker) to see `library_mismatch`.
6. **Preservation.** `dosu skill links` lists only the two bindings; `ls ~/.claude/skills` shows the official `dosu` symlink and unrelated skills unchanged; `dosu skill remove` (official) leaves linked skills alone.

Report the two kinds of evidence separately: resolver behavior is deterministic and test-backed; "the agent applied the new check" is a single behavioral observation and model output varies. Retrieval alone is not success; if the source line shows N+1 but the review ignores the new check, report a behavioral failure. Make no token-, time-, or accuracy-savings claims from this demo.

## 7. Open decisions, recommendations, reasons

1. **Client.** Claude Code. Installed locally, documented `~/.claude/skills/<name>/SKILL.md` discovery, `allowed-tools` frontmatter pre-approves the single Bash command, and `claude -p` allows a scripted rehearsal. Codex/Cursor skill discovery goes through the `skills` CLI convention and is less certain.
2. **Scope.** User scope default, `--project` opt-in, absolute path always printed. Matches `skill install` (global) and avoids writing into arbitrary directories.
3. **Deterministic latest published?** Yes, via `listVersions` → filter published → max version → `get(version)`. Verified against production data; draft case to be confirmed with one scratch draft.
4. **`docs get` vs resolver.** Resolver. `docs get` returns `null` with exit 0 for missing ids and revisions and does not enforce published-only, size, or Library checks.
5. **Context check.** Binding records `library_id` (space) and `org_id`; resolver compares the active target's `space_id` and the fetched page's `knowledge_store_id`. No user-id check, so committed project bindings work for teammates; wrong accounts fail on access. No new auth model.
6. **Metadata and ownership.** Inside `SKILL.md` as a versioned HTML-comment marker with a content hash, following the `dosu:rules` / `dosu:mcp` marker convention. No registry file to drift; `links` scans for the marker.
7. **Duplicates, edits, unlink.** Table in §4. Foreign files are never overwritten; owned files are updated in place; user edits require `--force`; `unlink` removes only owned files.
8. **Pinning in v1?** Yes. It shares the resolver and adds one option and four tests; it is the second act of the demo.
9. **Trigger description.** Derived from the title at link time, overridable with `--description`, stored in frontmatter, never refreshed on invocation. Stable trigger, live body.
10. **Size limit.** 32 000 characters, fail closed with actual vs limit. Per-binding override is a follow-up.
11. **Reuse without unmerged dependencies.** Only merged `main` code (§3). Do not depend on the `beta` branch (knowledge sync/miner), PR #183 (Drive), or PR #199.
12. **Releasable evidence.** Green CI gate (§5 step 8) plus rehearsal steps 1–4 and 6 passing, with step 3's behavioral result stated as observed.

Ask the user only if: they want project scope as the default, a different client first, or pinning deferred. Everything else is resolved above.

## 8. Release path and what would change the estimate

Current state (verified 2026-09-11): npm `latest` 0.52.2, `beta` 0.53.0-beta.9, `alpha` 0.49.0-alpha.1, `next` 0.1.5-alpha. `release.config.js` on `main` publishes from `main` (stable) and `alpha` (prerelease); the `beta` branch carries its own config that adds `beta`. CI runs release only on pushes to `main` or `alpha`.

Intended delivery state: **a passing PR merged to `main`**, which semantic-release turns into stable `0.53.0` on `latest` (`feat(skill): …` → minor). The stable 0.53.0 sorts above `0.53.0-beta.9`, so no npm collision; the beta branch's next release becomes 0.54.0-beta.1 after it picks up main. Homebrew updates automatically for stable versions. Per the user's instruction, this branch is pushed but **no PR is opened** by the planning pass.

Fallback if the rehearsal exposes a client issue but the code is safe: merge to `alpha` for `0.53.0-alpha.1` and demo via `npx @dosu/cli@alpha`. Channel management (`upgrade --channel`, update-notice semantics) stays a separate improvement.

Conditions that would push the estimate out:

- A draft-latest document does not behave as the contract implies (e.g. `listVersions` hides drafts): needs a backend change and re-vendored contract → not same-day.
- Claude Code does not pick up a newly written user skill without a restart *and* the demo requires a single session: acceptable, but the `link` output must say so.
- `allowed-tools: Bash(dosu skill resolve *)` does not pre-approve the command in the tested version: the demo still works with a permission prompt; document it.
- Coverage thresholds force test scaffolding beyond the estimate: ship the prototype from a local build for the demo and land the PR the next day.

Distinguish the four states when reporting: built prototype, passing PR, npm prerelease, stable release.
