/** The knowledge-sync pipeline (scan, gate, ship): finished agent sessions go to the Dosu memory
 * ingest API. Each session the ship step settles gets a ledger entry, so it is not shipped
 * again until it changes, and quiet hook-triggered runs never throw or write to stdout/stderr. */

import { logger } from "../debug/logger";
import { createProjectDirResolver } from "../sessions/project-dir";
import { type AgentSession, scanAgentSessions } from "../sessions/scan";
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
} from "./state";

/** Every run, the first-time backfill included, looks back this far and no further: memory
 * is most useful about recent work, and each shipped session costs a server-side ingest. */
export const SCAN_WINDOW_DAYS = 30;

/** Ledger entries outlive the scan window by this much before they are pruned. */
const LEDGER_GRACE_DAYS = 7;

/** Sessions settled per run, oldest first; a bootstrap drains the backlog run after run, and a
 * hook run leaves the rest for the next trigger. */
export const SHIP_BATCH_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** The backend's answer, on `rejected`. */
  httpStatus?: number;
  /** One renderable line for results that did not ship. */
  message?: string;
}

/** How a run disposed of the sessions it examined. */
interface ShipCounts {
  shipped: number;
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
  /** Pending sessions still inside the quiet period. */
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
   * oldest-first and stop after the first failed result. */
  ship?: (sessions: AgentSession[]) => Promise<ShipSessionResult[]>;
  /** Session → working directory and repo, for the shipping scope; defaults to the cached
   * resolver. */
  locator?: SessionLocator;
  lock?: SyncLock;
  now?: () => Date;
  /** The version stamped on ledger entries; defaults to this build's. */
  cliVersion?: string;
}

export interface SyncOptions {
  /** Background (hook-triggered) run: honor backoff, never fail loudly. */
  quiet?: boolean;
  /** Sessions the backend refused before this time are pending again (`--retry-rejected`). */
  retryRejectedBefore?: Date;
  deps?: SyncDeps;
}

/** How many selected sessions a gate log line names before summarizing. */
const LOG_PREVIEW_LIMIT = 10;

/** One debug-log line naming what the gate selected: the only visibility a quiet run has. The
 * Activity screen parses its "N ready, M in flight" prefix. */
function logGateResult(ready: readonly AgentSession[], inFlight: number, settled: number): void {
  const preview = ready.slice(0, LOG_PREVIEW_LIMIT).map(sessionKey).join(", ");
  const more =
    ready.length > LOG_PREVIEW_LIMIT ? ` (+${ready.length - LOG_PREVIEW_LIMIT} more)` : "";
  logger.debug(
    "sync",
    `gate: ${ready.length} ready, ${inFlight} in flight (${settled} already settled)${
      preview ? ` · ${preview}${more}` : ""
    }`,
  );
}

function empty(status: SyncStatus): SyncOutcome {
  return { status, readySessions: 0, inFlightSessions: 0, sessions: [] };
}

/** The ledger entry a ship result settles, or null for a failure (still pending). */
function ledgerEntry(
  result: ShipSessionResult,
  at: string,
  cliVersion: string,
): LedgerEntry | null {
  if (result.outcome === "failed") return null;
  const entry: LedgerEntry = {
    updated: result.session.updated,
    outcome: result.outcome,
    at,
    cli_version: cliVersion,
  };
  if (result.outcome === "shipped") {
    entry.task_id = result.taskId ?? "unknown";
    if (result.sessionUrl) entry.session_url = result.sessionUrl;
    if (result.project) entry.project = result.project;
    if (result.session.project) entry.workspace = result.session.project;
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

  const state = loadState();

  if (!isShippingEnabled(state)) {
    logger.debug("sync", "skipping: transcript shipping is disabled");
    return empty("disabled");
  }
  // An explicit run is an explicit resume; this run's state saves persist the clear.
  const resumes = !options.quiet && state.paused === true;
  if (options.quiet) {
    // The user's stop switch: hook-triggered runs stay off until resumed.
    if (state.paused) {
      logger.debug("sync", "skipping quiet sync: syncing is paused");
      return empty("skipped-paused");
    }
    const retryAt = backoffUntil(state);
    if (retryAt && now() < retryAt) {
      logger.debug("sync", `skipping quiet sync: backoff until ${retryAt.toISOString()}`);
      return empty("skipped-backoff");
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
    const scanned = await listSessions();
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
    const gate = gateSessions(scanned, state.sessions, { ...pending, now: now() });
    const inScope = (sessions: AgentSession[]) =>
      filterSessionsByRepo(sessions, repoFilter, (s) => locator.resolveRepo(s));
    ready = inScope(gate.ready);
    open = inScope(gate.open);
    flush?.();
    logger.debug(
      "sync",
      `shipping scope ${repoFilter ? repoFilter.join(", ") || "none" : "all repos"}: ${
        ready.length + open.length
      } of ${gate.ready.length + gate.open.length} pending sessions in scope`,
    );
    logGateResult(ready, open.length, Object.keys(state.sessions).length);
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

  const base = { readySessions: ready.length, inFlightSessions: open.length, sessions: ready };
  if (ready.length === 0) return { status: "nothing-new", ...base };
  if (!deps.ship) return { status: "backlog", ...base };

  // Single-flight. The lock loser leaves state untouched — the winner owns this run.
  const lock = deps.lock ?? fileLock();
  if (!lock.acquire()) {
    logger.debug("sync", "skipping: another sync run holds the lock");
    return { status: "skipped-lock", ...base };
  }

  try {
    // A run that held the lock while this one scanned may have settled some of the backlog.
    const locked = loadState();
    const todo = ready.filter((s) => isPending(s, locked.sessions[sessionKey(s)], pending));
    if (todo.length === 0)
      return { status: "nothing-new", ...base, readySessions: 0, sessions: [] };

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
      incognito: 0,
      trivial: 0,
      unsupported: 0,
      rejected: 0,
      failed: 0,
    };
    // The ship step decides each session's fate (incognito, unsupported, trivial, rejected, or
    // shipped); this side only picks the batch and records the answers.
    const batch = [...todo]
      .sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated))
      .slice(0, SHIP_BATCH_LIMIT);
    logger.debug("sync", `shipping ${batch.length} of ${todo.length} ready sessions`);

    let results: ShipSessionResult[];
    try {
      results = await deps.ship(batch);
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
      counts[result.outcome] += 1;
      const entry = ledgerEntry(result, at, cliVersion);
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
    logger.debug(
      "sync",
      `ship phase: ${counts.shipped} shipped, ${counts.incognito} incognito, ${counts.trivial} trivial, ${counts.unsupported} unsupported, ${counts.rejected} rejected, ${counts.failed} failed`,
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
