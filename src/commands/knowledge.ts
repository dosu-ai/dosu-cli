/** `dosu knowledge`: knowledge base search/listing, plus the local sync pipeline and its
 * per-agent hook triggers. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Command, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import { allHookAgents, getHookAgent, type HookAgent } from "../hooks/agents";
import { disableClaudeContextHook, enableClaudeContextHook } from "../hooks/context";
import { HookConfigError, hookCommand } from "../hooks/formats";
import { buildKnowledgeReport, DEFAULT_REPORT_DAYS, emitKnowledgeReport } from "../report/generate";
import type { AgentSession } from "../sessions/scan";
import { listSessionBacklog } from "../sync/backlog";
import { spawnDetachedSelf } from "../sync/detach";
import { getSyncStatus, type SyncStatus } from "../sync/status";
import { runKnowledgeSync, SHIP_BATCH_LIMIT, type SyncDeps, type SyncOutcome } from "../sync/sync";
import { isShippingEnabled, loadSyncState, setShipTranscripts } from "../sync/watermark";
import { recordCommandFacets } from "../telemetry/telemetry";
import { resolveAgents } from "./agent-select";
import { positiveInteger } from "./arguments";
import { requireLoginConfig } from "./auth";
import { incognitoCommand } from "./knowledge-incognito";
import { statuslineCommand } from "./knowledge-statusline";
import { printResult, printTable, truncate } from "./output";

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
    .option("--shipped", "Only recent shipped-session history")
    .option("--json", "Output as JSON")
    .action((opts: { queued?: boolean; open?: boolean; shipped?: boolean; json?: boolean }) => {
      const all = !opts.queued && !opts.open && !opts.shipped;
      const wantQueued = all || Boolean(opts.queued);
      const wantOpen = all || Boolean(opts.open);
      const wantShipped = all || Boolean(opts.shipped);

      const backlog = wantQueued || wantOpen ? listSessionBacklog() : { queued: [], open: [] };
      const shipped = wantShipped ? (loadSyncState().shipped_sessions ?? []) : [];

      if (opts.json) {
        printResult(
          {
            ...(wantQueued ? { queued: backlog.queued } : {}),
            ...(wantOpen ? { open: backlog.open } : {}),
            ...(wantShipped ? { shipped } : {}),
          },
          opts,
        );
        return;
      }

      const sessionRows = (sessions: AgentSession[]) =>
        sessions.map((s) => [s.harness, s.updated, s.project ?? "-", s.id]);
      // Shipped history stores "harness/id" in one field; split it back into columns.
      const shippedRows = shipped.map((record) => {
        const slash = record.session.indexOf("/");
        const harness = slash > 0 ? record.session.slice(0, slash) : "-";
        const id = slash > 0 ? record.session.slice(slash + 1) : record.session;
        return [harness, record.at, record.project ?? "-", id];
      });

      let first = true;
      const section = (title: string, rows: string[][], stamp: string, emptyMsg: string) => {
        if (!first) console.log();
        first = false;
        console.log(pc.bold(`${title} (${rows.length})`));
        if (rows.length === 0) {
          console.log(pc.dim(`  ${emptyMsg}`));
          return;
        }
        printTable(["Agent", stamp, "Project", "Session"], rows);
      };

      if (wantQueued) {
        section(
          "Queued",
          sessionRows(backlog.queued),
          "Updated",
          "Queue empty. Finished agent sessions appear here.",
        );
      }
      if (wantOpen) {
        section(
          "Open",
          sessionRows(backlog.open),
          "Updated",
          "No open sessions. Live agent sessions sit here until they go quiet.",
        );
      }
      if (wantShipped) {
        section("Shipped", shippedRows, "Shipped at", "No sessions shipped yet.");
      }
    });

  cmd
    .command("sync")
    .description("Ship finished local agent sessions to Dosu memory")
    .option("--quiet", "Background mode for hooks: honor backoff, exit 0, print nothing")
    .option("--detach", "Re-spawn detached and return immediately (used by agent hooks)")
    .option(
      "--bootstrap",
      "Backfill mode: ship every finished session from the last 30 days, draining the backlog (used by setup)",
    )
    .option("--status", "Show whether a sync is running now, plus watermark and recent activity")
    .option(
      "--report",
      "Afterwards, write the memory report (as `dosu knowledge report`) and open it",
    )
    .option("--out <path>", "HTML report path (default: tmp/dosu-memory-report.html)")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        quiet?: boolean;
        detach?: boolean;
        bootstrap?: boolean;
        status?: boolean;
        report?: boolean;
        out?: string;
        json?: boolean;
      }) => {
        // Analytics facets on this command's completion event: coarse trigger/status only, so
        // dashboards can tell hook fires, detached parents, and real ship runs apart.
        const trigger = opts.bootstrap ? "bootstrap" : opts.quiet ? "hook" : "manual";

        // --status never scans or ships: it reads the lock, the persisted
        // watermark state, and the tail of the debug log.
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
          // actual pipeline so the hooking agent gets its exit immediately.
          const spawned = spawnDetachedSelf([
            "knowledge",
            "sync",
            ...(opts.quiet ? ["--quiet"] : []),
            ...(opts.bootstrap ? ["--bootstrap"] : []),
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

        const deps: SyncDeps = { ship: buildShipper() };
        let outcome = await runKnowledgeSync({
          quiet: opts.quiet,
          bootstrap: opts.bootstrap,
          deps,
        });
        let sessionsShipped = outcome.counts?.shipped ?? 0;

        // Bootstrap drains the whole backlog in this process, batch by batch, while each batch
        // makes progress; the round cap guards against a batch that never settles anything.
        if (opts.bootstrap && deps.ship) {
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
            outcome = await runKnowledgeSync({ quiet: opts.quiet, bootstrap: true, deps });
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
    .description(
      "Show what your recent agent sessions taught Dosu memory, as an HTML page linking into Dosu",
    )
    .addOption(
      new Option("--days <n>", "How far back to look")
        .argParser(positiveInteger)
        .default(DEFAULT_REPORT_DAYS),
    )
    .option("--out <path>", "HTML report path (default: tmp/dosu-memory-report.html)")
    .option("--json", "Print the report data as JSON instead of writing HTML")
    .option("--no-open", "Write the file without opening a browser")
    .action(async (opts: { days: number; out?: string; json?: boolean; open?: boolean }) => {
      try {
        if (opts.json) {
          printResult(await buildKnowledgeReport({ days: opts.days }), opts);
          return;
        }
        const path = await emitKnowledgeReport({ days: opts.days, out: opts.out, open: opts.open });
        console.log(`Wrote ${path}`);
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });

  cmd.addCommand(hooksCommand());
  cmd.addCommand(incognitoCommand());
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
  return async (sessions: AgentSession[]) => {
    const { createShipStep } = await import("../shipper/runner");
    return createShipStep({ apiKey: api_key, deploymentId: deployment_id })(sessions);
  };
}

/** The git branch checked out in `cwd`, or null. Bounded, because the user's prompt waits. */
function currentBranch(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf-8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Read synchronously: under Bun, a file redirected onto stdin and read as a stream after the
 * CLI's startup awaits comes back empty, while a pipe does not. */
function readStdin(): string {
  return readFileSync(0, "utf-8");
}

/** `dosu knowledge context`: the Claude Code UserPromptSubmit hook. Hidden -- it is invoked by
 * the agent, not by people. Prints nothing and exits 0 unless there is a digest to add, so a
 * logged-out install, OSS mode or a down server all look like Dosu not being there. */
function contextCommand(): Command {
  return new Command("context")
    .description("Prompt-submit hook: add task memory to the agent's context")
    .action(async () => {
      const cfg = loadConfig();
      const target = cfg.active_account?.target;
      const backendUrl = getBackendURL();
      if (cfg.mode === "oss" || !target?.api_key || !target.deployment_id) return;
      if (!isAbsoluteHttpUrl(backendUrl)) return;
      const { contextHookOutput } = await import("../memory/context-hook");
      const out = await contextHookOutput(readStdin(), {
        apiKey: target.api_key,
        deploymentId: target.deployment_id,
        backendUrl,
        branchOf: currentBranch,
      });
      if (out) process.stdout.write(out);
    });
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
      if (opts.json) {
        printResult(
          {
            enabled,
            total_shipped: state.total_shipped ?? 0,
            watermark: state.watermark,
            shipped_sessions: state.shipped_sessions ?? [],
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
      if (state.watermark) console.log(`  Shipped through: ${state.watermark}`);
      const recent = (state.shipped_sessions ?? []).slice(-5);
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
      try {
        if (enableClaudeContextHook()) {
          console.log("✓ Claude Code will receive task memory when a prompt warrants it.");
        }
      } catch (err) {
        // Shipping is on either way; only the prompt hook could not be written.
        console.log(
          `! Prompt-time memory not installed: ${err instanceof Error ? err.message : err}`,
        );
      }
      console.log(
        pc.dim(
          "Finished agent sessions are redacted locally, then shipped to Dosu memory on the next sync. " +
            "Use /dosu-incognito in a session to keep that session out.",
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
  const wm = status.state.watermark;
  console.log(`  Shipped through: ${wm ? `${wm} (${formatAge(wm, now)})` : "nothing shipped yet"}`);
  const total = status.state.total_shipped ?? 0;
  if (total > 0) console.log(`  Shipped:         ${total} session${total === 1 ? "" : "s"}`);
  if (status.state.project_filter?.length) {
    const home = homedir();
    const scope = status.state.project_filter
      .map((dir) => (dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir))
      .join(", ");
    console.log(`  Scope:           ${scope}`);
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
      console.log(
        `✓ Scanned. ${outcome.readySessions} finished session${plural(outcome.readySessions)} ready to ship${inFlight}.`,
      );
      console.log(pc.dim("Sign in with 'dosu setup' to ship them to Dosu memory."));
      break;
    }
    case "shipped":
    case "ship-failed": {
      const {
        shipped = 0,
        incognito = 0,
        trivial = 0,
        scratch = 0,
        skipped = 0,
      } = outcome.counts ?? {};
      const passed = incognito + trivial + scratch + skipped;
      console.log(
        `✓ Shipped ${shipped} session${plural(shipped)} to Dosu memory${
          passed > 0
            ? pc.dim(` (${passed} passed over: incognito, temp dir, too short, or rejected)`)
            : ""
        }.`,
      );
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
  const bin = process.platform === "win32" ? "dosu.cmd" : "dosu";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, bin)));
}
