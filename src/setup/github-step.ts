/**
 * Setup step: connect one or more GitHub repos to the caller's Dosu workspace.
 *
 * Flow:
 *   1. Detect the local git origin (for a helpful label only).
 *   2. Pre-flight `listForOrg`.
 *   3. Present a TUI multiselect of repos with an inline "Add repositories..."
 *      option. Nothing is preselected, so Enter can always skip straight to
 *      the next sub-step.
 *   4. If the user picks "Add repositories...", start a local HTTP server, open
 *      the web `/cli/connect-github`
 *      middle page, which sets the replay cookie and forwards the browser to
 *      GitHub's App-install page. GitHub's setup URL (`/redirect/replay`)
 *      writes the `user_installation` row and bounces to `/cli/connect-github-done`,
 *      which forwards `installation_id` back to our local HTTP server.
 *   5. Keep the install spinner alive while polling `listForOrg` for up to
 *      10 seconds, then return to the same multiselect with the updated
 *      repository list.
 *   6. For each selected repo, fan out tRPC:
 *      - `workspaces.create` (creates github deployment + fires welcome email)
 *      - `dataSource.create` (creates data_source + github_data_source_config trigger)
 *      - `workspaces.listForSpace` + `deploymentDataSource.create` per deployment
 *        to link the new data_source into every workspace in the space
 *   7. Return success + the first created deployment_id.
 *
 * Never throws — returns `{advance: false}` on any failure so runSetup continues.
 */

import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { createTypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import { DEFAULT_DEPLOYMENT_CONFIG_GITHUB } from "./default-deployment-config";
import { ADD_REPOSITORIES_VALUE, promptGitHubRepositories } from "./github-repo-prompt";
import { startInstallationCallbackServer } from "./installation-server";
import { dim } from "./styles";

// `@dosu/api-types` lags the tRPC routers we just added on the server side
// (`githubRepository.listForOrg`, `dataSource.create`). Runtime routing is
// dynamic, so we bypass compile-time type checks for those two procedures
// until a new `@dosu/api-types` version is published that knows about them.
// biome-ignore lint/suspicious/noExplicitAny: see note above
type TrpcAny = any;

const INSTALLATION_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_REFRESH_POLL_INTERVAL_MS = 500;
const REPO_REFRESH_POLL_TIMEOUT_MS = 10_000;

export interface DetectedRepo {
  owner: string;
  name: string;
  slug: string;
}

export interface GithubStepResult {
  advance: boolean;
  has_connected_repo?: boolean;
  deployment_id?: string;
  space_id?: string;
}

// Shape returned by tRPC `githubRepository.listForOrg`.
interface AvailableRepo {
  repository_id: number;
  name: string;
  slug: string; // "owner/repo"
  is_deployed: boolean;
}
export function detectGitRepo(cwd: string = process.cwd()): DetectedRepo | null {
  let url: string;
  try {
    url = execSync("git config --get remote.origin.url", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
  if (!url) return null;

  let m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) {
    m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) return null;

  const [, owner, name] = m;
  return { owner, name, slug: `${owner}/${name}` };
}

async function fetchListForOrg(trpc: TrpcAny, orgID: string): Promise<AvailableRepo[]> {
  try {
    return (await trpc.githubRepository.listForOrg.query({
      org_id: orgID,
    })) as AvailableRepo[];
  } catch (err: unknown) {
    /* v8 ignore next -- non-fatal; caller decides what to do with an empty list */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `listForOrg failed: ${msg}`);
    return [];
  }
}

function buildPromptOptions(
  repos: AvailableRepo[],
): Parameters<typeof promptGitHubRepositories>[0]["options"] {
  return [
    ...repos.map((r) => ({ kind: "repo" as const, label: r.slug, value: r.slug })),
    {
      kind: "action" as const,
      label: "Add repositories...",
      value: ADD_REPOSITORIES_VALUE,
      hint: "Open GitHub and refresh this list",
    },
  ];
}

function hasNewVisibleRepository(
  previousRepos: AvailableRepo[],
  nextRepos: AvailableRepo[],
): boolean {
  const previousRepoIds = new Set(previousRepos.map((repo) => repo.repository_id));
  return nextRepos.some((repo) => !previousRepoIds.has(repo.repository_id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRepositoryRefresh(
  trpc: TrpcAny,
  orgID: string,
  previousRepos: AvailableRepo[],
): Promise<AvailableRepo[]> {
  const startedAt = Date.now();
  let latestRepos = previousRepos;

  while (Date.now() - startedAt < REPO_REFRESH_POLL_TIMEOUT_MS) {
    const polledRepos = await fetchListForOrg(trpc, orgID);
    latestRepos =
      polledRepos.length === 0 && previousRepos.length > 0 ? previousRepos : polledRepos;

    if (hasNewVisibleRepository(previousRepos, latestRepos)) {
      return latestRepos;
    }

    await sleep(REPO_REFRESH_POLL_INTERVAL_MS);
  }

  return latestRepos;
}

/**
 * Open the web `/cli/connect-github` middle page and wait for the browser to
 * POST an installation_id back via our local HTTP listener. Returns the
 * installation_id on success, or `null` on timeout / failure.
 *
 * The middle page is responsible for:
 *   1. Setting the `REPLAY_AFTER_GITHUB_REPO_INSTALLATION_KEY` cookie so that
 *      when GitHub redirects to `/redirect/replay` after install, the existing
 *      web flow upserts the `user_installation` row.
 *   2. Redirecting the browser to GitHub's App-install page.
 *   3. After GitHub bounces through `/redirect/replay`, it hands control to
 *      `/cli/connect-github-done` which forwards `installation_id` here.
 */
async function openGitHubInstallFlow(
  onInstalled?: (installationID: number) => Promise<void>,
): Promise<number | null> {
  const { server, installationPromise } = await startInstallationCallbackServer();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const callbackURL = `http://localhost:${server.port}/callback`;
    const webAppURL = getWebAppURL();
    const middleURL = new URL("/cli/connect-github", webAppURL);
    middleURL.searchParams.set("callback", callbackURL);

    p.log.info(
      "Opening your browser to GitHub.\n" +
        "Add repositories or install the Dosu GitHub App, and we'll pick up automatically.",
    );
    try {
      const open = await import("open");
      await open.default(middleURL.toString());
    } catch (err: unknown) {
      /* v8 ignore next 2 -- `open` rarely fails */
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("setup", `Failed to open browser: ${msg}`);
      p.log.info(`Could not open browser — visit ${middleURL.toString()} manually.`);
    }

    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn("setup", `GitHub install timed out after ${INSTALLATION_TIMEOUT_MS / 1000}s`);
        resolve(null);
      }, INSTALLATION_TIMEOUT_MS);
    });

    const s = p.spinner();
    s.start("Waiting for GitHub install to complete...");
    const result = await Promise.race([
      installationPromise.then((r) => r.installation_id),
      timeout,
    ]);
    if (result === null) {
      s.stop("Timed out");
      p.log.warn(
        `Didn't hear back from the browser after ${Math.floor(
          INSTALLATION_TIMEOUT_MS / 1000,
        )}s. Run \`dosu setup\` again once you've completed the install.`,
      );
      return null;
    }
    if (onInstalled) {
      await onInstalled(result);
    }
    s.stop("GitHub App connected");
    return result;
  } finally {
    clearTimeout(timeoutId);
    server.close();
  }
}

/**
 * Create one github deployment + its data_source, then link the data_source
 * into every deployment in the space. Mirrors the web
 * `OnboardingGithub.handleNext` + `useCreateDataSources` flow exactly.
 */
async function createDeploymentForRepo(
  trpc: TrpcAny,
  orgID: string,
  spaceID: string,
  repo: AvailableRepo,
): Promise<{ deployment_id: string } | null> {
  try {
    const deployment = (await trpc.workspaces.create.mutate({
      org_id: orgID,
      space_id: spaceID,
      enabled: true,
      name: repo.slug,
      description: "",
      provider_slug: "github",
      repository_id: repo.repository_id,
      metadata: {
        app: { deployment_mode: "normal", setup_mode: "auto" },
        provider_slug: "github",
      },
      config: DEFAULT_DEPLOYMENT_CONFIG_GITHUB,
    } as unknown as Parameters<typeof trpc.workspaces.create.mutate>[0])) as unknown as {
      deployment_id: string;
    } | null;
    if (!deployment?.deployment_id) {
      logger.warn("setup", `workspaces.create returned no deployment for ${repo.slug}`);
      return null;
    }

    const dataSource = (await trpc.dataSource.create.mutate({
      org_id: orgID,
      provider_slug: "github",
      name: repo.slug,
      description: "",
      repository_id: repo.repository_id,
    })) as unknown as { data_source_id: string } | null;
    if (!dataSource?.data_source_id) {
      logger.warn("setup", `dataSource.create returned no data_source for ${repo.slug}`);
      return { deployment_id: deployment.deployment_id };
    }

    const spaceDeployments = (await trpc.workspaces.listForSpace.query(spaceID)) as unknown as {
      deployment_id: string;
    }[];
    await Promise.all(
      spaceDeployments.map((d) =>
        trpc.deploymentDataSource.create.mutate({
          deployment_id: d.deployment_id,
          data_source_id: dataSource.data_source_id,
        }),
      ),
    );
    return { deployment_id: deployment.deployment_id };
  } catch (err: unknown) {
    /* v8 ignore next -- server errors bubble up */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to wire up ${repo.slug}: ${msg}`);
    return null;
  }
}

export async function stepConnectGitHubRepo(
  cfg: Config,
  detected: DetectedRepo | null = detectGitRepo(),
): Promise<GithubStepResult> {
  logger.info("setup", "Step: connect GitHub repo(s)");

  if (!cfg.org_id || !cfg.space_id) {
    p.log.warn(
      "Cannot connect GitHub: your Dosu workspace is missing org/space context. " +
        "Re-run `dosu setup` from a fresh state.",
    );
    return { advance: false, has_connected_repo: false };
  }
  const orgID = cfg.org_id;
  const spaceID = cfg.space_id;

  if (detected) {
    p.log.info(`Connecting GitHub repos (detected local repo: ${detected.slug})`);
  }

  const trpc: TrpcAny = createTypedClient(cfg);
  let repos = await fetchListForOrg(trpc, orgID);

  while (true) {
    const undeployed = repos.filter((r) => !r.is_deployed);
    const deployed = repos.filter((r) => r.is_deployed);

    // Already-connected repos are shown as an informational block above the
    // multiselect so the user can see what's set up, but the cursor can't land
    // on them. Clack has no per-option `disabled`, so this is the only way to
    // make them truly non-interactive.
    if (deployed.length > 0) {
      const lines = deployed.map((r) => `  ${dim(r.slug)}`).join("\n");
      p.log.info(`${dim("Already connected")}\n${lines}`);
    }

    const selected = await promptGitHubRepositories({
      message: "Select repositories to connect",
      options: buildPromptOptions(undeployed),
      initialValues: [],
    });
    if (p.isCancel(selected)) {
      logger.info("setup", "Repository selection cancelled");
      return { advance: false, has_connected_repo: deployed.length > 0 };
    }

    if (selected === ADD_REPOSITORIES_VALUE) {
      let refreshedRepos = repos;
      const installationID = await openGitHubInstallFlow(async () => {
        refreshedRepos = await waitForRepositoryRefresh(trpc, orgID, repos);
      });
      if (installationID === null) {
        return { advance: false, has_connected_repo: deployed.length > 0 };
      }
      repos = refreshedRepos;
      continue;
    }

    const slugs = selected as string[];
    if (slugs.length === 0) {
      p.log.info("No repositories selected.");
      return { advance: true, has_connected_repo: deployed.length > 0 };
    }

    const s = p.spinner();
    s.start(`Connecting ${slugs.length} repo${slugs.length === 1 ? "" : "s"}...`);
    const created: { deployment_id: string; slug: string }[] = [];
    for (const slug of slugs) {
      const repo = repos.find((r) => r.slug === slug);
      if (!repo) continue;
      const result = await createDeploymentForRepo(trpc, orgID, spaceID, repo);
      if (result) {
        created.push({ deployment_id: result.deployment_id, slug });
      }
    }

    if (created.length === 0) {
      s.stop("Failed");
      p.log.error("Could not connect any repos. Check `dosu logs --tail 50` for details.");
      return { advance: false, has_connected_repo: deployed.length > 0 };
    }

    s.stop(`Connected ${created.length} repo${created.length === 1 ? "" : "s"}`);
    for (const { slug, deployment_id } of created) {
      p.log.success(`${slug}\n${dim(`deployment ${deployment_id}`)}`);
    }

    // Prefer the cwd repo's deployment as the primary; fall back to the first
    // successfully created one.
    const primary = (detected && created.find((c) => c.slug === detected.slug)) ?? created[0];
    return {
      advance: true,
      has_connected_repo: true,
      deployment_id: primary.deployment_id,
      space_id: cfg.space_id,
    };
  }
}
