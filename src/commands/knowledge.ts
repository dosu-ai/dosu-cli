/**
 * `dosu knowledge` — knowledge base search and listing, plus the local
 * knowledge-sync pipeline (`sync`) and its per-agent triggers (`hooks`).
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Command, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { allHookAgents, getHookAgent, type HookAgent } from "../hooks/agents";
import { HookConfigError, hookCommand } from "../hooks/formats";
import type { AgentSession } from "../sessions/scan";
import { spawnDetachedSelf } from "../sync/detach";
import { formatTokenCount, getSyncStatus, type SyncStatus } from "../sync/status";
import { MINE_BATCH_LIMIT, runKnowledgeSync, type SyncDeps, type SyncOutcome } from "../sync/sync";
import { positiveInteger } from "./arguments";
import { requireLoginConfig } from "./auth";
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
    .command("sync")
    .description("Scan local agent session history and report the mining backlog")
    .option("--quiet", "Background mode for hooks: honor backoff, exit 0, print nothing")
    .option("--detach", "Re-spawn detached and return immediately (used by agent hooks)")
    .option(
      "--bootstrap",
      "Backfill mode: mine the full local session history regardless of age and drain the backlog (used by setup)",
    )
    .option("--status", "Show whether a sync is running now, plus watermark and recent activity")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        quiet?: boolean;
        detach?: boolean;
        bootstrap?: boolean;
        status?: boolean;
        json?: boolean;
      }) => {
        // --status never scans or mines: it reads the lock, the persisted
        // watermark state, and the tail of the debug log.
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
          // actual pipeline so the hooking agent gets its exit immediately.
          spawnDetachedSelf([
            "knowledge",
            "sync",
            ...(opts.quiet ? ["--quiet"] : []),
            ...(opts.bootstrap ? ["--bootstrap"] : []),
          ]);
          return;
        }

        const deps: SyncDeps = { mine: buildMiner(opts.quiet ? "hook" : "manual") };
        let outcome = await runKnowledgeSync({
          quiet: opts.quiet,
          bootstrap: opts.bootstrap,
          deps,
        });

        // Bootstrap drains the whole backlog in this process instead of
        // stopping after one batch — a fresh install shouldn't wait for
        // future hook fires to work through its history. Each round is a
        // full gate+mine pass, so failures, backoff (quiet mode), and the
        // lock all apply per round; any non-mined status ends the drain.
        // The round cap is sized from the backlog the first pass reported
        // (bootstrap scans the full history, so there is no fixed scan
        // limit to derive it from); every mined round advances the
        // watermark by at least a full batch, so the cap only guards
        // against a pathological miner that keeps reporting progress.
        if (opts.bootstrap && deps.mine) {
          const maxRounds = Math.ceil(outcome.readySessions / MINE_BATCH_LIMIT) + 2;
          for (let round = 1; outcome.status === "mined" && round < maxRounds; round++) {
            if (!opts.quiet && !opts.json) printSyncOutcome(outcome);
            outcome = await runKnowledgeSync({ quiet: opts.quiet, bootstrap: true, deps });
          }
        }

        if (opts.quiet) return; // Invisible by contract; details are in the debug log.

        if (opts.json) {
          printResult(outcome, opts);
          if (outcome.status === "error") process.exitCode = 1;
          return;
        }

        printSyncOutcome(outcome);
      },
    );

  cmd.addCommand(hooksCommand());

  return cmd;
}

/**
 * The mining step for authenticated cloud-mode installs: a closure over the
 * stored API key + deployment. Returns undefined (gate-and-report only) when
 * the install can't mine — logged out, OSS mode, or setup never minted a key.
 */
function buildMiner(trigger: "hook" | "manual"): SyncDeps["mine"] {
  const cfg = loadConfig();
  if (cfg.mode === "oss") return undefined;
  const target = cfg.active_account?.target;
  if (!target?.api_key || !target.deployment_id) return undefined;
  const { api_key, deployment_id } = target;
  return async (sessions: AgentSession[]) => {
    const { runMiner } = await import("../miner/runner");
    return runMiner({ sessions, apiKey: api_key, deploymentID: deployment_id, trigger });
  };
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

  const wm = status.state.watermark;
  console.log(`  Mined through:   ${wm ? `${wm} (${formatAge(wm, now)})` : "nothing mined yet"}`);
  if ((status.state.total_notes ?? 0) > 0) {
    const tokens = status.state.total_learning_tokens ?? 0;
    const distilled = tokens > 0 ? `, ${formatTokenCount(tokens)} tokens distilled` : "";
    console.log(
      `  Suggested pages: ${status.state.total_notes} (from ${status.state.total_mined ?? 0} sessions${distilled})`,
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
  if (status.state.last_refusal) {
    console.log(
      pc.yellow(
        `  Mining paused: ${status.state.last_refusal.message} (${formatAge(status.state.last_refusal.at, now)})`,
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
  switch (outcome.status) {
    case "backlog": {
      const inFlight =
        outcome.inFlightSessions > 0
          ? pc.dim(` (${outcome.inFlightSessions} more still in progress)`)
          : "";
      console.log(
        `✓ Scanned. ${outcome.readySessions} new session${outcome.readySessions === 1 ? "" : "s"} ready to mine${inFlight}.`,
      );
      console.log(pc.dim("Sign in with 'dosu setup' to enable mining."));
      break;
    }
    case "mined": {
      const notes = outcome.miner?.notesWritten ?? 0;
      const remaining = outcome.readySessions - (outcome.minedSessions ?? 0);
      console.log(
        `✓ Mined ${outcome.minedSessions} session${outcome.minedSessions === 1 ? "" : "s"}, ${notes} suggested page${notes === 1 ? "" : "s"} created.`,
      );
      if (remaining > 0) {
        console.log(pc.dim(`${remaining} more in the backlog; run sync again to continue.`));
      }
      break;
    }
    case "skipped-gateway": {
      console.log(pc.yellow(outcome.miner?.message ?? "Mining unavailable right now."));
      break;
    }
    case "mine-failed": {
      console.error(pc.red(outcome.miner?.message ?? "Mining run failed."));
      process.exitCode = 1;
      break;
    }
    case "skipped-lock": {
      console.log(pc.dim("Skipped: another sync run is already in progress."));
      break;
    }
    case "nothing-new": {
      const inFlight =
        outcome.inFlightSessions > 0
          ? ` ${outcome.inFlightSessions} session${outcome.inFlightSessions === 1 ? "" : "s"} still in progress.`
          : "";
      console.log(`✓ Scanned. No new completed sessions since the last run.${inFlight}`);
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
  }
}

function resolveHookAgents(ids: string[]): HookAgent[] {
  if (ids.length === 0) {
    const installed = allHookAgents().filter((agent) => agent.isInstalled());
    if (installed.length === 0) {
      console.log(pc.dim("No supported agents detected on this machine."));
    }
    return installed;
  }
  const agents: HookAgent[] = [];
  for (const id of ids) {
    const agent = getHookAgent(id.toLowerCase());
    if (!agent) {
      console.error(
        pc.red(
          `unknown agent '${id}'. Supported: ${allHookAgents()
            .map((a) => a.id())
            .join(", ")}`,
        ),
      );
      process.exitCode = 1;
      return [];
    }
    agents.push(agent);
  }
  return agents;
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
