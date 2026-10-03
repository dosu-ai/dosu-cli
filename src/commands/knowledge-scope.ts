/** `dosu knowledge scope` and `dosu knowledge skip-backlog`: which repos' sessions ship, and from
 * when, set from the command line. The TUI's study-scope picker and setup's backfill offer make
 * the same two choices interactively; these let a provisioning script make them. */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { originRepoOfDir } from "../sessions/repo";
import { skipSessionBacklog } from "../sync/backlog";
import { loadSyncState, type SyncState, saveSyncState } from "../sync/state";
import { printResult } from "./output";

function fail(message: string): void {
  console.error(pc.red(message));
  process.exitCode = 1;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Save `repos` as the scope (null: every repo), onto a fresh read so a concurrent sync's
 * progress survives. A legacy folder scope is replaced either way. */
function saveScope(repos: string[] | null): void {
  const { repo_filter: _repos, project_filter: _folders, ...rest }: SyncState = loadSyncState();
  saveSyncState(repos ? { ...rest, repo_filter: repos } : rest);
}

export function scopeCommand(): Command {
  const cmd = new Command("scope").description(
    "Show or set which repos' sessions ship to Dosu memory (the TUI's study scope)",
  );

  cmd
    .command("show")
    .description("Show the repos whose sessions ship")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const repos = loadSyncState().repo_filter ?? null;
      if (opts.json) {
        printResult({ repos }, opts);
        return;
      }
      if (!repos) {
        console.log("Sessions from every repo ship, and sessions outside any repo.");
        return;
      }
      console.log(repos.length > 0 ? "Sessions from these repos ship:" : "No sessions ship.");
      for (const repo of repos) console.log(`  ${repo}`);
    });

  cmd
    .command("set")
    .description("Ship only sessions from the repos these checkouts come from (by origin remote)")
    .argument("<dirs...>", "Git checkouts, each with an origin remote")
    .action((dirs: string[]) => {
      const repos = new Set<string>();
      for (const arg of dirs) {
        const dir = resolve(arg);
        if (!isDirectory(dir)) return fail(`${dir} is not a directory.`);
        const repo = originRepoOfDir(dir);
        if (!repo) {
          return fail(
            `${dir} has no git origin remote; a repo scope names repositories by their origin.`,
          );
        }
        repos.add(repo);
      }
      const sorted = [...repos].sort();
      saveScope(sorted);
      console.log(`✓ Sessions ship only from ${sorted.join(", ")}.`);
    });

  cmd
    .command("clear")
    .description("Ship sessions from every repo, and sessions outside any repo")
    .action(() => {
      saveScope(null);
      console.log("✓ Sessions from every repo ship, and sessions outside any repo.");
    });

  return cmd;
}

export function skipBacklogCommand(): Command {
  return new Command("skip-backlog")
    .description(
      "Never ship the sessions waiting now (as declining setup's backfill offer does); sessions that finish or change later still ship",
    )
    .option(
      "--before <date>",
      "Only sessions last active before this date (YYYY-MM-DD, UTC) or ISO time; default: now",
    )
    .option("--json", "Output as JSON")
    .action((opts: { before?: string; json?: boolean }) => {
      const before = opts.before === undefined ? new Date() : new Date(opts.before);
      if (Number.isNaN(before.getTime())) {
        return fail(`--before takes a date like 2026-09-01 or an ISO time, not '${opts.before}'.`);
      }
      const skipped = skipSessionBacklog(before);
      if (opts.json) {
        printResult({ skipped: skipped.sessions, subagents: skipped.subagents }, opts);
        return;
      }
      const n = skipped.sessions;
      const subagents =
        skipped.subagents > 0
          ? ` (+${skipped.subagents} subagent transcript${skipped.subagents === 1 ? "" : "s"})`
          : "";
      console.log(
        `✓ Passed over ${n} session${n === 1 ? "" : "s"}${subagents} last active before ${before.toISOString()}.`,
      );
      console.log(pc.dim("Sessions that finish or change from now on still ship."));
    });
}
