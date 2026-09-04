/** Setup step: connect one or more GitHub repos to the caller's Dosu workspace. Never throws;
 * returns `{advance: false}` on any failure so runSetup continues. */

import { execSync } from "node:child_process";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { getWebAppURL } from "../config/constants";
import { logger } from "../debug/logger";
import * as p from "../tui/prompts";
import { DEFAULT_DEPLOYMENT_CONFIG_GITHUB } from "./default-deployment-config";
import {
  ADD_REPOSITORIES_VALUE,
  promptGitHubRepositories,
  REFRESH_LIST_VALUE,
} from "./github-repo-prompt";
import { startInstallationCallbackServer } from "./installation-server";
import { browserFallbackHint, dim } from "./styles";

const INSTALLATION_TIMEOUT_MS = 10 * 60 * 1000;
const REPO_REFRESH_POLL_INTERVAL_MS = 500;
const REPO_REFRESH_POLL_TIMEOUT_MS = 10_000;
// Cap visible rows so orgs with hundreds of repos don't blow past the terminal height.
const REPO_MULTISELECT_MAX_ITEMS = 10;
// Backend sync deletes the data_source if it can't reach the repo (usually within 3-7s); poll a
// little past that to detect the drop before reporting Connected.
const DATA_SOURCE_VERIFY_POLL_INTERVAL_MS = 1_000;
const DATA_SOURCE_VERIFY_POLL_TIMEOUT_MS = 10_000;

export interface DetectedRepo {
  owner: string;
  name: string;
  slug: string;
}

/** Knobs for the post-connect polls. Real runs use the defaults; tests inject `0` so they don't
 * burn real time. */
export interface StepConnectGitHubRepoOptions {
  verify?: {
    timeoutMs?: number;
    intervalMs?: number;
  };
  refresh?: {
    timeoutMs?: number;
    intervalMs?: number;
  };
  install?: {
    timeoutMs?: number;
  };
}

export interface GithubStepResult {
  advance: boolean;
  has_connected_repo?: boolean;
  deployment_id?: string;
  space_id?: string;
  /** Data sources connected in this run that survived the backend's initial sync; downstream
   * doc-import waits on exactly this set. */
  created_data_source_ids?: string[];
  /** Repository slugs for the data sources created in this run. */
  created_repository_slugs?: string[];
}

// Shape returned by tRPC `githubRepository.listForOrg`. Backend spreads `...github.repository`,
// so `created_at` rides along even though the router type doesn't surface it.
interface AvailableRepo {
  repository_id: number;
  name: string;
  slug: string; // "owner/repo"
  is_deployed: boolean;
  created_at?: string;
  /** Forks can't be synced by the backend, so the picker disables them like the web UI. */
  is_fork?: boolean | null;
  fork_parent_slug?: string | null;
}

export function parseAvailableRepos(value: unknown): AvailableRepo[] {
  if (!Array.isArray(value)) throw new Error("githubRepository.listForOrg returned a non-array");
  return value.map((repository, index) => {
    if (
      repository === null ||
      typeof repository !== "object" ||
      !("repository_id" in repository) ||
      typeof repository.repository_id !== "number" ||
      !("name" in repository) ||
      typeof repository.name !== "string" ||
      !("slug" in repository) ||
      typeof repository.slug !== "string" ||
      !("is_deployed" in repository) ||
      typeof repository.is_deployed !== "boolean" ||
      ("created_at" in repository &&
        repository.created_at !== undefined &&
        typeof repository.created_at !== "string") ||
      ("is_fork" in repository &&
        repository.is_fork !== undefined &&
        repository.is_fork !== null &&
        typeof repository.is_fork !== "boolean") ||
      ("fork_parent_slug" in repository &&
        repository.fork_parent_slug !== undefined &&
        repository.fork_parent_slug !== null &&
        typeof repository.fork_parent_slug !== "string")
    ) {
      throw new Error(
        `githubRepository.listForOrg returned an invalid repository at index ${index}`,
      );
    }
    return repository as AvailableRepo;
  });
}

export function parseDeploymentIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("workspaces.listForSpace returned a non-array");
  return value.map((deployment, index) => {
    if (
      deployment === null ||
      typeof deployment !== "object" ||
      !("deployment_id" in deployment) ||
      typeof deployment.deployment_id !== "string"
    ) {
      throw new Error(`workspaces.listForSpace returned an invalid deployment at index ${index}`);
    }
    return deployment.deployment_id;
  });
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

interface SpaceGithubSources {
  repositoryIds: Set<number>;
  slugs: Set<string>;
}

/** Space Library sources are the truth for "connected"; org-scoped `is_deployed` counts orphan
 * rows. Returns `null` when the backend can't answer so the caller falls back to `is_deployed`. */
async function fetchSpaceGithubSources(
  trpc: TypedClient,
  spaceID: string,
): Promise<SpaceGithubSources | null> {
  try {
    const sources = await trpc.libraries.sourcesList.query(spaceID);
    const github = (sources ?? []).filter((source) => source.provider_slug === "github");
    return {
      repositoryIds: new Set(
        github
          .map((source) => source.repository_id)
          .filter((id): id is number => typeof id === "number"),
      ),
      // Data source `name` is the repo slug for github sources — fallback
      // match for rows missing repository_id.
      slugs: new Set(github.map((source) => source.name).filter(Boolean)),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `libraries.sourcesList failed, falling back to is_deployed: ${msg}`);
    return null;
  }
}

function isConnectedToSpace(repo: AvailableRepo, sources: SpaceGithubSources | null): boolean {
  if (sources === null) return repo.is_deployed;
  return sources.repositoryIds.has(repo.repository_id) || sources.slugs.has(repo.slug);
}

/** Map of repository_id to deployment_id for github deployments org-wide. A repo gets exactly
 * one deployment ever, so an existing one must be reused. Fails open to an empty map. */
async function fetchOrgGithubDeployments(
  trpc: TypedClient,
  orgID: string,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const rows = await trpc.workspaces.listForOrg.query(orgID);
    for (const row of rows ?? []) {
      if (
        row.provider_slug === "github" &&
        typeof row.repository_id === "number" &&
        !map.has(row.repository_id)
      ) {
        map.set(row.repository_id, row.deployment_id);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `workspaces.listForOrg during connect failed: ${msg}`);
  }
  return map;
}

/** Map of repository_id to data_source_id for github data sources org-wide; reuse instead of
 * creating duplicates. Fails open to an empty map. */
async function fetchOrgGithubDataSources(
  trpc: TypedClient,
  orgID: string,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const listed = await trpc.dataSource.list.query({
      org_id: orgID,
      excluded_provider_slugs: [],
    });
    for (const source of listed ?? []) {
      if (
        source.provider_slug === "github" &&
        typeof source.repository_id === "number" &&
        source.data_source_id &&
        !map.has(source.repository_id)
      ) {
        map.set(source.repository_id, source.data_source_id);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `dataSource.list during connect failed: ${msg}`);
  }
  return map;
}

async function fetchListForOrg(trpc: TypedClient, orgID: string): Promise<AvailableRepo[]> {
  try {
    const repos = parseAvailableRepos(
      await trpc.githubRepository.listForOrg.query({
        org_id: orgID,
      }),
    );
    return sortReposByRecency(repos);
  } catch (err: unknown) {
    /* v8 ignore next -- non-fatal; caller decides what to do with an empty list */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `listForOrg failed: ${msg}`);
    return [];
  }
}

/** Most recently added repos first (the backend's alphabetical order buries fresh installs).
 * Repos missing `created_at` keep their incoming order since sort is stable. */
function sortReposByRecency(repos: AvailableRepo[]): AvailableRepo[] {
  return [...repos].sort((a, b) => {
    const ta = Date.parse(a.created_at ?? "") || 0;
    const tb = Date.parse(b.created_at ?? "") || 0;
    return tb - ta;
  });
}

function buildPromptOptions(
  available: AvailableRepo[],
  connected: AvailableRepo[] = [],
): Parameters<typeof promptGitHubRepositories>[0]["options"] {
  return [
    {
      kind: "action" as const,
      label: "Add repositories...",
      value: ADD_REPOSITORIES_VALUE,
      hint: "Open GitHub to install/update access",
    },
    {
      kind: "action" as const,
      label: "Refresh list",
      value: REFRESH_LIST_VALUE,
      hint: "Re-check Dosu for new repos",
    },
    { kind: "separator" as const },
    ...available.map((r) =>
      r.is_fork === true
        ? {
            kind: "repo" as const,
            label: r.slug,
            value: r.slug,
            disabled: true,
            hint: r.fork_parent_slug
              ? `Forked repo; connect ${r.fork_parent_slug} instead`
              : "Forked repo, can't be connected",
          }
        : { kind: "repo" as const, label: r.slug, value: r.slug },
    ),
    // Repos already attached to this Library stay visible for context but
    // can't be picked — rendered dimmed, skipped by the cursor.
    ...connected.map((r) => ({
      kind: "repo" as const,
      label: r.slug,
      value: r.slug,
      disabled: true,
      hint: "Connected",
    })),
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
  trpc: TypedClient,
  orgID: string,
  previousRepos: AvailableRepo[],
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<{ repos: AvailableRepo[]; foundNew: boolean }> {
  const timeoutMs = opts?.timeoutMs ?? REPO_REFRESH_POLL_TIMEOUT_MS;
  const intervalMs = opts?.intervalMs ?? REPO_REFRESH_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let latestRepos = previousRepos;

  while (Date.now() - startedAt < timeoutMs) {
    const polledRepos = await fetchListForOrg(trpc, orgID);
    latestRepos =
      polledRepos.length === 0 && previousRepos.length > 0 ? previousRepos : polledRepos;

    if (hasNewVisibleRepository(previousRepos, latestRepos)) {
      return { repos: latestRepos, foundNew: true };
    }

    await sleep(intervalMs);
  }

  return { repos: latestRepos, foundNew: false };
}

/** Open the web `/cli/connect-github` page and wait for the browser to send an installation_id
 * back to the local listener. Returns the id on success, or `null` on timeout / failure. */
async function openGitHubInstallFlow(
  onInstalled?: (installationID: number) => Promise<void>,
  opts?: { timeoutMs?: number },
): Promise<number | null> {
  const timeoutMs = opts?.timeoutMs ?? INSTALLATION_TIMEOUT_MS;
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
    p.log.message(browserFallbackHint(middleURL.toString()));
    try {
      const open = await import("open");
      await open.default(middleURL.toString());
    } catch (err: unknown) {
      /* v8 ignore next 2 -- `open` rarely fails */
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("setup", `Failed to open browser: ${msg}`);
      p.log.info(`Could not open browser; visit ${middleURL.toString()} manually.`);
    }

    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        logger.warn("setup", `GitHub install timed out after ${timeoutMs / 1000}s`);
        resolve(null);
      }, timeoutMs);
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
          timeoutMs / 1000,
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

/** Pre-existing rows the connect path should reuse instead of duplicating. */
interface ExistingRepoWiring {
  deploymentID?: string;
  dataSourceID?: string;
}

/** Create (or reuse) a repo's github deployment + data_source and link the source into every
 * space deployment. Rolls back a deployment created here if `dataSource.create` fails. */
async function createDeploymentForRepo(
  trpc: TypedClient,
  orgID: string,
  spaceID: string,
  repo: AvailableRepo,
  existing: ExistingRepoWiring = {},
): Promise<{ deployment_id: string; data_source_id: string } | null> {
  try {
    let deploymentID = existing.deploymentID;
    let createdDeployment = false;
    if (deploymentID) {
      logger.info("setup", `Reusing existing deployment ${deploymentID} for ${repo.slug}`);
    } else {
      const deployment = await trpc.workspaces.create.mutate({
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
      });
      if (!deployment?.deployment_id) {
        logger.warn("setup", `workspaces.create returned no deployment for ${repo.slug}`);
        return null;
      }
      deploymentID = deployment.deployment_id;
      createdDeployment = true;
    }

    let dataSourceID = existing.dataSourceID;
    if (dataSourceID) {
      // Deliberately no `syncDataSource` here: a failed sync deletes the data_source, which
      // would break any other Library it's attached to.
      logger.info("setup", `Reusing existing data source ${dataSourceID} for ${repo.slug}`);
    } else {
      const dataSource = await trpc.dataSource.create.mutate({
        org_id: orgID,
        provider_slug: "github",
        name: repo.slug,
        description: "",
        repository_id: repo.repository_id,
      });
      if (!dataSource?.data_source_id) {
        logger.warn("setup", `dataSource.create returned no data_source for ${repo.slug}`);
        if (createdDeployment) await deleteOrphanDeployment(trpc, deploymentID, repo.slug);
        return null;
      }
      dataSourceID = dataSource.data_source_id;
      await trpc.dataSource.syncDataSource.mutate({ data_source_id: dataSourceID });
    }

    await trpc.dataSource.attachToSpace.mutate({
      space_id: spaceID,
      data_source_ids: [dataSourceID],
    });
    const spaceDeploymentIds = parseDeploymentIds(
      await trpc.workspaces.listForSpace.query(spaceID),
    );
    const finalDataSourceID = dataSourceID;
    await Promise.all(
      spaceDeploymentIds.map(async (linkDeploymentID) => {
        try {
          await trpc.deploymentDataSource.create.mutate({
            deployment_id: linkDeploymentID,
            data_source_id: finalDataSourceID,
          });
        } catch (err: unknown) {
          // A link may already exist when reusing rows — non-fatal.
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            "setup",
            `Failed to link data source into deployment ${linkDeploymentID}: ${msg}`,
          );
        }
      }),
    );
    return {
      deployment_id: deploymentID,
      data_source_id: dataSourceID,
    };
  } catch (err: unknown) {
    /* v8 ignore next -- server errors bubble up */
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to wire up ${repo.slug}: ${msg}`);
    return null;
  }
}

interface SyncSurvivors {
  alive: Set<string>;
  dropped: Set<string>;
}

interface VerifyDataSourcesOptions {
  /** Poll budget. Tests inject 0 to short-circuit to a single check. */
  timeoutMs?: number;
  /** Sleep between polls. Tests inject 0 to avoid any awaiting. */
  intervalMs?: number;
}

/** Poll `dataSource.list` until each expected id shows up (alive) or stays missing through the
 * budget (dropped). Early absence is ambiguous, so success is the only early exit. */
export async function verifyDataSourcesPersist(
  trpc: TypedClient,
  orgID: string,
  expectedDataSourceIds: string[],
  opts: VerifyDataSourcesOptions = {},
): Promise<SyncSurvivors> {
  const expected = new Set(expectedDataSourceIds);
  if (expected.size === 0) {
    return { alive: new Set(), dropped: new Set() };
  }

  const timeoutMs = opts.timeoutMs ?? DATA_SOURCE_VERIFY_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DATA_SOURCE_VERIFY_POLL_INTERVAL_MS;

  const startedAt = Date.now();
  let alive = new Set<string>();
  let firstIteration = true;

  while (firstIteration || Date.now() - startedAt < timeoutMs) {
    firstIteration = false;
    // `data_source_id` is nullable in the contract (CliDataSource mirrors the DB
    // view, where all columns are nullable) — the Boolean filter below drops nulls.
    let listed: { data_source_id?: string | null }[] = [];
    try {
      listed = await trpc.dataSource.list.query({
        org_id: orgID,
        excluded_provider_slugs: [],
      });
    } catch (err: unknown) {
      /* v8 ignore next -- transient list failures are non-fatal; we'll retry */
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("setup", `dataSource.list during verify failed: ${msg}`);
    }

    const presentNow = new Set(
      listed.map((d) => d.data_source_id).filter((id): id is string => Boolean(id)),
    );
    alive = new Set([...expected].filter((id) => presentNow.has(id)));

    // Every expected id is visible — unambiguous success, stop polling.
    if (alive.size === expected.size) {
      return { alive, dropped: new Set() };
    }

    if (timeoutMs === 0) break;
    await sleep(intervalMs);
  }

  // Still missing after the full budget: the backend GC'd them (or they never
  // became visible, which is equally unusable) — report as dropped.
  const dropped = new Set([...expected].filter((id) => !alive.has(id)));
  return { alive, dropped };
}

async function deleteOrphanDeployment(
  trpc: TypedClient,
  deploymentID: string,
  slug: string,
): Promise<void> {
  try {
    await trpc.workspaces.delete.mutate(deploymentID);
  } catch (err: unknown) {
    /* v8 ignore next -- best-effort cleanup; user can delete manually if needed */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `Failed to revert orphan deployment for ${slug}: ${msg}`);
  }
}

export async function stepConnectGitHubRepo(
  cfg: Config,
  detected: DetectedRepo | null = detectGitRepo(),
  opts: StepConnectGitHubRepoOptions = {},
): Promise<GithubStepResult> {
  logger.info("setup", "Step: connect GitHub repo(s)");

  if (!cfg.active_account?.target?.org_id || !cfg.active_account?.target?.space_id) {
    p.log.warn(
      "Cannot connect GitHub: your Dosu workspace is missing org/space context. " +
        "Re-run `dosu setup` from a fresh state.",
    );
    return { advance: false, has_connected_repo: false };
  }
  const orgID = cfg.active_account?.target?.org_id;
  const spaceID = cfg.active_account?.target?.space_id;

  if (detected) {
    p.log.info(`Connecting GitHub repos (detected local repo: ${detected.slug})`);
  }

  const trpc = createTypedClient(cfg);
  let repos = await fetchListForOrg(trpc, orgID);
  // Space-scoped truth for the "Already connected" split; null means old backend, fall back to
  // org-scoped `is_deployed` (which counts orphan rows).
  const spaceSources = await fetchSpaceGithubSources(trpc, spaceID);

  while (true) {
    const available = repos.filter((r) => !isConnectedToSpace(r, spaceSources));
    const connected = repos.filter((r) => isConnectedToSpace(r, spaceSources));

    const selectableCount = available.filter((r) => r.is_fork !== true).length;
    // Already-connected repos render at the bottom as disabled "(Connected)" entries.
    const selected = await promptGitHubRepositories({
      message: `Select repositories to connect ${dim(`(${selectableCount} available)`)}`,
      options: buildPromptOptions(available, connected),
      initialValues: [],
      maxItems: REPO_MULTISELECT_MAX_ITEMS,
    });
    if (p.isCancel(selected)) {
      logger.info("setup", "Repository selection cancelled");
      return { advance: false, has_connected_repo: connected.length > 0 };
    }

    if (selected === ADD_REPOSITORIES_VALUE) {
      let refresh: { repos: AvailableRepo[]; foundNew: boolean } = { repos, foundNew: false };
      const installationID = await openGitHubInstallFlow(async () => {
        refresh = await waitForRepositoryRefresh(trpc, orgID, repos, opts.refresh);
      }, opts.install);
      if (installationID === null) {
        return { advance: false, has_connected_repo: connected.length > 0 };
      }
      repos = refresh.repos;
      if (!refresh.foundNew) {
        p.log.warn(
          "GitHub may still be syncing. Pick 'Refresh list' in a moment to re-check; sync usually completes within a minute.",
        );
      }
      continue;
    }

    if (selected === REFRESH_LIST_VALUE) {
      const s = p.spinner();
      s.start("Refreshing repository list...");
      const previousIds = new Set(repos.map((r) => r.repository_id));
      repos = await fetchListForOrg(trpc, orgID);
      const newCount = repos.filter((r) => !previousIds.has(r.repository_id)).length;
      s.stop(
        newCount > 0
          ? `Found ${newCount} new repo${newCount === 1 ? "" : "s"}`
          : "List refreshed, no new repos yet",
      );
      continue;
    }

    const slugs = selected as string[];
    if (slugs.length === 0) {
      p.log.info("No repositories selected.");
      return { advance: true, has_connected_repo: connected.length > 0 };
    }

    const s = p.spinner();
    s.start(`Connecting ${slugs.length} repo${slugs.length === 1 ? "" : "s"}...`);
    // Reuse leftover org rows (orphan deployment, existing data_source); both are unique per
    // repo backend-side, so creating duplicates is impossible anyway.
    const existingDeployments = await fetchOrgGithubDeployments(trpc, orgID);
    const existingDataSources = await fetchOrgGithubDataSources(trpc, orgID);
    const created: { deployment_id: string; data_source_id: string; slug: string }[] = [];
    for (const slug of slugs) {
      const repo = repos.find((r) => r.slug === slug);
      if (!repo) continue;
      const result = await createDeploymentForRepo(trpc, orgID, spaceID, repo, {
        deploymentID: existingDeployments.get(repo.repository_id),
        dataSourceID: existingDataSources.get(repo.repository_id),
      });
      if (result) {
        created.push({
          deployment_id: result.deployment_id,
          data_source_id: result.data_source_id,
          slug,
        });
      }
    }

    // The backend sync may already have deleted freshly created data_sources; verify before
    // declaring success and revert the orphan deployments.
    const expectedDsIds = created.map((c) => c.data_source_id);
    const survivors = await verifyDataSourcesPersist(trpc, orgID, expectedDsIds, opts.verify);

    const reverted: { slug: string; deployment_id: string }[] = [];
    if (survivors.dropped.size > 0) {
      const droppedEntries = created.filter((c) => survivors.dropped.has(c.data_source_id));
      for (const entry of droppedEntries) {
        await deleteOrphanDeployment(trpc, entry.deployment_id, entry.slug);
        reverted.push({ slug: entry.slug, deployment_id: entry.deployment_id });
      }
    }
    const survived = created.filter((c) => survivors.alive.has(c.data_source_id));

    // A failed attempt loops back to the multiselect so the user can retry or cancel.
    if (survived.length === 0) {
      s.stop("Failed");
      if (reverted.length > 0) {
        p.log.error(
          `Couldn't sync any repos; Dosu doesn't have GitHub access to: ${reverted
            .map((r) => r.slug)
            .join(", ")}.`,
        );
      } else {
        p.log.error("Could not connect any repos. Check `dosu logs --tail 50` for details.");
      }
      p.log.info("Pick repositories to try again, or press Ctrl+C to continue without connecting.");
      continue;
    }

    if (reverted.length > 0) {
      s.stop(
        `Connected ${survived.length} repo${survived.length === 1 ? "" : "s"} · ${reverted.length} skipped`,
      );
      p.log.warn(
        `Dosu couldn't sync ${reverted.length} repo${reverted.length === 1 ? "" : "s"} ` +
          `(GitHub App has no access): ${reverted.map((r) => r.slug).join(", ")}`,
      );
    } else {
      s.stop(`Connected ${survived.length} repo${survived.length === 1 ? "" : "s"}`);
    }
    for (const { slug, deployment_id } of survived) {
      p.log.success(`${slug} ${dim(`\u00B7 deployment ${deployment_id}`)}`);
    }

    // Prefer the cwd repo's deployment as the primary; fall back to the first
    // successfully created one.
    const primary = (detected && survived.find((c) => c.slug === detected.slug)) ?? survived[0];
    return {
      advance: true,
      has_connected_repo: true,
      deployment_id: primary.deployment_id,
      space_id: cfg.active_account?.target?.space_id,
      created_data_source_ids: survived.map((c) => c.data_source_id),
      created_repository_slugs: survived.map((c) => c.slug),
    };
  }
}
