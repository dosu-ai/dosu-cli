/**
 * `dosu sync <owner/repo>` — re-trigger indexing for a previously added public library.
 *
 * Under the hood this calls the same create endpoint — re-adding an existing repo
 * refreshes the GitHub token and re-triggers sync.
 */

import * as p from "@clack/prompts";
import { createPublicLibrary } from "../add/flow";
import { parseRepoSlug, resolveGitHubToken } from "../add/github";
import { isAuthenticated, isTokenExpired, loadConfig } from "../config/config";
import { info } from "../setup/styles";

export interface SyncOptions {
  repo?: string;
}

export async function runSync(opts: SyncOptions): Promise<void> {
  p.intro("Sync public library");

  // Require repo slug (no list endpoint yet)
  if (!opts.repo) {
    p.log.error("Please specify a repository: dosu sync <owner/repo>");
    p.outro("Failed");
    return;
  }

  // Validate slug format
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoSlug(opts.repo));
  } catch (err: unknown) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Failed");
    return;
  }

  // Ensure authenticated
  const cfg = loadConfig();
  if (!isAuthenticated(cfg)) {
    p.log.error(`Not logged in. Run ${info("dosu login")} first.`);
    p.outro("Failed");
    return;
  }
  if (isTokenExpired(cfg)) {
    p.log.error(`Session expired. Run ${info("dosu login")} to re-authenticate.`);
    p.outro("Failed");
    return;
  }
  if (!cfg.api_key) {
    p.log.error(`No API key configured. Run ${info("dosu setup")} first.`);
    p.outro("Failed");
    return;
  }

  // Detect GitHub token
  const s = p.spinner();
  s.start("Detecting GitHub token...");
  const ghToken = resolveGitHubToken();
  if (!ghToken) {
    s.stop("No GitHub token found");
    p.log.error(
      `Could not find a GitHub token. Please set GH_TOKEN or run ${info("gh auth login")}.`,
    );
    p.outro("Failed");
    return;
  }
  s.stop("GitHub token detected");

  // Re-add triggers sync
  const repoSlug = `${owner}/${repo}`;
  s.start(`Syncing ${repoSlug}...`);
  try {
    await createPublicLibrary(cfg.api_key, repoSlug, ghToken);
  } catch (err: unknown) {
    s.stop("Sync failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Failed");
    return;
  }
  s.stop(`Sync triggered for ${repoSlug}`);

  p.log.success(`Re-indexing ${info(repoSlug)}`);
  p.outro("Done!");
}
