/** Setup's sync-scope step: before the backfill offer, the user picks which repos' sessions ship.
 * The TUI's sync-scope setting and `dosu knowledge scope set` make the same choice later. */

import { displayRepo } from "../sessions/repo";
import type { AgentSession } from "../sessions/scan";
import { saveRepoFilter } from "../sync/state";
import * as p from "../tui/prompts";
import { dim } from "./styles";

export interface ScopeCandidate {
  repo: string;
  /** Sessions counted for this repo; 0 for a repo kept only because the scope names it. */
  sessions: number;
  /** ISO time of the repo's latest session; "" when it has none. */
  updated: string;
}

/** The repos `sessions` ran in (each counted once per session; a session outside any repo
 * counts for none), most sessions first, then most recently active, plus every repo the current
 * scope names, so a picked repo with no sessions left stays removable. */
export function scopeCandidates(
  sessions: readonly AgentSession[],
  current: readonly string[] | null,
): ScopeCandidate[] {
  const byRepo = new Map<string, ScopeCandidate>();
  for (const { repo, updated } of sessions) {
    if (!repo) continue;
    const candidate = byRepo.get(repo);
    if (!candidate) byRepo.set(repo, { repo, sessions: 1, updated });
    else {
      candidate.sessions += 1;
      if (updated > candidate.updated) candidate.updated = updated;
    }
  }
  for (const repo of current ?? []) {
    if (!byRepo.has(repo)) byRepo.set(repo, { repo, sessions: 0, updated: "" });
  }
  return [...byRepo.values()].sort(
    (a, b) =>
      b.sessions - a.sessions || b.updated.localeCompare(a.updated) || a.repo.localeCompare(b.repo),
  );
}

/** Whether setup asks for the scope: only on a terminal, and only with a choice to make (one
 * repo, or none, leaves nothing to narrow). */
export function canPickScope(candidates: readonly ScopeCandidate[]): boolean {
  return process.stdin.isTTY === true && candidates.length > 1;
}

/** Ask which repos' sessions ship, preselecting the current scope (every repo when there is
 * none), and save the answer as the sync scope. Picking every repo clears the scope, so new
 * repos and sessions outside any repo ship too. Returns the scope now in force: the pick, or
 * `current` unchanged when the prompt is cancelled. */
export async function stepPickSyncScope(
  candidates: readonly ScopeCandidate[],
  current: readonly string[] | null,
): Promise<readonly string[] | null> {
  const repos = candidates.map((candidate) => candidate.repo);
  const plural = (n: number) => (n === 1 ? "" : "s");
  const selected = await p.multiselect({
    message: "Ship sessions to Dosu memory from which repos?",
    options: candidates.map(({ repo, sessions }) => ({
      value: repo,
      label: displayRepo(repo),
      hint: sessions > 0 ? `${sessions} session${plural(sessions)}` : "no recent sessions",
    })),
    initialValues: current ?? repos,
    summary: (picked) =>
      picked.length === repos.length
        ? "all repos · new ones included automatically"
        : `${picked.length} of ${repos.length} repos`,
    validate: (picked) => (picked.length === 0 ? "Select at least one repo." : undefined),
  });
  if (p.isCancel(selected)) return current;

  const scope = selected.length === repos.length ? null : selected;
  saveRepoFilter(scope);
  p.log.success(
    `Sync scope ${dim(`· ${scope ? scope.map(displayRepo).join(", ") : "all repos"}`)}`,
  );
  return scope;
}
