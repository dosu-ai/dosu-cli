/** The knowledge-sync pipeline (scan, gate, ship): finished agent sessions go to the Dosu memory
 * ingest API. Each session the ship step settles gets a ledger entry, so it is not shipped
 * again until it changes, and quiet hook-triggered runs never throw or write to stdout/stderr. */

import { logger } from "../debug/logger";
import type { EndedSession } from "../sessions/capture";
import { createProjectDirResolver } from "../sessions/project-dir";
import {
  type AgentSession,
  childSessionsOf,
  parentSessionOf,
  SESSION_HARNESSES,
  type SessionHarness,
  scanAgentSessions,
  scannedEverywhere,
  sessionAtPath,
} from "../sessions/scan";
import type { ShippedPrefix } from "../shipper/continuation";
import { VERSION } from "../version/version";
import { fileLock, type SyncLock } from "./lock";
import {
  backoffUntil,
  filterSessionsByRepo,
  gateSessions,
  isPending,
  isShippingEnabled,
  type LedgerEntry,
  loadSyncState,
  type PendingOptions,
  pruneLedger,
  type SessionLocator,
  type SessionOutcome,
  type SyncState,
  saveSyncState,
  sessionKey,
  studyRepoFilter,
  withoutSubagents,
} from "./state";

/** Every run, the first-time backfill included, looks back this far and no further: memory
 * is most useful about recent work, and each shipped session costs a server-side ingest. */
export const SCAN_WINDOW_DAYS = 30;

/** Ledger entries outlive the scan window by this much before they are pruned. */
const LEDGER_GRACE_DAYS = 7;

/** Sessions settled per run, oldest first; a bootstrap drains the backlog run after run, and a
 * hook run leaves the rest for the next trigger. Sessions a hook named as ended, and their
 * subagents, all ship in its run even past the limit. */
export const SHIP_BATCH_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a run carrying a just-ended session waits for another run to release the lock,
 * rather than leaving the session until some later trigger. */
export const ENDED_LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 2_000;

type SyncStatus =
  | "backlog"
  | "nothing-new"
  | "shipped"
  | "ship-failed"
  | "disabled"
  | "skipped-backoff"
  | "skipped-lock"
  | "skipped-paused"
  | "error";

export interface ShipSessionResult {
  session: AgentSession;
  /** How the ship step disposed of this session. Everything but `failed` is settled in the
   * ledger; `failed` (transport, auth, 5xx) stops the batch and backs off, and the session stays
   * pending for the retry. */
  outcome: Exclude<SessionOutcome, "skipped_by_user"> | "failed";
  /** The accepted ingest task id, on `shipped`. */
  taskId?: string;
  /** Shareable memory-session page, when the backend returned one. */
  sessionUrl?: string;
  /** The project key the session shipped under, on `shipped`. */
  project?: string;
  /** On `shipped`: how many normalized records of the session have now shipped in total (a
   * tail-only upload covers the earlier ones too), and their prefixSha256. */
  records?: number;
  prefixSha256?: string;
  /** The backend's answer, on `rejected`. */
  httpStatus?: number;
  /** One renderable line for results that did not ship. */
  message?: string;
}

/** How a run settled the subagents' transcripts it examined, apart from the sessions. */
type SubagentCounts = Record<Exclude<ShipSessionResult["outcome"], "failed">, number>;

/** How a run disposed of the sessions it examined. A subagent's transcript is part of its
 * session: it counts only in `subagents` when it settles, and in `failed` when it fails. */
interface ShipCounts {
  shipped: number;
  subagents: SubagentCounts;
  /** Opted out with `/dosu-incognito`; never uploaded. */
  incognito: number;
  /** Too small to plausibly hold anything worth learning; never uploaded. */
  trivial: number;
  /** No normalizer for the harness or transcript; re-evaluated by a newer CLI. */
  unsupported: number;
  /** Refused by the backend (400/413/422); retried by `--retry-rejected`. */
  rejected: number;
  failed: number;
}

export interface SyncOutcome {
  status: SyncStatus;
  /** Pending sessions quiet long enough to ship. */
  readySessions: number;
  /** Pending sessions still inside the quiet period, not counting subagents' transcripts. */
  inFlightSessions: number;
  /** The gated backlog itself, newest first. */
  sessions: AgentSession[];
  /** Sessions this run settled in the ledger. */
  settledSessions?: number;
  counts?: ShipCounts;
  error?: string;
}

export interface SyncDeps {
  listSessions?: () => AgentSession[] | Promise<AgentSession[]>;
  loadState?: () => SyncState;
  saveState?: (state: SyncState) => void;
  /** When present, gated sessions are shipped; absent = gate-and-report only. Must process
   * oldest-first and stop after the first failed result. `shipped` says what earlier runs
   * already shipped of a session, so a resumed one can send only its new tail. */
  ship?: (
    sessions: AgentSession[],
    shipped?: (session: AgentSession) => ShippedPrefix | undefined,
  ) => Promise<ShipSessionResult[]>;
  /** Session → working directory and repo, for the shipping scope; defaults to the cached
   * resolver. */
  locator?: SessionLocator;
  lock?: SyncLock;
  now?: () => Date;
  /** The version stamped on ledger entries; defaults to this build's. */
  cliVersion?: string;
  /** Waits between lock attempts; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncOptions {
  /** Background (hook-triggered) run: honor backoff, never fail loudly. */
  quiet?: boolean;
  /** Sessions the backend refused before this time are pending again (`--retry-rejected`). */
  retryRejectedBefore?: Date;
  /** Sessions a session-end hook just reported (`--ended`/`--ended-path`): shipped this run, past
   * the quiet period and ahead of the backlog. Everything else still waits until quiet. */
  ended?: readonly EndedSession[];
  deps?: SyncDeps;
}

/** How many selected sessions a gate log line names before summarizing. */
const LOG_PREVIEW_LIMIT = 10;

/** One debug-log line naming what the gate selected: the only visibility a quiet run has. The
 * Activity screen parses its "N ready, M in flight" prefix, which counts sessions (its progress
 * bar sets them against total_shipped); subagents' transcripts are counted after it. */
function logGateResult(
  ready: readonly AgentSession[],
  open: readonly AgentSession[],
  settled: number,
): void {
  const preview = ready.slice(0, LOG_PREVIEW_LIMIT).map(sessionKey).join(", ");
  const more =
    ready.length > LOG_PREVIEW_LIMIT ? ` (+${ready.length - LOG_PREVIEW_LIMIT} more)` : "";
  const sessions = withoutSubagents(ready).length;
  const subagents = ready.length - sessions;
  logger.debug(
    "sync",
    `gate: ${sessions} ready, ${withoutSubagents(open).length} in flight${
      subagents > 0 ? ` (+${subagents} subagent transcripts ready)` : ""
    } (${settled} already settled)${preview ? ` · ${preview}${more}` : ""}`,
  );
}

function isEndedSession(ended: EndedSession, session: AgentSession): boolean {
  return (
    (ended.harness === session.harness && ended.id === session.id) ||
    (ended.path !== undefined && ended.path === session.path)
  );
}

/** Whether a hook named this session, or the session it is a subagent of, as ended: a session's
 * subagents are over when it is, and ship with it rather than after the quiet period. */
function endedByHook(ended: EndedSession, session: AgentSession): boolean {
  if (isEndedSession(ended, session)) return true;
  if (!session.parentId) return false;
  const parent = parentSessionOf(session);
  return parent !== null && isEndedSession(ended, parent);
}

/** The scan plus the sessions it cannot list: the ones a hook just named as ended and the ones
 * earlier hooks named (`remembered`), whose transcripts live outside the roots the scan walks.
 * Returns them with the transcripts worth remembering from now on: any still on disk, inside the
 * scan window, and outside the roots every scan walks (this run may list one only because its
 * hook's agent exported CLAUDE_CONFIG_DIR or CODEX_HOME, which a later run may lack). */
export function withOutsideSessions(
  scanned: readonly AgentSession[],
  ended: readonly EndedSession[],
  remembered: Readonly<Record<string, string>>,
  since: Date,
): { sessions: AgentSession[]; outside: Record<string, string> } {
  const sessions = [...scanned];
  const listed = new Set(scanned.map(sessionKey));
  const outside: Record<string, string> = {};
  const candidates = [
    ...ended,
    ...Object.entries(remembered).map(([key, path]) => {
      const [harness, id] = key.split(/\/(.*)/s);
      return { harness: harness as SessionHarness, id, path };
    }),
  ];
  const add = (session: AgentSession) => {
    const key = sessionKey(session);
    if (listed.has(key) || Date.parse(session.updated) < since.getTime()) return;
    listed.add(key);
    sessions.push(session);
  };
  for (const { harness, id, path } of candidates) {
    if (!harness || !SESSION_HARNESSES.includes(harness) || !id || !path) continue;
    if (scannedEverywhere(harness, path)) continue;
    const found = sessionAtPath(harness, id, path);
    if (!found || Date.parse(found.updated) < since.getTime()) continue;
    add(found);
    // Its subagents live beside it, outside the scan too; they are found again from it each run.
    for (const child of childSessionsOf(found)) add(child);
    outside[sessionKey(found)] = path;
  }
  return { sessions, outside };
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

function empty(status: SyncStatus): SyncOutcome {
  return { status, readySessions: 0, inFlightSessions: 0, sessions: [] };
}

/** What earlier runs shipped of a session, per its ledger entry. */
function shippedPrefix(entry: LedgerEntry | undefined): ShippedPrefix | undefined {
  return entry?.records !== undefined && entry.prefix_sha256 !== undefined
    ? { records: entry.records, prefix_sha256: entry.prefix_sha256 }
    : undefined;
}

/** The ledger entry a ship result settles, or null for a failure (still pending). `previous` is
 * the session's entry before this run: what already shipped of it is never forgotten. */
function ledgerEntry(
  result: ShipSessionResult,
  previous: LedgerEntry | undefined,
  at: string,
  cliVersion: string,
): LedgerEntry | null {
  if (result.outcome === "failed") return null;
  // A shipped session whose new content is too small to learn from stays shipped, as of now.
  if (result.outcome === "trivial" && previous?.outcome === "shipped") {
    return { ...previous, updated: result.session.updated };
  }
  const before = shippedPrefix(previous);
  const entry: LedgerEntry = {
    updated: result.session.updated,
    outcome: result.outcome,
    at,
    cli_version: cliVersion,
    ...(result.session.parentId ? { parent: result.session.parentId } : {}),
  };
  if (result.outcome === "shipped") {
    entry.task_id = result.taskId ?? "unknown";
    if (result.sessionUrl) entry.session_url = result.sessionUrl;
    if (result.project) entry.project = result.project;
    if (result.session.project) entry.workspace = result.session.project;
    if (result.records !== undefined && result.prefixSha256 !== undefined) {
      entry.records = result.records;
      entry.prefix_sha256 = result.prefixSha256;
    }
  } else if (before) {
    // Refused or passed over now, but its start still shipped: a retry can send just the tail.
    entry.records = before.records;
    entry.prefix_sha256 = before.prefix_sha256;
  }
  if (result.httpStatus !== undefined) entry.http_status = result.httpStatus;
  if (result.outcome !== "shipped" && result.message) entry.message = result.message;
  return entry;
}

export async function runKnowledgeSync(options: SyncOptions = {}): Promise<SyncOutcome> {
  const deps = options.deps ?? {};
  const loadState = deps.loadState ?? loadSyncState;
  const saveState = deps.saveState ?? saveSyncState;
  const now = deps.now ?? (() => new Date());
  const cliVersion = deps.cliVersion ?? VERSION;
  const pending: PendingOptions = { cliVersion, retryRejectedBefore: options.retryRejectedBefore };
  const ended = options.ended ?? [];
  // Memoized: the batch sort asks repeatedly, and a subagent's answer costs a stat of its parent.
  const endedKeys = new Map<string, boolean>();
  const isEnded = (session: AgentSession) => {
    if (ended.length === 0) return false;
    const key = sessionKey(session);
    let answer = endedKeys.get(key);
    if (answer === undefined) {
      answer = ended.some((e) => endedByHook(e, session));
      endedKeys.set(key, answer);
    }
    return answer;
  };

  const state = loadState();

  if (!isShippingEnabled(state)) {
    logger.debug("sync", "skipping: transcript shipping is disabled");
    return empty("disabled");
  }
  // An explicit run is an explicit resume; this run's state saves persist the clear.
  const resumes = !options.quiet && state.paused === true;
  // A hook-triggered run held back by the user's stop switch or by failure backoff does nothing,
  // unless its hook just ended a session: a paused run still remembers where that session lives,
  // and a backed-off one tries that session alone, so the last sessions before a throwaway
  // machine goes away are not left waiting out a backoff.
  let holdBack: "paused" | "backoff" | null = null;
  if (options.quiet) {
    const retryAt = backoffUntil(state);
    if (state.paused) holdBack = "paused";
    else if (retryAt && now() < retryAt) holdBack = "backoff";
    if (holdBack && ended.length === 0) {
      logger.debug(
        "sync",
        holdBack === "paused"
          ? "skipping quiet sync: syncing is paused"
          : `skipping quiet sync: backoff until ${retryAt?.toISOString()}`,
      );
      return empty(holdBack === "paused" ? "skipped-paused" : "skipped-backoff");
    }
  } else if (resumes) {
    delete state.paused;
    logger.debug("sync", "manual sync resumes paused syncing");
  }

  let ready: AgentSession[];
  let open: AgentSession[];
  try {
    // The whole window every time: listing is metadata only, and the ledger, not a count cap,
    // decides what is left to do.
    const since = new Date(now().getTime() - SCAN_WINDOW_DAYS * DAY_MS);
    const listSessions = deps.listSessions ?? (() => scanAgentSessions({ since }));
    const remembered = state.outside_sessions ?? {};
    const { sessions: scanned, outside } = withOutsideSessions(
      await listSessions(),
      ended,
      remembered,
      since,
    );
    if (!sameRecord(outside, remembered)) {
      // Saved now, whatever this run goes on to do (the next run must find these), onto a fresh
      // read so nothing a concurrent run settled meanwhile is lost.
      const fresh = loadState();
      if (Object.keys(outside).length > 0) fresh.outside_sessions = outside;
      else delete fresh.outside_sessions;
      saveState(fresh);
    }
    if (holdBack === "paused") {
      logger.debug("sync", "skipping quiet sync: syncing is paused");
      return empty("skipped-paused");
    }
    let flush: (() => void) | undefined;
    let locator = deps.locator;
    if (!locator) {
      const resolver = createProjectDirResolver();
      locator = resolver;
      flush = resolver.flush;
    }
    const repoFilter = studyRepoFilter(state, () => scanAgentSessions({}), locator);
    if (state.project_filter) {
      // One-time upgrade of a folder scope, saved now: a run that ships nothing saves no state.
      delete state.project_filter;
      if (repoFilter) state.repo_filter = repoFilter;
      saveState(state);
      logger.debug("sync", `folder scope converted to repos: ${repoFilter?.join(", ") || "none"}`);
    }
    // The ledger first, so settled sessions never cost a repo lookup.
    const gate = gateSessions(scanned, state.sessions, { ...pending, now: now(), isEnded });
    const inScope = (sessions: AgentSession[]) =>
      filterSessionsByRepo(sessions, repoFilter, (s) => locator.resolveRepo(s));
    ready = inScope(holdBack === "backoff" ? gate.ready.filter(isEnded) : gate.ready);
    open = inScope(gate.open);
    if (holdBack === "backoff") logger.debug("sync", "backing off: trying only the ended session");
    flush?.();
    logger.debug(
      "sync",
      `shipping scope ${repoFilter ? repoFilter.join(", ") || "none" : "all repos"}: ${
        ready.length + open.length
      } of ${gate.ready.length + gate.open.length} pending sessions in scope`,
    );
    logGateResult(ready, open, Object.keys(state.sessions).length);
    const endedReady = ready.filter(isEnded).map(sessionKey);
    if (ended.length > 0) {
      logger.debug("sync", `ended by hook: ${endedReady.join(", ") || "nothing pending"}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug("sync", `sync failed: ${message}`);
    try {
      saveState({
        ...state,
        last_attempt_at: now().toISOString(),
        consecutive_failures: state.consecutive_failures + 1,
      });
    } catch {
      // Persisting backoff state is best-effort; the failure itself is what matters.
    }
    return { ...empty("error"), error: message };
  }

  const base = {
    readySessions: ready.length,
    inFlightSessions: withoutSubagents(open).length,
    sessions: ready,
  };
  if (ready.length === 0) return { status: "nothing-new", ...base };
  if (!deps.ship) return { status: "backlog", ...base };

  // Single-flight. The lock loser leaves state untouched — the winner owns this run. A run
  // carrying a just-ended session waits its turn instead: the session is why it exists.
  const lock = deps.lock ?? fileLock();
  let held = lock.acquire();
  if (!held && ready.some(isEnded)) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    logger.debug("sync", "waiting for the run that holds the lock");
    for (let waited = 0; !held && waited < ENDED_LOCK_WAIT_MS; waited += LOCK_POLL_MS) {
      await sleep(LOCK_POLL_MS);
      held = lock.acquire();
    }
  }
  if (!held) {
    logger.debug("sync", "skipping: another sync run holds the lock");
    return { status: "skipped-lock", ...base };
  }

  try {
    // A run that held the lock while this one scanned may have settled some of the backlog.
    const locked = loadState();
    const todo = ready.filter((s) => isPending(s, locked.sessions[sessionKey(s)], pending));
    if (todo.length === 0) {
      return { status: "nothing-new", ...base, readySessions: 0, sessions: [] };
    }

    // Stamp this run's progress baseline into every state save so status viewers can compute
    // run-scoped progress; same-pid batches (a bootstrap drain) keep the first batch's baseline.
    const run =
      locked.run?.pid === process.pid
        ? locked.run
        : {
            pid: process.pid,
            started_at: now().toISOString(),
            baseline_shipped: locked.total_shipped ?? 0,
          };

    const counts: ShipCounts = {
      shipped: 0,
      subagents: { shipped: 0, trivial: 0, incognito: 0, rejected: 0, unsupported: 0 },
      incognito: 0,
      trivial: 0,
      unsupported: 0,
      rejected: 0,
      failed: 0,
    };
    // The ship step decides each session's fate (incognito, unsupported, trivial, rejected, or
    // shipped); this side only picks the batch and records the answers.
    // The sessions a hook named lead, so a failure further on never keeps one from being tried;
    // then their subagents, then the backlog oldest first. The batch limit never cuts the ended
    // work: on a throwaway machine, nothing may run after this.
    const rank = (s: AgentSession) =>
      ended.some((e) => isEndedSession(e, s)) ? 0 : isEnded(s) ? 1 : 2;
    const ordered = [...todo].sort(
      (a, b) => rank(a) - rank(b) || Date.parse(a.updated) - Date.parse(b.updated),
    );
    const batch = ordered.slice(0, Math.max(SHIP_BATCH_LIMIT, ordered.filter(isEnded).length));
    logger.debug("sync", `shipping ${batch.length} of ${todo.length} ready sessions`);

    let results: ShipSessionResult[];
    try {
      results = await deps.ship(batch, (s) => shippedPrefix(locked.sessions[sessionKey(s)]));
    } catch (err) {
      // The ship step reports failures per session; a throw is a step bug — treat it as one
      // failed attempt so backoff still engages instead of crashing the sync run.
      const message = err instanceof Error ? err.message : String(err);
      results = [{ session: batch[0], outcome: "failed", message }];
    }
    // By key, not identity: scoping hands the batch out as repo-tagged copies.
    const resultOf = new Map(results.map((r) => [sessionKey(r.session), r]));

    const at = now().toISOString();
    const settled = new Map<string, LedgerEntry>();
    let error: string | undefined;
    for (const session of batch) {
      const key = sessionKey(session);
      const result = resultOf.get(key);
      // No result: the batch stopped at an earlier failure; still pending.
      if (!result) continue;
      if (!session.parentId || result.outcome === "failed") counts[result.outcome] += 1;
      else counts.subagents[result.outcome] += 1;
      const entry = ledgerEntry(result, locked.sessions[key], at, cliVersion);
      if (!entry) {
        error = result.message ?? "unknown error";
        logger.debug("sync", `shipping failed at ${key}: ${error}`);
        continue;
      }
      settled.set(key, entry);
      logger.debug(
        "sync",
        entry.outcome === "shipped"
          ? `shipped session ${key} → task ${entry.task_id}${
              entry.session_url ? ` · ${entry.session_url}` : ""
            }`
          : `not shipping ${entry.outcome} session ${key}${entry.message ? `: ${entry.message}` : ""}`,
      );
    }

    // Applied to a fresh read, so a pause or opt-out flipped mid-run survives this save.
    try {
      const next = loadState();
      for (const [key, entry] of settled) next.sessions[key] = entry;
      pruneLedger(
        next,
        new Date(now().getTime() - (SCAN_WINDOW_DAYS + LEDGER_GRACE_DAYS) * DAY_MS),
      );
      next.last_attempt_at = at;
      next.consecutive_failures = counts.failed > 0 ? next.consecutive_failures + 1 : 0;
      next.total_shipped = (next.total_shipped ?? 0) + counts.shipped;
      next.run = run;
      if (resumes) delete next.paused;
      saveState(next);
    } catch {
      // Persisting progress is best-effort; the accepted tasks are already server-side.
    }
    const subagents = Object.entries(counts.subagents)
      .filter(([, n]) => n > 0)
      .map(([outcome, n]) => `${n} ${outcome}`);
    logger.debug(
      "sync",
      `ship phase: ${counts.shipped} shipped, ${counts.incognito} incognito, ${counts.trivial} trivial, ${counts.unsupported} unsupported, ${counts.rejected} rejected, ${counts.failed} failed${
        subagents.length > 0 ? `; subagent transcripts: ${subagents.join(", ")}` : ""
      }`,
    );
    return {
      status: counts.failed > 0 ? "ship-failed" : "shipped",
      ...base,
      settledSessions: settled.size,
      counts,
      ...(error ? { error } : {}),
    };
  } finally {
    lock.release();
  }
}
