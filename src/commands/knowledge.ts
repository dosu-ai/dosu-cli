/** `dosu knowledge`: knowledge base search/listing, plus the local sync pipeline and its
 * per-agent hook triggers. */

import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import { allHookAgents, getHookAgent, type HookAgent } from "../hooks/agents";
import { disableClaudeContextHook, enableClaudeContextHook } from "../hooks/context";
import { HookConfigError, hookCommand } from "../hooks/formats";
import { getIncognitoAgent, installedIncognitoCommands } from "../incognito/agents";
import { isOnPath } from "../mcp/detect";
import { emitKnowledgeReport } from "../report/generate";
import { captureHookSession, endedSessionArgs, parseEndedSessionArgs } from "../sessions/capture";
import { pinEndedSessionProjects } from "../sessions/project-dir";
import { displayRepo } from "../sessions/repo";
import type { AgentSession } from "../sessions/scan";
import { listSessionBacklog } from "../sync/backlog";
import { spawnDetachedSelf } from "../sync/detach";
import {
  isShippingEnabled,
  loadSyncState,
  outcomeCounts,
  SESSION_OUTCOMES,
  type SyncState,
  setShipTranscripts,
  settledSessions,
  shippedSessions,
} from "../sync/state";
import { getSyncStatus, type SyncStatus } from "../sync/status";
import { runKnowledgeSync, SHIP_BATCH_LIMIT, type SyncDeps, type SyncOutcome } from "../sync/sync";
import { recordCommandFacets } from "../telemetry/telemetry";
import { resolveAgents } from "./agent-select";
import { positiveInteger } from "./arguments";
import { requireLoginConfig } from "./auth";
import { incognitoCommand } from "./knowledge-incognito";
import { scopeCommand, skipBacklogCommand } from "./knowledge-scope";
import { statuslineCommand } from "./knowledge-statusline";
import { printResult, printTable, truncate } from "./output";

/** Commander collector for a repeatable option (no default, so help shows none). */
function collectValues(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.org_id || !cfg.active_account?.target?.space_id) {
    console.error(pc.red("Missing org/space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function knowledgeCommand(): Command {
  const cmd = new Command("knowledge").description("Search and browse your knowledge base");

  cmd
    .command("search")
    .description("Search the knowledge base")
    .argument("<query>", "Search query")
    .option("--json", "Output as JSON")
    .addOption(new Option("--limit <n>", "Maximum results").argParser(positiveInteger).default(10))
    .action(async (query: string, opts: { json?: boolean; limit: number }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Get data source IDs for the org
      const dataSources = await client.dataSource.list.query({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        org_id: cfg.active_account!.target!.org_id!,
        excluded_provider_slugs: [],
      });

      const dataSourceIds = dataSources
        .map((ds) => ds.id)
        .filter((id): id is string => id !== null);
      if (dataSourceIds.length === 0) {
        console.log(pc.dim("No data sources connected. Add data sources in the Dosu dashboard."));
        return;
      }

      const data = await client.search.getMentions.query({
        query,
        dataSourceIds,
        entityTypes: [],
      });

      const results = data.documents;

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!results || results.length === 0) {
        console.log(pc.dim("No results found."));
        return;
      }

      const limited = results.slice(0, opts.limit);

      printTable(
        ["Title", "Type"],
        limited.map((r: { title?: string | null; entity_type?: string | null }) => [
          truncate(r.title ?? "(untitled)", 60),
          r.entity_type ?? "-",
        ]),
        { json: false, rawData: limited },
      );

      if (results.length > opts.limit) {
        console.log(pc.dim(`\n${results.length - opts.limit} more results not shown.`));
      }
    });

  cmd
    .command("list")
    .description("Show knowledge store information")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const store = await client.knowledgeStore.getBySpaceId.query(
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        { space_id: cfg.active_account!.target!.space_id! },
      );

      if (opts.json) {
        printResult(store, opts);
        return;
      }

      if (!store) {
        console.log(pc.dim("No knowledge store found for this deployment."));
        return;
      }

      console.log(pc.bold("Knowledge Store"));
      console.log(`  ID:       ${store.id}`);
      console.log(`  Space ID: ${store.space_id}`);
    });

  cmd
    .command("sessions")
    .description(
      "List local agent sessions with full project and session ids (the untruncated view of the Activity screen's tabs)",
    )
    .option("--queued", "Only sessions queued for shipping")
    .option("--open", "Only live sessions still inside the quiet period")
    .option("--shipped", "Only recently shipped sessions")
    .option("--rejected", "Only sessions the backend refused (retry with sync --retry-rejected)")
    .option("--unsupported", "Only sessions no normalizer could read yet")
    .option("--json", "Output as JSON")
    .action(
      (opts: {
        queued?: boolean;
        open?: boolean;
        shipped?: boolean;
        rejected?: boolean;
        unsupported?: boolean;
        json?: boolean;
      }) => {
        const all =
          !opts.queued && !opts.open && !opts.shipped && !opts.rejected && !opts.unsupported;
        const want = (flag: boolean | undefined) => all || Boolean(flag);
        const wantQueued = want(opts.queued);
        const wantOpen = want(opts.open);

        const backlog =
          wantQueued || wantOpen ? listSessionBacklog() : { queued: [], open: [], subagents: 0 };
        const state =
          want(opts.shipped) || want(opts.rejected) || want(opts.unsupported)
            ? loadSyncState()
            : null;
        const shipped = state && want(opts.shipped) ? shippedSessions(state) : [];
        const rejected = state && want(opts.rejected) ? settledSessions(state, "rejected") : [];
        const unsupported =
          state && want(opts.unsupported) ? settledSessions(state, "unsupported") : [];

        if (opts.json) {
          printResult(
            {
              ...(wantQueued ? { queued: backlog.queued } : {}),
              ...(wantOpen ? { open: backlog.open } : {}),
              ...((wantQueued || wantOpen) && backlog.subagents
                ? { pending_subagent_transcripts: backlog.subagents }
                : {}),
              ...(want(opts.shipped) ? { shipped } : {}),
              ...(want(opts.rejected) ? { rejected } : {}),
              ...(want(opts.unsupported) ? { unsupported } : {}),
              ...(all && state
                ? {
                    counts: outcomeCounts(state),
                    subagent_counts: outcomeCounts(state, "subagents"),
                  }
                : {}),
            },
            opts,
          );
          return;
        }

        const sessionRows = (sessions: AgentSession[]) =>
          sessions.map((s) => [s.harness, s.updated, s.project ?? "-", s.id]);
        // The ledger keys sessions as "harness/id" in one field; split it back into columns.
        const keyColumns = (key: string): [string, string] => {
          const slash = key.indexOf("/");
          return slash > 0 ? [key.slice(0, slash), key.slice(slash + 1)] : ["-", key];
        };
        const shippedRows = shipped.map((record) => {
          const [harness, id] = keyColumns(record.session);
          return [harness, record.at, record.project ?? record.workspace ?? "-", id];
        });
        const reasonRows = (entries: typeof rejected) =>
          entries.map((entry) => {
            const [harness, id] = keyColumns(entry.session);
            const reason = entry.message ?? (entry.http_status ? `HTTP ${entry.http_status}` : "-");
            return [harness, entry.at, reason, id];
          });

        let first = true;
        const section = (title: string, rows: string[][], headers: string[], emptyMsg: string) => {
          if (!first) console.log();
          first = false;
          console.log(pc.bold(`${title} (${rows.length})`));
          if (rows.length === 0) {
            console.log(pc.dim(`  ${emptyMsg}`));
            return;
          }
          printTable(headers, rows);
        };
        const sessionHeaders = (stamp: string) => ["Agent", stamp, "Project", "Session"];

        if (wantQueued) {
          section(
            "Queued",
            sessionRows(backlog.queued),
            sessionHeaders("Updated"),
            "Queue empty. Finished agent sessions appear here.",
          );
        }
        if (wantOpen) {
          section(
            "Open",
            sessionRows(backlog.open),
            sessionHeaders("Updated"),
            "No open sessions. Live agent sessions sit here until they go quiet.",
          );
        }
        const pendingSubagents = backlog.subagents ?? 0;
        if ((wantQueued || wantOpen) && pendingSubagents > 0) {
          console.log(
            pc.dim(
              `${pendingSubagents} subagent transcript${pendingSubagents === 1 ? "" : "s"} ships with these sessions.`,
            ),
          );
        }
        if (want(opts.shipped)) {
          section("Shipped", shippedRows, sessionHeaders("Shipped at"), "No sessions shipped yet.");
        }
        if (want(opts.rejected)) {
          section(
            "Rejected",
            reasonRows(rejected),
            ["Agent", "Settled at", "Reason", "Session"],
            "None. Sessions the backend refuses are listed here.",
          );
        }
        if (want(opts.unsupported)) {
          section(
            "Unsupported",
            reasonRows(unsupported),
            ["Agent", "Settled at", "Reason", "Session"],
            "None. Sessions no normalizer can read yet are listed here.",
          );
        }
        if (all && state) {
          console.log();
          console.log(pc.dim(`Settled sessions: ${formatOutcomeCounts(state)}`));
          const subagents = formatOutcomeCounts(state, "subagents");
          if (subagents) console.log(pc.dim(`Subagent transcripts: ${subagents}`));
        }
      },
    );

  cmd
    .command("sync")
    .description("Ship finished local agent sessions to Dosu memory")
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
    .option(
      "--report",
      "Write the same HTML harvest report as the log-to-dosu-knowledge skill and open it",
    )
    .option("--out <path>", "HTML report path (default: tmp/dosu-knowledge-report.html)")
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
        report?: boolean;
        out?: string;
        json?: boolean;
      }) => {
        const ended = parseEndedSessionArgs(opts.ended ?? [], opts.endedPath ?? []);
        // Analytics facets on this command's completion event: coarse trigger/status only, so
        // dashboards can tell hook fires, detached parents, and real ship runs apart.
        const trigger = opts.flush
          ? "flush"
          : opts.bootstrap
            ? "bootstrap"
            : opts.quiet
              ? "hook"
              : "manual";

        // --status never scans or ships: it reads the lock, the persisted
        // ledger, and the tail of the debug log.
        if (opts.status) {
          recordCommandFacets({ sync_trigger: trigger, sync_status: "status-only" });
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
            ...[...ended, ...(hookEnded ? [hookEnded] : [])].flatMap(endedSessionArgs),
            ...(opts.report ? ["--report"] : []),
            ...(opts.out ? ["--out", opts.out] : []),
          ]);
          // The parent's own event is tagged so it is never mistaken for a pipeline run.
          recordCommandFacets({
            sync_trigger: trigger,
            sync_status: spawned ? "detached" : "detach-failed",
          });
          return;
        }

        // The hook that named these sessions runs in their agent's environment, so its
        // DOSU_PROJECT is theirs (and only theirs); pin it now, before a pause, backoff, or failed
        // upload can leave the session to a later run from some other environment.
        if (ended.length > 0) pinEndedSessionProjects(ended);
        const deps: SyncDeps = { ship: buildShipper() };
        const syncOptions = {
          quiet: opts.quiet,
          ended,
          flush: opts.flush,
          // Bounded by when this command started, so a drain never retries a fresh refusal.
          ...(opts.retryRejected ? { retryRejectedBefore: new Date() } : {}),
          deps,
        };
        let outcome = await runKnowledgeSync(syncOptions);
        let sessionsShipped = outcome.counts?.shipped ?? 0;

        // Bootstrap and flush drain the whole backlog in this process, batch by batch, while each
        // batch makes progress; the round cap guards against a batch that never settles anything.
        if ((opts.bootstrap || opts.flush) && deps.ship) {
          const maxRounds = Math.ceil(outcome.readySessions / SHIP_BATCH_LIMIT) + 2;
          for (
            let round = 1;
            outcome.status === "shipped" &&
            (outcome.settledSessions ?? 0) > 0 &&
            (outcome.settledSessions ?? 0) < outcome.readySessions &&
            round < maxRounds;
            round++
          ) {
            if (!opts.quiet && !opts.json) printSyncOutcome(outcome);
            outcome = await runKnowledgeSync(syncOptions);
            sessionsShipped += outcome.counts?.shipped ?? 0;
          }
        }

        recordCommandFacets({
          sync_trigger: trigger,
          sync_status: outcome.status,
          sessions_shipped: sessionsShipped,
        });

        if (opts.quiet) return; // Invisible by contract; details are in the debug log.

        if (opts.json) {
          if (outcome.status === "error") process.exitCode = 1;
          if (opts.report) {
            // The sync outcome must reach stdout even when the report fails:
            // shipping already happened and callers parse this JSON.
            try {
              const report = await emitKnowledgeReport({ out: opts.out, open: false });
              printResult({ ...outcome, report }, opts);
            } catch (err) {
              const report_error = err instanceof Error ? err.message : String(err);
              printResult({ ...outcome, report_error }, opts);
            }
          } else {
            printResult(outcome, opts);
          }
          return;
        }

        printSyncOutcome(outcome);
        if (opts.report) {
          try {
            const report = await emitKnowledgeReport({ out: opts.out, open: true });
            console.log(`Wrote ${report}`);
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
          }
        }
      },
    );

  cmd
    .command("report")
    .description("Render the knowledge report from your Dosu notes and the local session logs")
    .option("--out <path>", "HTML report path (default: tmp/dosu-knowledge-report.html)")
    .option("--json", "Output the report path as JSON")
    .option("--no-open", "Write the file without opening a browser")
    .action(async (opts: { out?: string; json?: boolean; open?: boolean }) => {
      const path = await emitKnowledgeReport({
        out: opts.out,
        open: opts.json ? false : opts.open,
      });
      if (opts.json) {
        printResult({ report: path }, opts);
        return;
      }
      console.log(`Wrote ${path}`);
    });

  cmd.addCommand(hooksCommand());
  cmd.addCommand(incognitoCommand());
  cmd.addCommand(scopeCommand());
  cmd.addCommand(skipBacklogCommand());
  cmd.addCommand(statuslineCommand());
  cmd.addCommand(transcriptsCommand());
  cmd.addCommand(contextCommand(), { hidden: true });

  return cmd;
}

/** Transcript-shipping step for authenticated cloud-mode installs; undefined when the install
 * cannot ship: logged out, OSS mode, no API key/deployment, or no backend URL. The user's
 * opt-out is enforced inside the sync pipeline, against the same state file it already loads. */
function buildShipper(): SyncDeps["ship"] {
  const cfg = loadConfig();
  if (cfg.mode === "oss") return undefined;
  const target = cfg.active_account?.target;
  if (!target?.api_key || !target.deployment_id) return undefined;
  if (!isAbsoluteHttpUrl(getBackendURL())) return undefined;
  const { api_key, deployment_id } = target;
  return async (sessions, shipped) => {
    const { createShipStep } = await import("../shipper/runner");
    return createShipStep({ apiKey: api_key, deploymentId: deployment_id })(sessions, shipped);
  };
}

/** Read synchronously: under Bun, a file redirected onto stdin and read as a stream after the
 * CLI's startup awaits comes back empty, while a pipe does not. */
function readStdin(): string {
  return readFileSync(0, "utf-8");
}

/** `dosu knowledge context`: the prompt-submit hook (Claude Code by default; Codex with `--agent
 * codex --format codex`), and the lookup OpenCode and Pi plugins call with `--format plain`.
 * Hidden -- it is invoked by agents, not by people. Prints nothing and exits 0 unless there is a
 * digest to add, so a logged-out install, OSS mode, shipping switched off or a down server all
 * look like Dosu not being there. */
function contextCommand(): Command {
  return new Command("context")
    .description("Prompt-submit hook: add task memory to the agent's context")
    .option("--agent <source>", "Trajectory source the session ships as", "claude-code")
    .option(
      "--format <format>",
      "Output: claude or codex hook JSON, or plain digest text",
      "claude",
    )
    .action(async (opts: { agent: string; format: string }) => {
      const cfg = loadConfig();
      const target = cfg.active_account?.target;
      const backendUrl = getBackendURL();
      if (cfg.mode === "oss" || !target?.api_key || !target.deployment_id) return;
      if (!isAbsoluteHttpUrl(backendUrl)) return;
      if (!isShippingEnabled(loadSyncState())) return;
      const { CONTEXT_FORMATS, contextHookOutput } = await import("../memory/context-hook");
      const format = CONTEXT_FORMATS.find((f) => f === opts.format);
      if (!format) return;
      const out = await contextHookOutput(readStdin(), {
        apiKey: target.api_key,
        deploymentId: target.deployment_id,
        backendUrl,
        agent: opts.agent,
        format,
      });
      if (out) process.stdout.write(out);
    });
}

/** Whether an agent counts as on this machine; detection reads other tools' files, so one that
 * throws is treated as absent. */
function agentInstalled(agent: HookAgent): boolean {
  try {
    return agent.isInstalled();
  } catch {
    return false;
  }
}

/** Prompt-time memory once shipping is on, per agent on the machine that can take it: Claude
 * Code's hook follows the shipping switch, so it is installed here; Codex's comes with its hooks,
 * and OpenCode's plugin and pi's extension carry their own. */
function reportPromptMemory(): void {
  let claudeFailure: string | null = null;
  try {
    enableClaudeContextHook();
  } catch (err) {
    // Shipping is on either way; only the prompt hook could not be written.
    claudeFailure = err instanceof Error ? err.message : String(err);
  }
  const agents = allHookAgents().filter((agent) => agent.promptMemory && agentInstalled(agent));
  if (agents.length === 0) {
    const names = allHookAgents()
      .filter((agent) => agent.promptMemory)
      .map((agent) => agent.name())
      .join(", ");
    console.log(
      pc.yellow(
        `! Prompt-time memory not installed: no agent that supports it was found (${names}). Once one is installed, run 'dosu knowledge hooks enable <agent>'.`,
      ),
    );
    return;
  }
  for (const agent of agents) {
    if (agent.id() === "claude" && claudeFailure) {
      console.log(`! Prompt-time memory not installed for ${agent.name()}: ${claudeFailure}`);
      continue;
    }
    if (agent.promptMemory?.()) {
      console.log(`✓ ${agent.name()} will receive task memory when a prompt warrants it.`);
      continue;
    }
    const remedy =
      agent.promptMemoryRemedy?.() ?? `'dosu knowledge hooks enable ${agent.id()}' adds it.`;
    console.log(pc.yellow(`! Prompt-time memory not installed for ${agent.name()}: ${remedy}`));
  }
}

/** `dosu knowledge transcripts`: the switch for shipping finished session transcripts to Dosu
 * memory. On by default; you control what Dosu collects with this switch and the per-session
 * /dosu-incognito opt-out, and secrets are redacted locally before anything ships. */
function transcriptsCommand(): Command {
  const cmd = new Command("transcripts").description(
    "Control shipping finished session transcripts to Dosu memory (default: on)",
  );

  cmd
    .command("status")
    .description("Show whether transcript shipping is enabled, plus shipping progress")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const state = loadSyncState();
      const enabled = isShippingEnabled(state);
      const shipped = shippedSessions(state);
      if (opts.json) {
        printResult(
          {
            enabled,
            total_shipped: state.total_shipped ?? 0,
            counts: outcomeCounts(state),
            subagent_counts: outcomeCounts(state, "subagents"),
            shipped_sessions: shipped,
          },
          opts,
        );
        return;
      }
      console.log(
        enabled
          ? `${pc.green("●")} Transcript shipping is enabled (the default).`
          : "○ Transcript shipping is disabled.",
      );
      const total = state.total_shipped ?? 0;
      if (total > 0) {
        console.log(`  Shipped:         ${total} session${total === 1 ? "" : "s"}`);
      }
      const recent = shipped.slice(-5);
      if (recent.length > 0) {
        console.log("\nRecent shipments:");
        for (const record of recent) {
          console.log(
            `  ${record.session}${record.session_url ? ` \u00B7 ${record.session_url}` : ""}`,
          );
        }
      }
    });

  cmd
    .command("enable")
    .description("Ship finished sessions to Dosu memory (the default; redacted locally first)")
    .action(() => {
      setShipTranscripts(true);
      console.log("✓ Transcript shipping enabled.");
      reportPromptMemory();
      const incognito = installedIncognitoCommands();
      console.log(
        pc.dim(
          "Finished agent sessions are redacted locally, then shipped to Dosu memory on the next sync. " +
            (incognito
              ? `Use ${incognito} in a session to keep it out.`
              : "To keep a single session out, install the agent's incognito command with 'dosu knowledge hooks enable <agent>'."),
        ),
      );
    });

  cmd
    .command("disable")
    .description("Stop shipping session transcripts to Dosu memory")
    .action(() => {
      setShipTranscripts(false);
      console.log("✓ Transcript shipping disabled.");
      try {
        disableClaudeContextHook();
      } catch {
        // An unparseable settings file is the user's to fix; shipping is already off.
      }
    });

  return cmd;
}

/** "3m ago" / "2h 10m ago" for status timestamps; falls back to the raw value. */
function formatAge(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "3 shipped · 1 trivial · 2 rejected": the non-zero ledger counts, in outcome order. Sessions
 * say "nothing settled" when empty; subagents' transcripts say nothing (""). */
function formatOutcomeCounts(state: SyncState, of: "sessions" | "subagents" = "sessions"): string {
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

function printSyncOutcome(outcome: SyncOutcome): void {
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
      console.log(pc.dim("Sign in with 'dosu setup' to ship them to Dosu memory."));
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
        `✓ Shipped ${shipped} session${plural(shipped)} to Dosu memory${
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
      const remaining = outcome.readySessions - (outcome.settledSessions ?? 0);
      if (remaining > 0) {
        console.log(pc.dim(`${remaining} more in the backlog; run sync again to continue.`));
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

function resolveHookAgents(ids: string[]): HookAgent[] {
  return resolveAgents(ids, allHookAgents, getHookAgent);
}

function hooksCommand(): Command {
  const cmd = new Command("hooks").description(
    "Manage the session-end hooks that trigger knowledge sync",
  );

  cmd
    .command("status")
    .description("Show hook status for each supported agent")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = allHookAgents().map((agent) => {
        let enabled = false;
        let note: string | undefined;
        try {
          enabled = agent.isEnabled();
          if (enabled) note = agent.statusNote?.() || undefined;
        } catch (err) {
          note = err instanceof Error ? err.message : String(err);
        }
        return {
          agent: agent.id(),
          name: agent.name(),
          installed: agent.isInstalled(),
          enabled,
          config_path: agent.configPath(),
          ...(note ? { note } : {}),
        };
      });

      if (opts.json) {
        printResult(rows, opts);
        return;
      }

      for (const row of rows) {
        const state = !row.installed
          ? pc.dim("not installed")
          : row.enabled
            ? pc.green("enabled")
            : "disabled";
        console.log(`  ${row.agent.padEnd(8)} ${row.name.padEnd(14)} ${state}`);
        if (row.note) console.log(pc.yellow(`    ${row.note}`));
      }
      console.log(
        pc.dim("\nUse 'dosu knowledge hooks enable|disable [agent...]' to change these."),
      );
    });

  cmd
    .command("enable [agents...]")
    .description("Install the sync hook for agents (default: all detected)")
    .action((ids: string[]) => {
      const agents = resolveHookAgents(ids);
      if (ids.length === 0) {
        // No agent named: only detected ones get hooks; never pass over the rest in silence.
        const skipped = allHookAgents().filter((agent) => !agent.isInstalled());
        if (skipped.length > 0) {
          console.log(
            pc.yellow(
              `! Skipped ${skipped.map((agent) => agent.name()).join(", ")}: not detected on this machine. Name an agent to install its hook anyway: dosu knowledge hooks enable <agent>`,
            ),
          );
        }
      }
      const devMode = process.env.DOSU_DEV === "true";
      // Dev hooks pin this working copy by absolute path, so PATH is moot.
      if (agents.length > 0 && !devMode && !dosuOnPath()) {
        console.log(
          pc.yellow(
            "Warning: 'dosu' is not on PATH; hooks run 'dosu knowledge sync' and will fail until it is.",
          ),
        );
      }
      if (agents.length > 0 && devMode) {
        console.log(pc.dim(`Dev mode: hooks will run ${hookCommand()}`));
      }
      for (const agent of agents) {
        try {
          agent.enable();
          console.log(`✓ ${agent.name()} \u00B7 hook enabled (${agent.configPath()})`);
          const note = agent.enableNote?.();
          if (note) console.log(pc.dim(`  ${note}`));
          const incognito = getIncognitoAgent(agent.id());
          if (incognito?.isEnabled()) {
            console.log(
              pc.dim(`  Run ${incognito.invocation()} in a session to keep it out of Dosu memory.`),
            );
          }
        } catch (err) {
          reportHookFailure(agent, err);
        }
      }
    });

  cmd
    .command("disable [agents...]")
    .description("Remove the sync hook from agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveHookAgents(ids)) {
        try {
          agent.disable();
          console.log(`✓ ${agent.name()} \u00B7 hook disabled`);
          const note = agent.disableNote?.();
          if (note) console.log(pc.dim(`  ${note}`));
        } catch (err) {
          reportHookFailure(agent, err);
        }
      }
    });

  return cmd;
}

function reportHookFailure(agent: HookAgent, err: unknown): void {
  const message =
    err instanceof HookConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${agent.name()}: ${message}`));
  process.exitCode = 1;
}

/** Hooks invoke plain `dosu`; warn at enable time when that will not resolve. */
function dosuOnPath(): boolean {
  return isOnPath(process.platform === "win32" ? "dosu.cmd" : "dosu");
}
