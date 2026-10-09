/** Knowledge-sync state: a ledger of how each session was settled (shipped, or deliberately passed
 * over), keyed by `harness/id`, plus failure backoff and the user's switches. A session is
 * pending until the ledger holds an answer for its current contents, so nothing a run skips is
 * ever lost behind a high-water mark. Kept out of config.json, which is credential-bearing and
 * rewritten by auth flows. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";
import { sessionLineage } from "../sessions/lineage";
import type { AgentSession } from "../sessions/scan";

const STATE_FILENAME = "knowledge-sync.json";
/** 3: a per-session ledger; 2 kept one shipping watermark; 1 was the local learner era. Both
 * migrate on load (see migrate). */
const STATE_SCHEMA_VERSION = 3;

/** Sessions whose `updated` is newer than this are treated as still running. */
export const DEFAULT_QUIET_PERIOD_MS = 5 * 60 * 1000;

const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/** How a session was settled. Only `shipped` uploaded anything. */
export type SessionOutcome =
  | "shipped"
  /** Too small to hold anything worth learning. */
  | "trivial"
  /** The user took it off the record with /dosu-incognito, or put its agent in incognito
   * (`by_agent`). */
  | "incognito"
  /** The backend refused the payload (400/413/422); retried by --retry-rejected. */
  | "rejected"
  /** No normalizer for this harness or transcript. Never a failure: that would back off and
   * stall every other harness. */
  | "unsupported"
  /** Passed over when the user declined setup's backfill offer. */
  | "skipped_by_user";

export const SESSION_OUTCOMES: readonly SessionOutcome[] = [
  "shipped",
  "trivial",
  "incognito",
  "rejected",
  "unsupported",
  "skipped_by_user",
];

/** The ledger's answer for one session. */
export interface LedgerEntry {
  /** The session's `updated` when it was settled; any other value makes it pending again. */
  updated: string;
  outcome: SessionOutcome;
  /** When it was settled (ISO). */
  at: string;
  /** The CLI version that settled it. Passed-over sessions are re-evaluated by a newer CLI,
   * which may support the harness, judge triviality differently, or fix what was rejected (all
   * but `by_agent` ones). */
  cli_version: string;
  /** How many normalized records of the session have shipped so far, from the start, and the
   * sha256 of their canonical JSON (shipper/continuation.ts): a session that grows ships only
   * its tail. Kept when a later attempt is refused or passed over. */
  records?: number;
  prefix_sha256?: string;
  /** shipped: the ingest task the backend accepted (202). */
  task_id?: string;
  /** shipped: the shareable memory-session page, when the backend returned one. */
  session_url?: string;
  /** shipped: the project key the session shipped under (sessions/project.ts). */
  project?: string;
  /** shipped: the scanner's workspace for the session (a harness project slug or directory),
   * which history views need to find the transcript again for its title. */
  workspace?: string;
  /** rejected: the HTTP status the backend answered with. */
  http_status?: number;
  /** rejected/unsupported: one renderable line saying why. */
  message?: string;
  /** A subagent's transcript (a child session): the id of the session it worked for. Settled on
   * its own, but counted with that session in every view, never as a session of its own. */
  parent?: string;
  /** Carried over from the schema-2 shipped history, which never recorded the session's own
   * mtime: `updated` holds the ship time instead, and the session is pending only once it
   * changes after that. */
  seeded?: true;
  /** incognito: settled because its agent was in `incognito_agents` (or sealed as it left, see
   * leaveIncognito), not by a marker in the transcript, which a later run could not find again.
   * So the entry is never pending: turning the switch off, resuming the session, or a newer CLI
   * never ships it, nor a subagent or fork of it (isAgentIncognito). Its `updated` follows the
   * session's, and it is kept for as long as its transcript is on disk, however long the session
   * sits unused (pruneLedger): the session could be resumed or forked any time. It keeps no shipped
   * prefix, since nothing of the session is ever sent after it. */
  by_agent?: true;
  /** by_agent: where the session's transcript is (opencode: its database), which keeps the entry
   * while it is there. */
  path?: string;
}

/** One shipped session, for history views; derived from the ledger. */
export interface ShippedSessionRecord {
  /** When the session was shipped (ISO). */
  at: string;
  /** The session's `harness/id`. */
  session: string;
  /** The ingest task the backend accepted (202) for this session. */
  task_id: string;
  /** Shareable memory-session page, when the backend returned one. */
  session_url?: string;
  /** The project key the session shipped under (sessions/project.ts). */
  project?: string;
  /** The scanner's workspace slug or directory for the session, when it had one. */
  workspace?: string;
}

/** The active run's baseline; status viewers subtract baseline_shipped from total_shipped for a
 * run-scoped progress bar. Only meaningful while the recorded pid holds the sync lock. */
interface SyncRun {
  pid: number;
  started_at: string;
  /** total_shipped when this run started. */
  baseline_shipped: number;
}

export interface SyncState {
  schema_version: number;
  /** The ledger, by `harness/id`. Entries age out once their session leaves the scan window,
   * except those an agent's incognito switch settled (LedgerEntry.by_agent). */
  sessions: Record<string, LedgerEntry>;
  last_attempt_at?: string;
  consecutive_failures: number;
  /** All-time shipped-session count — survives ledger pruning. Subagents' transcripts ship with
   * their session and do not count. */
  total_shipped?: number;
  /** The active run's progress baseline; see SyncRun. */
  run?: SyncRun;
  /** Repo keys (`host/owner/repo`) whose sessions get shipped; absent means every session,
   * including those outside a git repo. */
  repo_filter?: string[];
  /** Legacy folder scope from before repo scoping; the next sync converts it to repo_filter. */
  project_filter?: string[];
  /** User pressed stop: quiet (hook-triggered) syncs skip until resumed. Cleared by the
   * Activity screen's resume, any manual `dosu knowledge sync`, or a `--flush`. */
  paused?: boolean;
  /** `false` = the user opted out of shipping transcripts (`dosu knowledge transcripts
   * disable`). Shipping is on by default, so only the opt-out is ever stored. */
  ship_transcripts?: false;
  /** Transcripts a session-end hook named that the scan does not list (an agent relocated by an
   * environment variable only its own processes see), by `harness/id`. Every run reads them too,
   * so a failed or skipped upload is retried and a resumed session ships its tail; each is
   * forgotten once its file is gone, leaves the scan window, or the scan lists it itself. */
  outside_sessions?: Record<string, string>;
  /** Agent ids (session harnesses: claude, cursor, codex, ...) the user put in incognito (`dosu
   * knowledge incognito on`), sorted; absent when there are none. None of their sessions ship,
   * as if every one had run `/dosu-incognito`: each settles `incognito` with `by_agent`, so
   * turning the switch off later does not ship it. Schema 1 (0.66) kept the same key at the top
   * level, so the list carries over, and it survives a schema this CLI cannot read. */
  incognito_agents?: string[];
  /** When each agent in `incognito_agents` went in (ISO), as this CLI recorded it: `off` seals
   * what ran since then, however long ago (leaveIncognito). An agent listed without one (carried
   * over from 0.66) goes back as far as the scan window. */
  incognito_since?: Record<string, string>;
  /** From a 0.66 state file: its learner's watermark (`before`) and the sessions it studied (by
   * `harness/id`). The watermark also passed, unstudied, every session of an agent in incognito,
   * which 0.66 promised to keep unstudied once the switch was off, and which nothing else tells
   * apart now. The first sync settles each session it passed since the switch existed as the switch
   * would have (`by_agent`), then drops this. */
  legacy_passed?: { before: string; studied: string[] };
  /** Set, never saved, when knowledge-sync.json is there but cannot be read or parsed (a hand edit
   * gone wrong, a permission change): what it said is unknown, so nothing ships, no prompt or Dosu
   * tool call is sent (callRefusal), and nothing saves over it until it is fixed or removed. */
  unreadable?: true;
}

/** Whether finished sessions are shipped to Dosu memory: on unless the user opted out. */
export function isShippingEnabled(state: SyncState): boolean {
  return state.ship_transcripts !== false;
}

export function syncStatePath(configDir: string = getConfigDir()): string {
  return join(configDir, STATE_FILENAME);
}

export function emptySyncState(): SyncState {
  return { schema_version: STATE_SCHEMA_VERSION, sessions: {}, consecutive_failures: 0 };
}

/** The ledger key of a session. */
export function sessionKey(session: Pick<AgentSession, "harness" | "id">): string {
  return `${session.harness}/${session.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringsOf(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string");
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 ? value : undefined;
}

function optionalString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" ? ({ [key]: value } as Record<K, string>) : {};
}

function parseEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const { updated, outcome, at, cli_version } = value;
  if (
    typeof updated !== "string" ||
    typeof at !== "string" ||
    typeof cli_version !== "string" ||
    !SESSION_OUTCOMES.includes(outcome as SessionOutcome)
  ) {
    return null;
  }
  return {
    updated,
    outcome: outcome as SessionOutcome,
    at,
    cli_version,
    ...(nonNegative(value.records) !== undefined ? { records: value.records as number } : {}),
    ...optionalString("prefix_sha256", value.prefix_sha256),
    ...optionalString("task_id", value.task_id),
    ...optionalString("session_url", value.session_url),
    ...optionalString("project", value.project),
    ...optionalString("workspace", value.workspace),
    ...(typeof value.http_status === "number" ? { http_status: value.http_status } : {}),
    ...optionalString("message", value.message),
    ...optionalString("parent", value.parent),
    ...(value.seeded === true ? { seeded: true as const } : {}),
    ...(value.by_agent === true ? { by_agent: true as const } : {}),
    ...optionalString("path", value.path),
  };
}

function parseLedger(value: unknown): Record<string, LedgerEntry> {
  const ledger: Record<string, LedgerEntry> = {};
  if (!isRecord(value)) return ledger;
  for (const [key, raw] of Object.entries(value)) {
    const entry = parseEntry(raw);
    if (entry) ledger[key] = entry;
  }
  return ledger;
}

/** The fields every schema keeps the same way. */
function parseCommon(raw: Record<string, unknown>): Omit<SyncState, "schema_version" | "sessions"> {
  const outside = stringRecord(raw.outside_sessions);
  return {
    ...optionalString("last_attempt_at", raw.last_attempt_at),
    consecutive_failures: nonNegative(raw.consecutive_failures) ?? 0,
    ...(Array.isArray(raw.repo_filter) ? { repo_filter: stringsOf(raw.repo_filter) } : {}),
    ...(Array.isArray(raw.project_filter) ? { project_filter: stringsOf(raw.project_filter) } : {}),
    ...(raw.paused === true ? { paused: true } : {}),
    ...(raw.ship_transcripts === false ? { ship_transcripts: false as const } : {}),
    ...(outside ? { outside_sessions: outside } : {}),
    // Schema 1 (0.66's per-agent switch) kept it at the top level too, so it survives migration.
    ...agentList(raw.incognito_agents, raw.incognito_since),
    ...legacyPassed(raw.legacy_passed),
  };
}

function legacyPassed(value: unknown): Pick<SyncState, "legacy_passed"> {
  if (!isRecord(value) || typeof value.before !== "string" || !Array.isArray(value.studied)) {
    return {};
  }
  return { legacy_passed: { before: value.before, studied: stringsOf(value.studied) } };
}

/** What a 0.66 learner's watermark passed over since the per-agent switch existed (see
 * SyncState.legacy_passed); none for an older or another channel's file, whose CLI had no switch
 * (beta's schema 1 kept shipping under `ship`). */
function legacyWatermark(raw: Record<string, unknown>): Pick<SyncState, "legacy_passed"> {
  const before = raw.watermark;
  if (raw.schema_version !== 1 || isRecord(raw.ship) || typeof before !== "string") return {};
  if (!(Date.parse(before) >= Date.parse(AGENT_SWITCH_SINCE))) return {};
  const studied = (Array.isArray(raw.mined_sessions) ? raw.mined_sessions : []).flatMap((record) =>
    isRecord(record) && typeof record.session === "string" ? [record.session] : [],
  );
  return { legacy_passed: { before, studied } };
}

/** `incognito_agents` as stored: sorted and de-duplicated, and no key at all when empty; with
 * `incognito_since` for the agents it names. */
function agentList(
  value: unknown,
  since: unknown,
): Pick<SyncState, "incognito_agents" | "incognito_since"> {
  const ids = Array.isArray(value) ? [...new Set(stringsOf(value))].sort() : [];
  if (ids.length === 0) return {};
  const times = Object.entries(stringRecord(since) ?? {}).filter(
    ([id, at]) => ids.includes(id) && !Number.isNaN(Date.parse(at)),
  );
  return {
    incognito_agents: ids,
    ...(times.length > 0 ? { incognito_since: Object.fromEntries(times) } : {}),
  };
}

/** Schema 1 kept the local learner's progress at the top level and shipping under `ship`;
 * schema 2 kept shipping progress at the top level behind one watermark. What carries over is
 * which sessions shipped, so they are not uploaded again unchanged. The watermark is dropped:
 * everything it passed over without shipping (trivial, rejected, unsupported, past the old
 * 200-session cap) becomes pending again, and the server dedupes anything it already has; all but
 * what 0.66's learner passed over unstudied since its per-agent switch existed, which an incognito
 * agent's sessions may be among (SyncState.legacy_passed). */
function migrate(raw: Record<string, unknown>, progress: Record<string, unknown>): SyncState {
  const sessions: Record<string, LedgerEntry> = {};
  let shipped = 0;
  for (const record of Array.isArray(progress.shipped_sessions) ? progress.shipped_sessions : []) {
    if (!isRecord(record)) continue;
    const { at, session, task_id } = record;
    if (typeof at !== "string" || typeof session !== "string" || typeof task_id !== "string") {
      continue;
    }
    shipped += 1;
    // Oldest first, so a session shipped twice keeps its latest pass.
    sessions[session] = {
      updated: at,
      outcome: "shipped",
      at,
      cli_version: "migrated",
      task_id,
      ...optionalString("session_url", record.session_url),
      // Schema 2 recorded the scanner's workspace slug under `project`.
      ...optionalString("workspace", record.project),
      seeded: true,
    };
  }
  // Schema 1's top-level counters were the learner's, so the backoff comes from `progress`.
  const {
    last_attempt_at: _attempt,
    consecutive_failures: _failures,
    ...settings
  } = parseCommon(raw);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    sessions,
    ...settings,
    ...legacyWatermark(raw),
    ...optionalString("last_attempt_at", progress.last_attempt_at),
    consecutive_failures: nonNegative(progress.consecutive_failures) ?? 0,
    total_shipped: nonNegative(progress.total_shipped) ?? shipped,
  };
}

function parseRun(value: unknown): SyncRun | undefined {
  if (
    isRecord(value) &&
    typeof value.pid === "number" &&
    typeof value.started_at === "string" &&
    nonNegative(value.baseline_shipped) !== undefined
  ) {
    return {
      pid: value.pid,
      started_at: value.started_at,
      baseline_shipped: value.baseline_shipped as number,
    };
  }
  return undefined;
}

/** What a state file that cannot be read stands for (SyncState.unreadable). */
function unreadableSyncState(): SyncState {
  return { ...emptySyncState(), ship_transcripts: false, unreadable: true };
}

/** Why a state file that cannot be read stops what would write or send, for the user to read. */
export function unreadableStateMessage(configDir: string = getConfigDir()): string {
  return `${syncStatePath(configDir)} could not be read: fix or remove it`;
}

/** The entries an agent's incognito switch settled, cut down to their answer: what nothing later
 * could tell apart again, and so what every fresh start keeps. */
function switchSettled(ledger: Readonly<Record<string, LedgerEntry>>): Record<string, LedgerEntry> {
  const kept: Record<string, LedgerEntry> = {};
  for (const [key, entry] of Object.entries(ledger)) {
    if (!entry.by_agent) continue;
    const { updated, outcome, at, cli_version, parent, path } = entry;
    kept[key] = {
      updated,
      outcome,
      at,
      cli_version,
      by_agent: true,
      ...(parent ? { parent } : {}),
      ...(path ? { path } : {}),
    };
  }
  return kept;
}

export function loadSyncState(configDir: string = getConfigDir()): SyncState {
  const path = syncStatePath(configDir);
  if (!existsSync(path)) return emptySyncState();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return unreadableSyncState();
  }
  if (!isRecord(raw) || Array.isArray(raw)) return unreadableSyncState();
  if (raw.schema_version === 1) return migrate(raw, isRecord(raw.ship) ? raw.ship : {});
  if (raw.schema_version === 2) return migrate(raw, raw);
  if (raw.schema_version !== STATE_SCHEMA_VERSION) {
    // A schema this CLI cannot read (a newer one, after a downgrade) starts the ledger over, but
    // never widens what ships: every setting carries over (the scope, the pause, the shipping
    // opt-out, the incognito agents), and so do the sessions their switch settled.
    const {
      last_attempt_at: _attempt,
      consecutive_failures: _failures,
      ...settings
    } = parseCommon(raw);
    return {
      ...emptySyncState(),
      ...settings,
      sessions: switchSettled(parseLedger(raw.sessions)),
    };
  }
  const run = parseRun(raw.run);
  const totalShipped = nonNegative(raw.total_shipped);
  return {
    schema_version: STATE_SCHEMA_VERSION,
    sessions: parseLedger(raw.sessions),
    ...parseCommon(raw),
    ...(totalShipped !== undefined ? { total_shipped: totalShipped } : {}),
    ...(run ? { run } : {}),
  };
}

/** Throws for a state that stands for a file that could not be read (SyncState.unreadable): saving
 * it would put an empty ledger and no switches in place of whatever the file said. */
export function saveSyncState(state: SyncState, configDir: string = getConfigDir()): void {
  if (state.unreadable) throw new Error(unreadableStateMessage(configDir));
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = syncStatePath(configDir);
  // Write-then-rename, same discipline as config.json: hook-triggered syncs
  // can run concurrently and must never observe a torn state file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Persist the pause switch: load-modify-save so concurrent counters are not clobbered. */
export function setSyncPaused(paused: boolean, configDir: string = getConfigDir()): void {
  const state = loadSyncState(configDir);
  if (paused) state.paused = true;
  else delete state.paused;
  saveSyncState(state, configDir);
}

/** Persist the shipping switch: load-modify-save so counters are not clobbered. */
export function setShipTranscripts(enabled: boolean, configDir: string = getConfigDir()): void {
  const state = loadSyncState(configDir);
  if (enabled) delete state.ship_transcripts;
  else state.ship_transcripts = false;
  saveSyncState(state, configDir);
}

/** Add agents to `incognito_agents` (as of `now`, for one not in it yet) or take them out,
 * keeping the list sorted and dropping each key once it is empty. */
function switchAgents(
  state: SyncState,
  agentIds: readonly string[],
  incognito: boolean,
  now: Date = new Date(),
): void {
  const current = new Set(state.incognito_agents ?? []);
  const since = { ...state.incognito_since };
  for (const id of agentIds) {
    if (incognito && !current.has(id)) since[id] = now.toISOString();
    if (incognito) current.add(id);
    else {
      current.delete(id);
      delete since[id];
    }
  }
  if (current.size > 0) state.incognito_agents = [...current].sort();
  else delete state.incognito_agents;
  if (Object.keys(since).length > 0) state.incognito_since = since;
  else delete state.incognito_since;
}

/** Put agents in or out of incognito: load-modify-save like setSyncPaused. `dosu knowledge
 * incognito off` goes through leaveIncognito instead, which seals what ran while they were in. */
export function setAgentsIncognito(
  agentIds: readonly string[],
  incognito: boolean,
  configDir: string = getConfigDir(),
): void {
  const state = loadSyncState(configDir);
  switchAgents(state, agentIds, incognito);
  saveSyncState(state, configDir);
}

/** The day 0.66.0 brought the per-agent switch: no agent was in incognito before it, so this is
 * when one listed without `incognito_since` (a 0.66 list) went in, at the earliest. */
export const AGENT_SWITCH_SINCE = "2026-10-05T00:00:00.000Z";

/** Take agents out of incognito (`dosu knowledge incognito off`), sealing first what they ran
 * while in it, in the same load-modify-save (after the listing): each session of theirs that
 * `listSessions` returns (from `since`, when the earliest of them went in, however long ago;
 * whatever the scope, still open or not), that was active since its agent went in, and that the
 * ledger has no answer for its current contents (isUnanswered) settles as the switch would have
 * settled it (`by_agent`). Those are the sessions no sync got to while the agent was listed:
 * inside the quiet period, outside the repo scope, or held back by a pause, backoff, the shipping
 * opt-out or a signed-out CLI, or for so long that they left the scan window. Only agents in the
 * list are sealed. When listing throws, nothing is saved and the agents stay in it. */
export function leaveIncognito(
  agentIds: readonly string[],
  listSessions: (state: SyncState, since: Date) => readonly AgentSession[],
  cliVersion: string,
  now: Date = new Date(),
  configDir: string = getConfigDir(),
): void {
  const leavingIn = (state: SyncState) =>
    new Map(
      agentIds
        .filter((id) => state.incognito_agents?.includes(id))
        .map((id) => [id, Date.parse(state.incognito_since?.[id] ?? AGENT_SWITCH_SINCE)]),
    );
  // Listed first, from a read for that alone: the scan takes a while, and whatever another
  // command or a sync saves meanwhile must survive the save below, a quick load-modify-save.
  const listed = loadSyncState(configDir);
  const before = leavingIn(listed);
  const sessions =
    before.size > 0 ? listSessions(listed, new Date(Math.min(...before.values()))) : [];
  const state = loadSyncState(configDir);
  const sinceOf = leavingIn(state);
  const at = now.toISOString();
  for (const session of sessions) {
    const since = sinceOf.get(session.harness);
    if (since === undefined || Date.parse(session.updated) < since) continue;
    const key = sessionKey(session);
    if (!isUnanswered(session, state.sessions[key])) continue;
    state.sessions[key] = agentIncognitoEntry(session, at, cliVersion);
  }
  switchAgents(state, agentIds, false);
  saveSyncState(state, configDir);
}

/** How far up a chain of subagents and forks the switch's answers are looked for. */
const MAX_LINEAGE_DEPTH = 32;

/** A session's links up its lineage: the session it is a subagent of, and the one it was forked
 * or branched from. */
type Lineage = Pick<AgentSession, "parentId" | "forkOf">;

/** Whether the agent's saved incognito switch keeps a session off the record: its agent is in
 * `incognito_agents` now, or the switch settled it, the session it is a subagent of, or the one it
 * was forked or branched from, at any depth (see LedgerEntry.by_agent). A subagent or fork started
 * once the switch is off still carries on from what its session did while it was on, and a branch
 * holds a copy of it. Subagents' transcripts share their session's harness, so the list covers them
 * too. `lineageOf` looks up a session's links by key (sessions/lineage.ts reads them off the
 * transcripts), and the ledger's `parent` stands in for a session it cannot find; with no answer
 * from either, the session's own links are all there is. Looks nothing up while the switch has
 * settled no session of the agent's. */
export function isAgentIncognito(
  state: Pick<SyncState, "incognito_agents" | "sessions">,
  session: Pick<AgentSession, "harness" | "id"> & Lineage,
  lineageOf: (key: string) => Lineage | undefined = () => undefined,
): boolean {
  if (state.incognito_agents?.includes(session.harness)) return true;
  if (!switchSettledAny(state, session.harness)) return false;
  const seen = new Set<string>();
  const queue = [session.id];
  while (queue.length > 0 && seen.size < MAX_LINEAGE_DEPTH) {
    const id = queue.shift() as string;
    const key = `${session.harness}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = state.sessions[key];
    if (entry?.by_agent) return true;
    const links = lineageOf(key) ?? (id === session.id ? session : undefined);
    for (const next of [links?.parentId, links?.forkOf?.id, entry?.parent]) {
      if (next) queue.push(next);
    }
  }
  return false;
}

/** Whether the switch has settled any session of the agent's: until it has, no lineage leads to
 * one, and nothing need be looked up. */
function switchSettledAny(state: Pick<SyncState, "sessions">, harness: string): boolean {
  const prefix = `${harness}/`;
  return Object.entries(state.sessions).some(
    ([key, entry]) => entry.by_agent === true && key.startsWith(prefix),
  );
}

/** isAgentIncognito for the one session a prompt hook, a tool call or the status line names, which
 * have no scan: its links are read off its transcript, from the session `stored` finds (the scan's
 * view of it, or null when its transcript cannot be found), which is looked up only once the switch
 * has settled some session of the agent's. */
export function isSessionAgentIncognito(
  state: Pick<SyncState, "incognito_agents" | "sessions">,
  session: Pick<AgentSession, "harness" | "id">,
  stored: () => AgentSession | null = () => null,
): boolean {
  if (state.incognito_agents?.includes(session.harness)) return true;
  if (!switchSettledAny(state, session.harness)) return false;
  const found = stored();
  return found
    ? isAgentIncognito(state, { ...found, id: session.id }, sessionLineage([found]))
    : isAgentIncognito(state, session);
}

/** The ledger entry for a session its agent's incognito switch keeps off the record: final, and
 * with nothing about what shipped of it before. */
export function agentIncognitoEntry(
  session: Pick<AgentSession, "updated" | "parentId" | "path">,
  at: string,
  cliVersion: string,
): LedgerEntry {
  return {
    updated: session.updated,
    outcome: "incognito",
    at,
    cli_version: cliVersion,
    by_agent: true,
    ...(session.parentId ? { parent: session.parentId } : {}),
    path: session.path,
  };
}

/** The scanned sessions a 0.66 learner's watermark passed over unstudied since the per-agent
 * switch existed, which the ledger has no answer for (SyncState.legacy_passed). */
export function legacyPassedSessions(
  sessions: readonly AgentSession[],
  state: Pick<SyncState, "sessions" | "legacy_passed">,
): AgentSession[] {
  const legacy = state.legacy_passed;
  if (!legacy) return [];
  const from = Date.parse(AGENT_SWITCH_SINCE);
  const before = Date.parse(legacy.before);
  const studied = new Set(legacy.studied);
  return sessions.filter((session) => {
    const key = sessionKey(session);
    const updated = Date.parse(session.updated);
    return (
      state.sessions[key] === undefined && updated >= from && updated <= before && !studied.has(key)
    );
  });
}

/** Forget everything settled so the next run starts from scratch: the ledger, the lifetime
 * counter, and failure backoff (the backend dedupes re-shipped traces on content hash). User
 * settings survive — the study scope, the pause switch, the shipping opt-out, and the incognito
 * agents are choices, not progress — and so do the transcripts outside the scan and the sessions
 * an agent's incognito switch settled, which no later run could tell apart again. Memory already
 * built in Dosu is untouched. */
export function resetSyncState(configDir: string = getConfigDir()): void {
  const previous = loadSyncState(configDir);
  if (previous.unreadable) throw new Error(unreadableStateMessage(configDir));
  saveSyncState(
    {
      ...emptySyncState(),
      sessions: switchSettled(previous.sessions),
      ...(previous.repo_filter ? { repo_filter: previous.repo_filter } : {}),
      ...(previous.project_filter ? { project_filter: previous.project_filter } : {}),
      ...(previous.paused ? { paused: true } : {}),
      ...(previous.ship_transcripts === false ? { ship_transcripts: false as const } : {}),
      ...(previous.incognito_agents ? { incognito_agents: previous.incognito_agents } : {}),
      ...(previous.incognito_since ? { incognito_since: previous.incognito_since } : {}),
      ...(previous.legacy_passed ? { legacy_passed: previous.legacy_passed } : {}),
      // Where those sessions live, so a fresh drain can still find them.
      ...(previous.outside_sessions ? { outside_sessions: previous.outside_sessions } : {}),
    },
    configDir,
  );
}

/** Settle the backlog the user declined at setup's backfill offer as `skipped_by_user`, so only
 * sessions that finish (or change) from here on ship. Explicit per session, and never
 * re-evaluated by a newer CLI: it was the user's call, not a rule's. Only sessions the ledger
 * has never settled count as backlog; any other entry is kept, so a shipped session that grew
 * since still ships just its tail. A session of an agent in incognito settles as its switch
 * would have it (`by_agent`), so it stays out once the switch is off too. */
export function skipBacklog(
  sessions: readonly AgentSession[],
  cliVersion: string,
  now: Date = new Date(),
  configDir: string = getConfigDir(),
): void {
  const state = loadSyncState(configDir);
  const at = now.toISOString();
  const lineage = sessionLineage(sessions);
  for (const session of unsettledSessions(sessions, state)) {
    state.sessions[sessionKey(session)] = isAgentIncognito(state, session, lineage)
      ? agentIncognitoEntry(session, at, cliVersion)
      : {
          updated: session.updated,
          outcome: "skipped_by_user",
          at,
          cli_version: cliVersion,
          ...(session.parentId ? { parent: session.parentId } : {}),
        };
  }
  saveSyncState(state, configDir);
}

/** The sessions the ledger has no answer for at all: a first-time backlog, as opposed to sessions
 * pending again because they changed or a newer CLI reconsiders them. */
export function unsettledSessions(
  sessions: readonly AgentSession[],
  state: Pick<SyncState, "sessions">,
): AgentSession[] {
  return sessions.filter((session) => state.sessions[sessionKey(session)] === undefined);
}

/** Earliest time a background run should retry after failure: 15min * 2^(failures-1), capped
 * at 24h; null when no backoff is in force. Manual runs ignore this. */
export function backoffUntil(state: SyncState): Date | null {
  if (state.consecutive_failures === 0 || !state.last_attempt_at) return null;
  const last = Date.parse(state.last_attempt_at);
  if (Number.isNaN(last)) return null;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (state.consecutive_failures - 1), BACKOFF_MAX_MS);
  return new Date(last + delay);
}

export interface PendingOptions {
  /** The running CLI's version: passed-over sessions settled by another version are pending. */
  cliVersion: string;
  /** `--retry-rejected`: sessions the backend refused before this time are pending again. A
   * bound rather than a flag, so a drain never retries what it was just refused. */
  retryRejectedBefore?: Date;
}

/** Whether a session still needs the ship step: no ledger answer yet, an answer for different
 * contents, or a passed-over answer this CLI should reconsider. A session an agent's incognito
 * switch settled never is (see LedgerEntry.by_agent). */
export function isPending(
  session: AgentSession,
  entry: LedgerEntry | undefined,
  options: PendingOptions,
): boolean {
  if (!entry) return true;
  if (entry.by_agent) return false;
  if (entry.seeded) return Date.parse(session.updated) > Date.parse(entry.updated);
  if (Date.parse(session.updated) !== Date.parse(entry.updated)) return true;
  if (entry.outcome === "shipped" || entry.outcome === "skipped_by_user") return false;
  if (
    entry.outcome === "rejected" &&
    options.retryRejectedBefore &&
    Date.parse(entry.at) < options.retryRejectedBefore.getTime()
  ) {
    return true;
  }
  return entry.cli_version !== options.cliVersion;
}

/** Whether the ledger holds no answer for a session's current contents, whichever CLI gave the
 * answer it holds: what the agents' incognito switch seals. A passed-over answer a newer CLI would
 * reconsider was given for these very contents, before the switch was on, so sealing it would keep
 * the session out for good for nothing that ran while its agent was listed. */
export function isUnanswered(session: AgentSession, entry: LedgerEntry | undefined): boolean {
  if (!entry) return true;
  if (entry.by_agent) return false;
  if (entry.seeded) return Date.parse(session.updated) > Date.parse(entry.updated);
  return Date.parse(session.updated) !== Date.parse(entry.updated);
}

/** Drop ledger entries for sessions last updated before `cutoff` (past the scan window, so no
 * run would look at them again), except those of the sessions the scan still lists (`live`, by
 * key): an entry whose session changed since keeps its answer, or what of it already shipped. An
 * entry the agents' incognito switch settled stays while its transcript is on disk (`onDisk`), or
 * for good when it does not say where that is: nothing in the transcript records the switch, so
 * without it a resume (or a fork) months later would ship the session whole. */
export function pruneLedger(
  state: SyncState,
  cutoff: Date,
  live: ReadonlySet<string> = new Set(),
  onDisk: (path: string) => boolean = existsSync,
): void {
  const limit = cutoff.getTime();
  for (const [key, entry] of Object.entries(state.sessions)) {
    if (Date.parse(entry.updated) >= limit || live.has(key)) continue;
    if (entry.by_agent && (entry.path === undefined || onDisk(entry.path))) continue;
    delete state.sessions[key];
  }
}

/** The sessions themselves, without the subagents' transcripts that ship with them: what every
 * view counts and lists as sessions. */
export function withoutSubagents<T extends Pick<AgentSession, "parentId">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => !session.parentId);
}

/** How many ledger entries settled each way: sessions, or (`of: "subagents"`) the subagents'
 * transcripts, which views count apart so a session is never counted once per subagent. */
export function outcomeCounts(
  state: SyncState,
  of: "sessions" | "subagents" = "sessions",
): Record<SessionOutcome, number> {
  const counts = Object.fromEntries(SESSION_OUTCOMES.map((o) => [o, 0])) as Record<
    SessionOutcome,
    number
  >;
  for (const entry of Object.values(state.sessions)) {
    if ((entry.parent !== undefined) === (of === "subagents")) counts[entry.outcome] += 1;
  }
  return counts;
}

/** Ledger entries with the given outcome, oldest settled first, keyed by `harness/id`. */
export function settledSessions(
  state: SyncState,
  outcome: SessionOutcome,
): Array<LedgerEntry & { session: string }> {
  return Object.entries(state.sessions)
    .filter(([, entry]) => entry.outcome === outcome)
    .map(([session, entry]) => ({ session, ...entry }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Shipped sessions still in the ledger, oldest shipped first; the subagents' transcripts that
 * shipped with them are not sessions of their own. */
export function shippedSessions(state: SyncState): ShippedSessionRecord[] {
  return settledSessions(state, "shipped")
    .filter((entry) => entry.parent === undefined)
    .map((entry) => ({
      at: entry.at,
      session: entry.session,
      task_id: entry.task_id ?? "unknown",
      ...(entry.session_url ? { session_url: entry.session_url } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
    }));
}

/** Changes whenever a run settles something or the ledger is cleared; views rescan on it. */
export function ledgerStamp(state: SyncState): string {
  let latest = "";
  for (const entry of Object.values(state.sessions)) if (entry.at > latest) latest = entry.at;
  return `${Object.keys(state.sessions).length}@${latest}`;
}

/** Whether dir is at or under base (path-boundary-aware prefix match). */
export function isUnderDir(dir: string, base: string): boolean {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  return dir === root || dir.startsWith(`${root}/`);
}

/** Session → working directory and repo, as the cached project-dir resolver provides. */
export interface SessionLocator {
  resolve(session: AgentSession): string | null;
  resolveRepo(session: AgentSession): string | null;
}

/** The repos shipping is limited to, or null for every repo. A legacy folder scope becomes the
 * repos its folders' sessions ran in, so upgrading never widens what the user picked. */
export function studyRepoFilter(
  state: Pick<SyncState, "repo_filter" | "project_filter">,
  listSessions: () => readonly AgentSession[],
  locator: SessionLocator,
): string[] | null {
  if (state.repo_filter) return state.repo_filter;
  const folders = state.project_filter;
  if (!folders?.length) return null;
  const repos = new Set<string>();
  for (const session of listSessions()) {
    const dir = locator.resolve(session);
    if (!dir || !folders.some((base) => isUnderDir(dir, base))) continue;
    const repo = locator.resolveRepo(session);
    if (repo) repos.add(repo);
  }
  return [...repos].sort();
}

/** Keep the sessions in scope, each tagged with its repo when it ran in one: with a `filter`,
 * only sessions in a picked repo; without one, every session, in a repo or not. */
export function filterSessionsByRepo(
  sessions: readonly AgentSession[],
  filter: readonly string[] | null,
  resolveRepo: (session: AgentSession) => string | null,
): AgentSession[] {
  const kept: AgentSession[] = [];
  for (const session of sessions) {
    const repo = resolveRepo(session);
    if (repo !== null && (filter === null || filter.includes(repo))) {
      kept.push({ ...session, repo });
    } else if (filter === null) {
      kept.push(session);
    }
  }
  return kept;
}

export interface GateOptions extends PendingOptions {
  now?: Date;
  quietPeriodMs?: number;
  /** Sessions known to be over (a session-end hook said so) skip the quiet period. */
  isEnded?: (session: AgentSession) => boolean;
}

export interface GateResult {
  /** Pending sessions quiet long enough to be complete — the ship backlog. */
  ready: AgentSession[];
  /** Pending sessions still inside the quiet period; queued once quiet. */
  open: AgentSession[];
}

/** Pending sessions, split on the quiet period: fresher ones may still be running and wait for
 * a later trigger, unless they are known to have ended. A subagent's transcript waits while the
 * session it worked for (when listed) does, so it ships with or after that session and whatever
 * the session decides later (its end, an incognito opt-out) still applies to it. Keeps the input
 * order. */
export function gateSessions(
  sessions: readonly AgentSession[],
  ledger: Readonly<Record<string, LedgerEntry>>,
  options: GateOptions,
): GateResult {
  const now = options.now ?? new Date();
  const completedBefore = now.getTime() - (options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS);
  const updatedOf = new Map(sessions.map((s) => [sessionKey(s), Date.parse(s.updated)]));
  const ready: AgentSession[] = [];
  const open: AgentSession[] = [];
  for (const session of sessions) {
    const updated = Date.parse(session.updated);
    if (Number.isNaN(updated)) continue;
    if (!isPending(session, ledger[sessionKey(session)], options)) continue;
    const parent = session.parentId && updatedOf.get(`${session.harness}/${session.parentId}`);
    const active = parent && parent > updated ? parent : updated;
    if (active > completedBefore && !options.isEnded?.(session)) open.push(session);
    else ready.push(session);
  }
  return { ready, open };
}
