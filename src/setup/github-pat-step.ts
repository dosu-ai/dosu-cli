/**
 * Setup step: connect a GitHub repo via Personal Access Token (PAT).
 *
 * Alternative to the GitHub App OAuth flow — no browser redirect, no App
 * installation. The user pastes a read-only PAT; we call the GitHub API to
 * fetch repo metadata, create a Dosu data source, encrypt and store the PAT
 * on the backend, then trigger a sync.
 *
 * Never throws — returns `{ advance: false }` on any unrecoverable failure
 * so the caller can continue without crashing setup.
 */

import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import type { Client } from "../client/client";
import { createTypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import { DEFAULT_DEPLOYMENT_CONFIG_GITHUB } from "./default-deployment-config";
import { dim, info } from "./styles";

const DATA_SOURCE_VERIFY_POLL_INTERVAL_MS = 1_000;
const DATA_SOURCE_VERIFY_POLL_TIMEOUT_MS = 10_000;

// PAT storage triggers KMS encrypt + DB upsert + sync enqueue on the backend,
// which routinely exceeds the default 10s client timeout. Give it 60s.
const STORE_PAT_TIMEOUT_MS = 60_000;
// Retries cover the read-after-write race where data_source.create has
// returned but `user_can_modify_data_source` hasn't seen the row yet.
const STORE_PAT_MAX_ATTEMPTS = 3;
const STORE_PAT_BASE_BACKOFF_MS = 500;

export interface DetectedRepo {
  owner: string;
  name: string;
  slug: string;
}

export interface GithubPatStepResult {
  advance: boolean;
  data_source_id?: string;
  space_id?: string;
  deployment_id?: string;
  repo_slug?: string;
  /**
   * True when a PAT was successfully stored (or wasn't needed — e.g. the
   * GitHub App path). False if the user reached the PAT step but storage
   * failed, signalling downstream steps (doc analyze, sync wait) to skip
   * polling since the repo isn't reachable.
   */
  pat_stored?: boolean;
}

interface GitHubRepoMeta {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  private: boolean;
  stargazers_count?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC types are untyped at this level
type AnyClient = any;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchGitHubRepoMeta(
  owner: string,
  name: string,
  pat: string,
): Promise<GitHubRepoMeta | null> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) {
      logger.warn("setup", `GitHub API returned ${resp.status} for ${owner}/${name}`);
      return null;
    }
    return (await resp.json()) as GitHubRepoMeta;
  } catch (err: unknown) {
    logger.error(
      "setup",
      `GitHub API fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function ensureGithubRepoRow(
  apiClient: Client,
  repoMeta: GitHubRepoMeta,
  slug: string,
): Promise<boolean> {
  try {
    const resp = await apiClient.doRequest("POST", "/v1/github/repositories", {
      repository_id: repoMeta.id,
      slug,
      name: repoMeta.name,
      description: repoMeta.description ?? "",
      is_private: repoMeta.private,
      stargazer_count: repoMeta.stargazers_count ?? null,
    });
    if (!resp.ok) {
      let body = "";
      try {
        body = await resp.text();
      } catch {
        /* ignore */
      }
      logger.error("setup", `POST /v1/github/repositories → ${resp.status}: ${body}`);
      return false;
    }
    return true;
  } catch (err: unknown) {
    logger.error(
      "setup",
      `Failed to register github repo row: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

async function createDataSourceForRepo(
  trpc: AnyClient,
  apiClient: Client,
  orgID: string,
  spaceID: string,
  repoMeta: GitHubRepoMeta,
  slug: string,
): Promise<{ deployment_id: string; data_source_id: string } | null> {
  try {
    // Ensure github.repository row exists before FK-constrained workspace/data_source inserts.
    const registered = await ensureGithubRepoRow(apiClient, repoMeta, slug);
    if (!registered) {
      logger.warn("setup", `Failed to register github.repository row for ${slug}`);
      return null;
    }

    const deployment = await trpc.workspaces.create.mutate({
      org_id: orgID,
      space_id: spaceID,
      enabled: true,
      name: slug,
      description: repoMeta.description ?? "",
      provider_slug: "github",
      repository_id: repoMeta.id,
      metadata: {
        app: { deployment_mode: "normal", setup_mode: "auto" },
        provider_slug: "github",
      },
      config: DEFAULT_DEPLOYMENT_CONFIG_GITHUB,
    });
    if (!deployment?.deployment_id) {
      logger.warn("setup", `workspaces.create returned no deployment for ${slug}`);
      return null;
    }

    const dataSource = await trpc.dataSource.create.mutate({
      org_id: orgID,
      provider_slug: "github",
      name: slug,
      description: repoMeta.description ?? "",
      repository_id: repoMeta.id,
    });
    if (!dataSource?.data_source_id) {
      logger.warn("setup", `dataSource.create returned no data_source for ${slug}`);
      // Roll back orphaned deployment
      try {
        await trpc.workspaces.delete.mutate(deployment.deployment_id);
      } catch {
        /* best-effort */
      }
      return null;
    }
    const dataSourceID = dataSource.data_source_id;

    await trpc.dataSource.syncDataSource.mutate(dataSourceID);

    const spaceDeployments = await trpc.workspaces.listForSpace.query(spaceID);
    await Promise.all(
      spaceDeployments.map((d: { deployment_id: string }) =>
        trpc.deploymentDataSource.create.mutate({
          deployment_id: d.deployment_id,
          data_source_id: dataSourceID,
        }),
      ),
    );

    return { deployment_id: deployment.deployment_id, data_source_id: dataSourceID };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to create data source for ${slug}: ${msg}`);
    return null;
  }
}

interface ExistingGithubDataSource {
  data_source_id: string;
  deployment_id: string;
}

/**
 * Find a GitHub data source already linked to this repo, if any. Used to
 * resume a partial `dosu setup` run that created the data source but failed
 * before storing the PAT — we re-prompt the PAT against the existing row
 * instead of duplicating workspaces.
 *
 * Returns null if none exists or on any error (caller falls through to
 * create-new path).
 */
export async function findExistingGithubDataSource(
  trpc: AnyClient,
  orgID: string,
  spaceID: string,
  repositoryID: number,
): Promise<ExistingGithubDataSource | null> {
  try {
    const sources = (await trpc.dataSource.list.query({
      org_id: orgID,
      excluded_provider_slugs: [],
    })) as Array<{
      data_source_id?: string;
      provider_slug?: string;
      repository_id?: number | string;
    }>;
    const matching = sources.find(
      (s) =>
        s.provider_slug === "github" &&
        s.data_source_id !== undefined &&
        Number(s.repository_id) === repositoryID,
    );
    if (!matching?.data_source_id) return null;

    const spaceDeployments = (await trpc.workspaces.listForSpace.query(spaceID)) as Array<{
      deployment_id: string;
    }>;
    const deployment = spaceDeployments[0];
    if (!deployment?.deployment_id) return null;

    return {
      data_source_id: matching.data_source_id,
      deployment_id: deployment.deployment_id,
    };
  } catch (err: unknown) {
    logger.warn(
      "setup",
      `findExistingGithubDataSource failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function waitForDataSourceAlive(
  trpc: AnyClient,
  orgID: string,
  dataSourceID: string,
): Promise<boolean> {
  const deadline = Date.now() + DATA_SOURCE_VERIFY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const sources = await trpc.dataSource.list.query({
        org_id: orgID,
        excluded_provider_slugs: [],
      });
      const found = (sources as { data_source_id?: string }[]).some(
        (s) => s.data_source_id === dataSourceID,
      );
      if (found) return true;
      // Backend deleted it (repo unreachable)
      return false;
    } catch {
      /* swallow — retry */
    }
    await sleep(DATA_SOURCE_VERIFY_POLL_INTERVAL_MS);
  }
  return true; // assume alive if we can't confirm either way
}

export interface StorePatResult {
  ok: boolean;
  /** HTTP status from the last attempt, or null if the request never returned. */
  status: number | null;
  /** Reason categorization for the caller's error message. */
  reason:
    | "ok"
    | "timeout"
    | "permission"
    | "not_found"
    | "validation"
    | "unavailable"
    | "server"
    | "network";
  /** Truncated response body for diagnostics. */
  body?: string;
  /** Extracted `detail` field from a JSON error body, when present. */
  detail?: string;
}

/**
 * Pull the `detail` field out of a FastAPI-style JSON error body. FastAPI
 * always shapes errors as `{"detail": "..."}` (or `{"detail": [...]}` for
 * validation), so this is the right field to surface to users.
 */
function extractDetail(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON — fall through */
  }
  return undefined;
}

export interface StorePatOptions {
  /** Override base backoff between retries. Tests pass 0. */
  baseBackoffMs?: number;
  /** Override total attempt budget. Tests pass 1 to disable retry. */
  maxAttempts?: number;
  /** Override per-request timeout. Tests pass small values. */
  timeoutMs?: number;
}

/**
 * POSTs the PAT to the backend, with bounded retries on 403/404 to absorb the
 * read-after-write race when `data_source.create` has just returned but the
 * row isn't yet visible to `user_can_modify_data_source`.
 *
 * Distinguishes timeout vs permission vs validation vs server failures so the
 * caller can surface a specific recovery message instead of "could not store".
 */
export async function storePat(
  apiClient: Client,
  dataSourceID: string,
  pat: string,
  opts: StorePatOptions = {},
): Promise<StorePatResult> {
  const maxAttempts = opts.maxAttempts ?? STORE_PAT_MAX_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? STORE_PAT_BASE_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? STORE_PAT_TIMEOUT_MS;

  let lastStatus: number | null = null;
  let lastBody: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await apiClient.doRequest(
        "POST",
        `/data-sources/${dataSourceID}/github-pat`,
        { pat },
        { timeoutMs },
      );
      lastStatus = resp.status;
      if (resp.ok) {
        return { ok: true, status: resp.status, reason: "ok" };
      }

      lastBody = await readBodyForLog(resp);
      logger.error(
        "setup",
        `storePat attempt ${attempt} → ${resp.status}: ${lastBody ?? "<no body>"}`,
      );

      if ((resp.status === 403 || resp.status === 404) && attempt < maxAttempts) {
        await sleep(baseBackoffMs * 2 ** (attempt - 1));
        continue;
      }

      const reason: StorePatResult["reason"] =
        resp.status === 403
          ? "permission"
          : resp.status === 404
            ? "not_found"
            : resp.status === 422
              ? "validation"
              : resp.status === 503
                ? "unavailable"
                : "server";
      return {
        ok: false,
        status: resp.status,
        reason,
        body: lastBody,
        detail: extractDetail(lastBody),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = err instanceof Error && err.name === "AbortError";
      logger.error("setup", `storePat attempt ${attempt} threw: ${msg}`);
      if (attempt === maxAttempts) {
        return {
          ok: false,
          status: lastStatus,
          reason: aborted ? "timeout" : "network",
          body: msg,
        };
      }
      await sleep(baseBackoffMs * 2 ** (attempt - 1));
    }
  }

  return { ok: false, status: lastStatus, reason: "server", body: lastBody };
}

async function readBodyForLog(resp: Response): Promise<string | undefined> {
  try {
    const text = await resp.text();
    return text.slice(0, 512);
  } catch {
    return undefined;
  }
}

/**
 * Map a structured PAT-storage failure to a user-facing recovery message.
 * Every branch ends with the exact next command the user should run. When
 * the backend supplies a `detail` (FastAPI's standard error field), prefer
 * it — it usually contains the specific cause (e.g. expired KMS credentials).
 */
export function patStorageFailureMessage(result: StorePatResult): string {
  const rerun = "Re-run `dosu setup` to retry. Use `dosu logs --tail 30` to inspect the failure.";
  switch (result.reason) {
    case "timeout":
      return `Repo connected, but storing the PAT timed out (>60s). ${rerun}`;
    case "permission":
      return `Repo connected, but the backend rejected the PAT (status 403 after retries). ${rerun}`;
    case "not_found":
      return `Repo connected, but the data source was not visible to the backend (status 404 after retries). ${rerun}`;
    case "validation":
      return `Repo connected, but the PAT was rejected as invalid (status 422). Generate a new PAT with the \`repo\` scope and re-run \`dosu setup\`.`;
    case "unavailable":
      // 503 — backend reported the dependency (typically KMS) is down. The
      // detail is actionable so we surface it verbatim.
      return result.detail
        ? `Repo connected, but the backend can't store the PAT right now: ${result.detail}`
        : `Repo connected, but the backend is temporarily unavailable (status 503). ${rerun}`;
    case "network":
      return `Repo connected, but the PAT could not be stored due to a network error. ${rerun}`;
    default:
      if (result.detail) {
        return `Repo connected, but storing the PAT failed: ${result.detail}`;
      }
      return `Repo connected, but storing the PAT failed${
        result.status ? ` (status ${result.status})` : ""
      }. ${rerun}`;
  }
}

export async function stepConnectGitHubPat(
  apiClient: Client,
  cfg: Config,
): Promise<GithubPatStepResult> {
  logger.info("setup", "Step: connect GitHub via PAT");

  if (!cfg.org_id || !cfg.space_id) {
    logger.warn("setup", "Missing org_id or space_id — skipping PAT step");
    return { advance: true }; // non-fatal skip
  }

  const detected = detectGitRepo();
  if (!detected) {
    p.log.info(
      dim(
        "Not in a GitHub repo — skipping codebase connection. Run `dosu setup` from a git repo to connect your codebase.",
      ),
    );
    return { advance: true };
  }

  // Explicit choice: PAT or GitHub App
  const method = await p.select({
    message: `Connect ${info(detected.slug)} to Dosu`,
    options: [
      {
        value: "pat",
        label: "GitHub PAT",
        hint: "read-only token, no app install required",
      },
      {
        value: "app",
        label: "GitHub App",
        hint: "installs Dosu app on your org",
      },
      {
        value: "skip",
        label: "Skip for now",
      },
    ],
  });

  if (p.isCancel(method) || method === "skip") {
    logger.info(
      "setup",
      `Repo connection skipped (${p.isCancel(method) ? "cancelled" : "user choice"})`,
    );
    return { advance: true };
  }

  if (method === "app") {
    // Hand off to the existing GitHub App flow. The App flow doesn't require
    // PAT storage, so downstream doc-analyze can run unconditionally.
    const { stepConnectGitHubRepo } = await import("./github-step");
    const result = await stepConnectGitHubRepo(cfg);
    return {
      advance: result.advance,
      data_source_id: result.created_data_source_ids?.[0],
      space_id: result.space_id,
      deployment_id: result.deployment_id,
      repo_slug: result.created_repository_slugs?.[0],
      pat_stored: result.advance,
    };
  }

  // PAT path
  const tokenURL = `https://github.com/settings/tokens/new?scopes=repo&description=Dosu+CLI`;
  p.log.info(dim(`Generate a read-only token: ${tokenURL}`));
  const pat = await p.password({
    message: `GitHub PAT for ${info(detected.slug)}`,
    validate: (v) => (v.trim().length === 0 ? "PAT cannot be empty" : undefined),
  });

  if (p.isCancel(pat)) {
    return { advance: true };
  }

  const s = p.spinner();
  s.start(`Connecting ${detected.slug}...`);

  // Validate PAT + fetch repo metadata from GitHub API
  const repoMeta = await fetchGitHubRepoMeta(detected.owner, detected.name, pat);
  if (!repoMeta) {
    s.stop("Failed to reach GitHub");
    p.log.warn(
      `Could not access ${detected.slug} with that PAT. ` +
        "Check the token has at least read-only repo scope and try again.",
    );
    return { advance: true };
  }

  // Resume an earlier partial run before creating a duplicate. If a GitHub
  // data source for this repo already exists in the org, we just store the
  // PAT against it — skipping the workspace/data-source create dance.
  //
  // Non-null assertions on org_id / space_id are safe — both are guarded at
  // the top of this function (search "Missing org_id or space_id").
  const trpc = createTypedClient(cfg);
  // biome-ignore lint/style/noNonNullAssertion: guarded above
  const orgID = cfg.org_id!;
  // biome-ignore lint/style/noNonNullAssertion: guarded above
  const spaceID = cfg.space_id!;
  const existing = await findExistingGithubDataSource(trpc, orgID, spaceID, repoMeta.id);

  let created: { deployment_id: string; data_source_id: string };
  if (existing) {
    logger.info("setup", `Resuming PAT step for existing data source ${existing.data_source_id}`);
    created = existing;
  } else {
    const fresh = await createDataSourceForRepo(
      trpc,
      apiClient,
      orgID,
      spaceID,
      repoMeta,
      detected.slug,
    );
    if (!fresh) {
      s.stop("Failed to connect repo");
      p.log.error(
        `Could not create a Dosu data source for ${detected.slug}. Inspect the failure with \`dosu logs --tail 30\` and re-run \`dosu setup\`.`,
      );
      return { advance: true };
    }
    created = fresh;

    // Verify the data source wasn't deleted by the backend (repo unreachable via GitHub App)
    const alive = await waitForDataSourceAlive(trpc, orgID, created.data_source_id);
    if (!alive) {
      s.stop("Repo not reachable");
      p.log.warn(
        `${detected.slug} was connected but the sync failed — the repo may not be accessible to Dosu. ` +
          "Store the PAT to enable direct access.",
      );
      // Still store the PAT — it will be used for the next sync attempt
    }
  }

  // Encrypt and store the PAT on the backend
  const stored = await storePat(apiClient, created.data_source_id, pat);
  if (!stored.ok) {
    s.stop(`Connected ${detected.slug}`);
    p.log.warn(patStorageFailureMessage(stored));
  } else {
    s.stop(`Connected ${detected.slug}`);
    p.log.success(`Repository\n${dim(detected.slug)}`);
  }

  logger.info("setup", `GitHub PAT step complete: data_source=${created.data_source_id}`);
  return {
    advance: true,
    data_source_id: created.data_source_id,
    space_id: cfg.space_id,
    deployment_id: created.deployment_id,
    repo_slug: detected.slug,
    pat_stored: stored.ok,
  };
}
