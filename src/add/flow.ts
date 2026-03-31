/**
 * `dosu add <owner/repo>` — add a public GitHub repository as a Dosu public library.
 */

import * as p from "@clack/prompts";
import { isAuthenticated, isTokenExpired, loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { dim, info } from "../setup/styles";
import { parseRepoSlug, resolveGitHubToken, validatePublicRepo } from "./github";

export interface AddOptions {
  repo: string;
}

export interface CreateLibraryResult {
  status: "created" | "already_exists";
  repo_slug: string;
  data_source_id: string;
  deployment_id: string;
  sync_triggered: boolean;
}

export async function runAdd(opts: AddOptions): Promise<void> {
  p.intro("Add public library");

  // Step 1: Parse slug
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRepoSlug(opts.repo));
  } catch (err: unknown) {
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Failed");
    return;
  }

  // Step 2: Ensure authenticated with Dosu
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

  // Step 3: Detect GitHub token
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

  // Step 4: Validate repo is public
  s.start(`Validating ${owner}/${repo}...`);
  let repoInfo: Awaited<ReturnType<typeof validatePublicRepo>>;
  try {
    repoInfo = await validatePublicRepo(owner, repo, ghToken);
  } catch (err: unknown) {
    s.stop("Validation failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Failed");
    return;
  }
  s.stop(`Validated ${repoInfo.slug}`);

  if (repoInfo.description) {
    p.log.info(dim(repoInfo.description));
  }

  // Step 5: Create public library via Dosu backend
  s.start("Adding to Dosu...");
  let result: CreateLibraryResult;
  try {
    result = await createPublicLibrary(cfg.api_key, repoInfo.slug, ghToken);
  } catch (err: unknown) {
    s.stop("Failed to add library");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Failed");
    return;
  }

  if (result.status === "already_exists") {
    s.stop("Already exists — sync re-triggered");
  } else {
    s.stop("Added to Dosu");
  }

  // Success
  p.log.success(`Added ${info(repoInfo.slug)} as a public library`);
  p.log.message(
    `Query it with:\n\n` +
      info(`ask_public_library(question="...", repository_slug="${repoInfo.slug}")`),
  );

  p.outro("Done!");
}

/**
 * Call POST /v1/public-libraries to create (or re-add) a public library.
 * Uses X-Dosu-API-Key auth.
 */
export async function createPublicLibrary(
  apiKey: string,
  repoSlug: string,
  githubToken: string,
): Promise<CreateLibraryResult> {
  const url = `${getBackendURL()}/v1/public-libraries`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Dosu-API-Key": apiKey,
      },
      body: JSON.stringify({
        repo_slug: repoSlug,
        github_token: githubToken,
      }),
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new Error("API key is invalid or expired. Run `dosu setup` to configure a new one");
    }

    if (!resp.ok) {
      let detail: string;
      try {
        detail = (await resp.text()).slice(0, 1024);
      } catch {
        detail = "";
      }
      throw new Error(`failed to create public library (status ${resp.status}): ${detail}`);
    }

    return (await resp.json()) as CreateLibraryResult;
  } finally {
    clearTimeout(timeout);
  }
}
