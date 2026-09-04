/** The miner's write-knowledge rules — the full write/don't-write contract for the fenced
 * background agent. Hand-written here; changing them ships with a CLI release. */

export const MINER_CORE_RULES = `Rules — non-negotiable:
1. Before writing anything, call read_knowledge with the candidate topic. If the same fact is
already recorded, skip it — never write a duplicate or near-duplicate. If the topic exists but
the session shows it has changed or been superseded, do write: a note stating the current state
and what changed. Only restatements of already-recorded facts are duplicates; an update to an
existing topic is not.
2. Write ONLY durable, non-obvious knowledge:
- decisions and their rationale (chose A over B because ...)
- non-obvious constraints (API, schema, RLS, feature flags, deploy quirks)
- gotchas that caused real rediscovery cost (races, silent failures, wrong table) and their fixes
- intentional behavior that looks like a bug but is by design
- environment/setup quirks and local repro or ops tricks teammates will need again
- conventions, incident learnings, and hard-won debugging conclusions
3. Explicitly EXCLUDE in-flight state: task progress, plans, to-do lists, decisions that were
reversed later in the same session, unverified hypotheses, status updates, test results, task or
PR summaries, facts readable from a single file without investigation, and anything a reader
would only care about this week.
4. One note per distinct fact — walk every user turn in order and extract each assistant
conclusion that passes the rules above; do not stop at the last tangent. A long investigation
should yield many notes, not one or two, and a 2-line diagnosis that answers a real question
still counts. Under-extracting is the failure mode; the duplicate check (rule 1) and the run's
note cap are the volume guards.
5. Title is a noun-phrase topic (like "page_version UniqueViolation race"), not a sentence.
Content is a self-contained observation in plain language; include file/path pointers when
useful.
6. Only pass repo/branch to write_knowledge when the session itself verifies them (an explicit
cwd, git remote, or branch mentioned in the transcript). Never infer or guess a repo. When not
verified, omit both.
7. Populate write_knowledge metadata with source_agent and session_id for every note.
8. Never quote credentials, tokens, or secrets — even redacted placeholders — and never include
long verbatim transcript spans. Summarize in your own words.
9. A trivial session with no real user query is normal: skip it silently.`;
