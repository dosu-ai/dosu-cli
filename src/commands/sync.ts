/** `dosu sync` (also `dosu knowledge sync`): ship finished local agent sessions to the selected
 * target, and `--status` for what the last runs did. */

import { Command, Option } from "commander";
import pc from "picocolors";
import { loadConfig } from "../config/config";
import { configuredTargets } from "../config/targets";
import { logger } from "../debug/logger";
import { captureHookSession, endedSessionArgs, parseEndedSessionArgs } from "../sessions/capture";
import { pinEndedSessionProjects } from "../sessions/project-dir";
import { displayRepo } from "../sessions/repo";
import { selectTarget, type TargetSelection } from "../shipper/select";
import { spawnDetachedSelf } from "../sync/detach";
import { isShippingEnabled, outcomeCounts, SESSION_OUTCOMES, type SyncState } from "../sync/state";
import { getSyncStatus, type SyncStatus } from "../sync/status";
import { runKnowledgeSync, type SyncDeps, type SyncOutcome } from "../sync/sync";
import { formatAge, printResult, truncate } from "./output";

/** Commander collector for a repeatable option (no default, so help shows none). */
function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function syncCommand(): Command {
  const cmd = new Command("sync")
    .description("Ship finished local agent sessions to Dosu memory or a session store")
    .option(
      "--target <name|url>",
      "Where to ship: 'dosu', a configured target's name, or an s3:// / r2:// / file:// URL (default: the config's default_target, else Dosu when logged in, else the first configured target)",
    )
    .option("--owner <id>", "Owner id for sessions shipped to an ad-hoc --target URL")
    .option("--quiet", "Background mode for hooks: honor backoff, exit 0, print nothing")
    .option("--detach", "Re-spawn detached and return immediately (used by agent hooks)")
    .option(
      "--bootstrap",
      "Backfill mode: ship every finished session from the last 30 days, draining the backlog (used by setup)",
    )
    .addOption(
      new Option(
        "--flush",
        "Ship every pending session now, past the quiet period, draining the backlog and resuming a paused sync (run it last on a machine about to be torn down)",
      ).conflicts("detach"),
    )
    .option("--retry-rejected", "Ship sessions the backend refused before, once more")
    .option(
      "--ended <harness:id[=transcript]>",
      "A session that just ended, with its transcript when known: ship it now, past the quiet period (session-end hooks set this)",
      collectValues,
    )
    .option(
      "--ended-path <path>",
      "A session that just ended, known only by its transcript (session-end hooks set this)",
      collectValues,
    )
    .option(
      "--status",
      "Show whether a sync is running now, plus what was settled how and recent activity",
    )
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        quiet?: boolean;
        detach?: boolean;
        bootstrap?: boolean;
        flush?: boolean;
        retryRejected?: boolean;
        ended?: string[];
        endedPath?: string[];
        status?: boolean;
        json?: boolean;
        target?: string;
        owner?: string;
      }) => {
        const ended = parseEndedSessionArgs(opts.ended ?? [], opts.endedPath ?? []);

        // --status never scans or ships: it reads the lock, the persisted
        // ledger, and the tail of the debug log.
        if (opts.status) {
          const status = getSyncStatus();
          if (opts.json) {
            printResult(status, opts);
            return;
          }
          printSyncStatus(status);
          return;
        }

        if (opts.detach) {
          // Hooks call `sync --quiet --detach`; the re-spawned child runs the
          // actual pipeline so the hooking agent gets its exit immediately. The hook payload
          // is only readable here: the child's stdin is ignored.
          // A definitive end event names its session: the child ships it right away instead of
          // waiting out the quiet period like every other session.
          const hookEnded = await captureHookSession();
          const spawned = spawnDetachedSelf([
            "knowledge",
            "sync",
            ...(opts.quiet ? ["--quiet"] : []),
            ...(opts.bootstrap ? ["--bootstrap"] : []),
            ...(opts.retryRejected ? ["--retry-rejected"] : []),
            ...(opts.target ? ["--target", opts.target] : []),
            ...(opts.owner ? ["--owner", opts.owner] : []),
            ...[...ended, ...(hookEnded ? [hookEnded] : [])].flatMap(endedSessionArgs),
          ]);
          if (!spawned) logger.debug("sync", "detach failed; nothing shipped");
          return;
        }

        // The hook that named these sessions runs in their agent's environment, so its
        // DOSU_PROJECT is theirs (and only theirs); pin it now, before a pause, backoff, or failed
        // upload can leave the session to a later run from some other environment.
        if (ended.length > 0) pinEndedSessionProjects(ended);
        let shipper: Shipper;
        try {
          shipper = buildShipper({ target: opts.target, owner: opts.owner });
        } catch (err) {
          if (opts.quiet) {
            logger.debug(
              "sync",
              `target did not resolve: ${err instanceof Error ? err.message : err}`,
            );
            return;
          }
          throw err;
        }
        const syncOptions = {
          quiet: opts.quiet,
          ended,
          flush: opts.flush,
          // Bounded by when this command started, so the run never retries a fresh refusal.
          ...(opts.retryRejected ? { retryRejectedBefore: new Date() } : {}),
          deps: { ship: shipper.ship } satisfies SyncDeps,
        };
        // One run ships every ready session, the whole backlog included.
        const outcome = await runKnowledgeSync(syncOptions);
        // A connected bucket is read on a schedule; after shipping, ask for a read now so the
        // sessions reach memory in seconds, not at the next interval. Best effort.
        const nudged = await nudgeSource(shipper, outcome);

        if (opts.quiet) return; // Invisible by contract; details are in the debug log.

        if (opts.json) {
          if (outcome.status === "error") process.exitCode = 1;
          printResult(outcome, opts);
          return;
        }

        printSyncOutcome(outcome, shipper.destination);
        if (nudged === "queued") {
          console.log(
            pc.dim("Dosu asked to read the bucket now; 'dosu sources status' follows it."),
          );
        } else if (nudged !== undefined) {
          console.log(
            pc.dim(`Dosu reads the bucket at its next interval (sync-now failed: ${nudged}).`),
          );
        }
      },
    );

  return cmd;
}

interface Shipper {
  ship: SyncDeps["ship"];
  /** What the outcome says sessions went to: "Dosu memory", or a store's name and URL. */
  destination: string;
  /** For a bucket target `dosu sources connect` registered: the source to nudge after a run. */
  sourceId?: string;
}

/** `POST /v1/memory/sources/{id}/sync` when the run shipped something to a connected bucket:
 * "queued", the failure's message, or undefined when there was nothing to nudge. Never throws,
 * and never changes the run's outcome: the schedule reads the bucket regardless. */
async function nudgeSource(
  shipper: Shipper,
  outcome: SyncOutcome,
): Promise<"queued" | string | undefined> {
  if (!shipper.sourceId) return undefined;
  const shipped = (outcome.counts?.shipped ?? 0) + (outcome.counts?.subagents.shipped ?? 0);
  if (outcome.status !== "shipped" && outcome.status !== "ship-failed") return undefined;
  if (shipped === 0) return undefined;
  const { sourcesApi } = await import("../sources/api");
  const api = sourcesApi(loadConfig());
  if (!api) {
    logger.debug("sync", "source nudge skipped: not logged in to Dosu");
    return undefined;
  }
  try {
    const queued = await api.sync(shipper.sourceId);
    logger.debug("sync", `source ${shipper.sourceId} nudged: workflow ${queued.workflow_id}`);
    return "queued";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug("sync", `source ${shipper.sourceId} nudge failed: ${message}`);
    return message;
  }
}

/** Transcript-shipping step for the selected target; `ship` is undefined when nothing can take
 * sessions: logged out (or OSS mode, no API key/deployment, no backend URL) and no bucket target
 * configured. Throws when `--target` names something that does not resolve. The user's opt-out
 * is enforced inside the sync pipeline, against the same state file it already loads. */
function buildShipper(selection: TargetSelection): Shipper {
  const cfg = loadConfig();
  const target = selectTarget(cfg, selection);
  if (!target) return { ship: undefined, destination: "Dosu memory" };
  const sourceId =
    target.kind === "store"
      ? configuredTargets(cfg).find((t) => t.name === target.name)?.source_id
      : undefined;
  return {
    destination: target.kind === "dosu" ? "Dosu memory" : `${target.name} (${target.url})`,
    ...(sourceId ? { sourceId } : {}),
    ship: async (sessions, shipped, hold, settled) => {
      const { createShipStep } = await import("../shipper/runner");
      return createShipStep({ target })(sessions, shipped, hold, settled);
    },
  };
}

/** "3 shipped · 1 trivial · 2 rejected": the non-zero ledger counts, in outcome order. Sessions
 * say "nothing settled" when empty; subagents' transcripts say nothing (""). */
export function formatOutcomeCounts(
  state: SyncState,
  of: "sessions" | "subagents" = "sessions",
): string {
  const counts = outcomeCounts(state, of);
  const parts = SESSION_OUTCOMES.filter((o) => counts[o] > 0).map(
    (o) => `${counts[o]} ${o.replaceAll("_", " ")}`,
  );
  if (parts.length > 0) return parts.join(" \u00B7 ");
  return of === "sessions" ? "nothing settled" : "";
}

/** How many sessions `--status` names for one reason before pointing at the full list. */
const ATTENTION_PREVIEW = 3;

/** Sessions settled without shipping, one group per outcome and reason: a machine full of one
 * agent with no normalizer yet would otherwise print a line per session. */
function printAttention(attention: SyncStatus["attention"]): void {
  const groups = new Map<string, { outcome: string; reason: string; sessions: string[] }>();
  for (const entry of attention) {
    const reason = entry.message ?? (entry.http_status ? `HTTP ${entry.http_status}` : "");
    const key = `${entry.outcome}\u0000${reason}`;
    const group = groups.get(key) ?? { outcome: entry.outcome, reason, sessions: [] };
    group.sessions.push(entry.session);
    groups.set(key, group);
  }
  for (const { outcome, reason, sessions } of groups.values()) {
    const why = reason ? ` \u00B7 ${reason}` : "";
    if (sessions.length === 1) {
      console.log(`  ${outcome.padEnd(11)} ${sessions[0]}${why}`);
      continue;
    }
    console.log(`  ${outcome.padEnd(11)} ${sessions.length} sessions${why}`);
    const more = sessions.length - ATTENTION_PREVIEW;
    console.log(
      pc.dim(
        `  ${"".padEnd(11)} ${sessions.slice(0, ATTENTION_PREVIEW).join(", ")}${
          more > 0 ? `, +${more} more ('dosu knowledge sessions --${outcome}')` : ""
        }`,
      ),
    );
  }
}

function printSyncStatus(status: SyncStatus, now: Date = new Date()): void {
  if (status.running) {
    console.log(
      `${pc.green("●")} Sync running \u00B7 pid ${status.pid}, started ${formatAge(status.startedAt ?? "", now)}.`,
    );
  } else if (status.staleLock) {
    console.log(
      `${pc.yellow("●")} Stale lock from pid ${status.pid} (process gone); syncs resume once it ages out.`,
    );
  } else {
    console.log("○ No sync running.");
  }

  if (!isShippingEnabled(status.state)) {
    console.log(
      pc.yellow("  Shipping disabled. Turn it on with 'dosu knowledge transcripts enable'."),
    );
  }
  if (status.state.paused) {
    console.log(
      pc.yellow(
        "  Syncing paused: stopped by you. Resume from the Activity screen or run 'dosu knowledge sync'.",
      ),
    );
  }
  const total = status.state.total_shipped ?? 0;
  console.log(
    `  Shipped:         ${total > 0 ? `${total} session${total === 1 ? "" : "s"}` : "nothing shipped yet"}`,
  );
  if (Object.keys(status.state.sessions).length > 0) {
    console.log(`  Settled:         ${formatOutcomeCounts(status.state)}`);
    const subagents = formatOutcomeCounts(status.state, "subagents");
    if (subagents) console.log(`  Subagents:       ${subagents}`);
  }
  const incognito = status.state.incognito_agents;
  if (incognito?.length) {
    console.log(`  Incognito:       ${incognito.join(", ")} (not shipped)`);
  }
  const repoFilter = status.state.repo_filter;
  if (repoFilter) {
    console.log(
      `  Scope:           ${repoFilter.length ? repoFilter.map(displayRepo).join(", ") : "no repos"}`,
    );
  } else if (status.state.project_filter?.length) {
    console.log(
      `  Scope:           ${status.state.project_filter.length} folders (converted to repos on the next sync)`,
    );
  }
  if (status.state.last_attempt_at) {
    console.log(
      `  Last attempt:    ${status.state.last_attempt_at} (${formatAge(status.state.last_attempt_at, now)})`,
    );
  }
  if (status.backoffUntil) {
    const n = status.state.consecutive_failures;
    console.log(
      pc.yellow(
        `  Backing off after ${n} failure${n === 1 ? "" : "s"}; background syncs retry after ${status.backoffUntil}.`,
      ),
    );
  }

  if (status.attention.length > 0) {
    console.log("\nNot shipped, and why:");
    printAttention(status.attention);
    if (status.outcomes.rejected > 0) {
      console.log(pc.dim("  Retry refused sessions with 'dosu knowledge sync --retry-rejected'."));
    }
  }

  if (status.recentActivity.length > 0) {
    console.log("\nRecent activity:");
    for (const line of status.recentActivity) {
      console.log(pc.dim(`  ${truncate(line, 160)}`));
    }
  }
  console.log(pc.dim("\nFollow live with 'dosu logs --follow'."));
}

function printSyncOutcome(outcome: SyncOutcome, destination: string): void {
  const plural = (n: number) => (n === 1 ? "" : "s");
  const inFlight =
    outcome.inFlightSessions > 0
      ? pc.dim(` (${outcome.inFlightSessions} more still in progress)`)
      : "";
  switch (outcome.status) {
    case "backlog": {
      // Subagents' transcripts ship with their sessions; only sessions are counted here.
      const ready = outcome.readySessions - outcome.sessions.filter((s) => s.parentId).length;
      console.log(`✓ Scanned. ${ready} finished session${plural(ready)} ready to ship${inFlight}.`);
      console.log(
        pc.dim(
          "Sign in with 'dosu setup' to ship them to Dosu memory, or add a bucket target to config.json.",
        ),
      );
      break;
    }
    case "shipped":
    case "ship-failed": {
      const {
        shipped = 0,
        subagents,
        incognito = 0,
        trivial = 0,
        unsupported = 0,
        rejected = 0,
      } = outcome.counts ?? {};
      const passed = incognito + trivial + unsupported + rejected;
      const subagentsShipped = subagents?.shipped ?? 0;
      console.log(
        `✓ Shipped ${shipped} session${plural(shipped)} to ${destination}${
          subagentsShipped > 0
            ? ` (+${subagentsShipped} subagent transcript${plural(subagentsShipped)})`
            : ""
        }${
          passed > 0
            ? pc.dim(` (${passed} passed over: incognito, too short, unsupported, or rejected)`)
            : ""
        }.`,
      );
      // Subagents' transcripts settle on their own; say which ones did not ship, and why.
      const subagentsPassed = Object.entries(subagents ?? {})
        .filter(([o, n]) => o !== "shipped" && n > 0)
        .map(([o, n]) => `${n} ${o}`);
      if (subagentsPassed.length > 0) {
        console.log(
          pc.dim(`Subagent transcripts passed over: ${subagentsPassed.join(" \u00B7 ")}.`),
        );
      }
      if (outcome.status === "ship-failed") {
        console.log(
          pc.yellow(`Shipping stopped: ${outcome.error ?? "unknown error"}. It will be retried.`),
        );
        process.exitCode = 1;
        break;
      }
      if (outcome.inFlightSessions > 0) {
        const n = outcome.inFlightSessions;
        console.log(
          pc.dim(
            `${n} session${plural(n)} still in progress will ship once ${n === 1 ? "it ends" : "they end"}.`,
          ),
        );
      }
      break;
    }
    case "disabled": {
      console.log(
        pc.dim("Transcript shipping is off. Turn it on with 'dosu knowledge transcripts enable'."),
      );
      break;
    }
    case "skipped-lock": {
      console.log(pc.dim("Skipped: another sync run is already in progress."));
      break;
    }
    case "nothing-new": {
      const open =
        outcome.inFlightSessions > 0
          ? ` ${outcome.inFlightSessions} session${plural(outcome.inFlightSessions)} still in progress.`
          : "";
      console.log(`✓ Scanned. No new finished sessions since the last run.${open}`);
      break;
    }
    case "error": {
      console.error(pc.red(`Sync failed: ${outcome.error}`));
      process.exitCode = 1;
      break;
    }
    case "skipped-backoff": {
      console.log(pc.dim("Skipped: a recent sync failed; waiting out the retry backoff."));
      break;
    }
    case "skipped-paused": {
      console.log(pc.dim("Skipped: syncing is paused. Run 'dosu knowledge sync' to resume."));
      break;
    }
  }
}
