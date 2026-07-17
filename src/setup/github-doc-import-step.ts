import * as p from "@clack/prompts";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import type { CliDataSource } from "../generated/dosu-api-types";
import {
  type GitHubImportFileOption,
  type GitHubImportRepositoryOption,
  promptGitHubDocsImport,
} from "./github-doc-import-prompt";

const DOC_SCAN_POLL_INTERVAL_MS = 2_000;
const DOC_SCAN_POLL_TIMEOUT_MS = 60_000;
const IMPORT_STATUS_POLL_INTERVAL_MS = 2_000;
const IMPORT_STATUS_MAX_ERRORS = 3;

// Contract-typed (dosu#11679): rows from `dataSource.list`.
type GitHubDataSource = CliDataSource;

interface ImportableGithubFile {
  id: string;
  file_path: string;
  repository_slug: string | null;
  is_synced?: boolean;
}

type AsyncTaskState = "PROGRESS" | "SUCCESS" | "FAILURE";
type ImportDocumentState = "PENDING" | "SUCCESS" | "FAILED";

interface ImportTaskDocument {
  id: string;
  title: string;
  status: ImportDocumentState;
  error?: string;
}

interface ImportTaskDetail {
  message: string;
  knowledge_store_id: string;
  provider: string;
  total: number;
  completed: number;
  failed: number;
  documents: ImportTaskDocument[];
}

interface ImportTaskStatusResponse {
  task_id: string;
  state: AsyncTaskState;
  detail: ImportTaskDetail | null;
  created_at: string;
  updated_at: string | null;
}

export interface GitHubDocsImportStepResult {
  advance: boolean;
  imported?: boolean;
  imported_count?: number;
  failed_count?: number;
  queued?: boolean;
  task_id?: string;
}

export interface GitHubDocsImportStepOptions {
  waitForFreshDocs?: boolean;
  /**
   * `data_source_id`s the caller just created in this run. When set, the
   * scan loop only waits on these ids — once each one is either indexed or
   * has been deleted by the backend, we exit. Without this, the loop
   * watches every GitHub data source in the org, so a stale
   * `is_indexed=false` row from a previous run can stall fresh setups
   * indefinitely.
   */
  expectedDataSourceIds?: string[];
}

export async function stepImportGitHubDocs(
  cfg: Config,
  opts: GitHubDocsImportStepOptions = {},
): Promise<GitHubDocsImportStepResult> {
  logger.info("setup", "Step: import GitHub docs");

  if (!cfg.active_account?.target?.org_id || !cfg.active_account?.target?.space_id) {
    p.log.warn(
      "Cannot import GitHub docs: your Dosu workspace is missing org/space context. " +
        "Re-run `dosu setup` from a fresh state.",
    );
    return { advance: false };
  }

  const trpc = createTypedClient(cfg);
  const files = opts.waitForFreshDocs
    ? await waitForImportableGithubFiles(
        trpc,
        cfg.active_account?.target?.org_id,
        cfg.active_account?.target?.space_id,
        opts.expectedDataSourceIds,
      )
    : await fetchImportableGithubFiles(trpc, cfg.active_account?.target?.space_id);
  if (files === null) {
    return { advance: false };
  }

  if (files.length === 0) {
    p.log.info("No markdown docs available to import right now. You can import them later.");
    return { advance: true, imported: false, imported_count: 0 };
  }

  const repositories = buildRepositories(files);
  const selected = await promptGitHubDocsImport({ repositories });
  if (p.isCancel(selected)) {
    logger.info("setup", "GitHub doc import selection cancelled");
    return { advance: false };
  }

  const fileIDs = selected as string[];
  if (fileIDs.length === 0) {
    p.log.info("Skipped importing docs for now. You can import them later.");
    return { advance: true, imported: false, imported_count: 0 };
  }

  const knowledgeStoreID = await getKnowledgeStoreID(trpc, cfg.active_account?.target?.space_id);
  if (!knowledgeStoreID) {
    return { advance: false };
  }

  const spinner = p.spinner();
  spinner.start(`Queueing import for ${fileIDs.length} doc${fileIDs.length === 1 ? "" : "s"}...`);
  try {
    const result = (await trpc.docImports.importGithubFiles.mutate({
      knowledge_store_id: knowledgeStoreID,
      space_id: cfg.active_account?.target?.space_id,
      file_ids: fileIDs,
    })) as { task_id?: string } | null;

    const taskID = result?.task_id;
    if (!taskID) {
      spinner.stop("Import task started");
      p.log.success("Import task started.");
      p.log.info("Your docs should finish importing in a few minutes.");
      return { advance: true, imported: false, imported_count: 0, queued: true };
    }

    spinner.stop("Import task started");
    logger.info("setup", `Watching import task ${taskID}`);
    p.log.info("This can take a few minutes. We'll keep watching until it finishes.");

    const progressSpinner = p.spinner();
    progressSpinner.start(`Preparing document import... 0/${fileIDs.length} complete`);
    const finalStatus = await waitForImportTaskCompletion(
      trpc,
      taskID,
      progressSpinner,
      fileIDs.length,
    );
    if (!finalStatus) {
      progressSpinner.stop("Stopped watching import progress");
      p.log.info(
        `The import is still running in the background.\nCheck status later with: dosu docs import-status ${taskID}`,
      );
      return {
        advance: true,
        imported: false,
        imported_count: 0,
        queued: true,
        task_id: taskID,
      };
    }

    handleImportCompletion(finalStatus, progressSpinner);
    const importedCount = finalStatus.detail?.completed ?? 0;
    return {
      advance: true,
      imported: importedCount > 0,
      imported_count: importedCount,
      failed_count: finalStatus.detail?.failed ?? 0,
      task_id: taskID,
    };
  } catch (err: unknown) {
    spinner.stop("Failed");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `Failed to import GitHub docs: ${msg}`);
    p.log.error("Could not start the GitHub doc import.");
    return { advance: false };
  }
}

async function waitForImportTaskCompletion(
  trpc: TypedClient,
  taskID: string,
  spinner: ReturnType<typeof p.spinner>,
  expectedTotal: number,
): Promise<ImportTaskStatusResponse | null> {
  let consecutiveErrors = 0;

  while (true) {
    try {
      const status = (await trpc.docImports.getImportStatus.query(
        taskID,
      )) as ImportTaskStatusResponse | null;

      if (!status) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= IMPORT_STATUS_MAX_ERRORS) {
          return null;
        }
      } else {
        consecutiveErrors = 0;
        spinner.message(buildImportProgressMessage(status, expectedTotal));
        if (status.state !== "PROGRESS") {
          return status;
        }
      }
    } catch (err: unknown) {
      consecutiveErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("setup", `getImportStatus failed for ${taskID}: ${msg}`);
      if (consecutiveErrors >= IMPORT_STATUS_MAX_ERRORS) {
        return null;
      }
    }

    await sleep(IMPORT_STATUS_POLL_INTERVAL_MS);
  }
}

function buildImportProgressMessage(
  status: ImportTaskStatusResponse,
  expectedTotal: number,
): string {
  const detail = status.detail;
  if (!detail) {
    return `Importing documents... 0/${expectedTotal} complete`;
  }

  const processed = detail.completed + detail.failed;
  // Server returns total=0 until it finishes enumerating files (STARTING state).
  // Fall back to the client-known count so the UI never shows "0/0".
  const total = detail.total > 0 ? detail.total : expectedTotal;

  if (status.state === "SUCCESS") {
    return `Import complete (${processed}/${total})`;
  }

  if (status.state === "FAILURE") {
    return `Import finished with issues (${processed}/${total}, ${detail.failed} failed)`;
  }

  const prefix =
    detail.message === "STARTING" ? "Preparing document import" : "Importing documents";
  const failureSuffix = detail.failed > 0 ? `, ${detail.failed} failed` : "";
  return `${prefix}... ${processed}/${total} complete${failureSuffix}`;
}

function handleImportCompletion(
  status: ImportTaskStatusResponse,
  spinner: ReturnType<typeof p.spinner>,
): void {
  const detail = status.detail;
  const processed = detail ? detail.completed + detail.failed : 0;
  const total = detail?.total ?? processed;
  const failed = detail?.failed ?? 0;

  if (status.state === "SUCCESS") {
    spinner.stop("Import complete");
    p.log.success(
      `Imported ${total} doc${total === 1 ? "" : "s"}.\nYour GitHub docs are ready, and onboarding is complete.`,
    );
    return;
  }

  spinner.stop("Import completed with issues");
  p.log.warn(
    `Imported ${processed - failed} of ${total} doc${total === 1 ? "" : "s"}; ${failed} failed.\nYou can review the failed docs later, but onboarding is complete.`,
  );
}

async function waitForImportableGithubFiles(
  trpc: TypedClient,
  orgID: string,
  spaceID: string,
  expectedDataSourceIds?: string[],
): Promise<ImportableGithubFile[] | null> {
  while (true) {
    const spinner = p.spinner();
    spinner.start("Scanning repositories for markdown documents...");
    p.log.info("This usually takes a few seconds.");

    const startedAt = Date.now();
    let latestFiles: ImportableGithubFile[] = [];
    const waitsForExpectedDataSources =
      expectedDataSourceIds !== undefined && expectedDataSourceIds.length > 0;

    while (Date.now() - startedAt < DOC_SCAN_POLL_TIMEOUT_MS) {
      // Distinguish "still indexing" from "indexed but empty". When the
      // caller passed the data_source ids it just created we only wait on
      // those — they're either indexed-or-missing very quickly. Otherwise
      // fall back to watching every GitHub data source in the org (legacy
      // path used by non-onboarding callers).
      const dataSources = await fetchGitHubDataSources(trpc, orgID);
      if (waitsForExpectedDataSources) {
        if (isScanComplete(dataSources, expectedDataSourceIds)) {
          latestFiles = await fetchImportableGithubFiles(trpc, spaceID);
          spinner.stop(latestFiles.length > 0 ? "Docs ready" : "No markdown docs found");
          return latestFiles;
        }
        await sleep(DOC_SCAN_POLL_INTERVAL_MS);
        continue;
      }

      latestFiles = await fetchImportableGithubFiles(trpc, spaceID);
      if (latestFiles.length > 0) {
        spinner.stop("Docs ready");
        return latestFiles;
      }

      if (isScanComplete(dataSources, expectedDataSourceIds)) {
        spinner.stop("No markdown docs found");
        return [];
      }
      await sleep(DOC_SCAN_POLL_INTERVAL_MS);
    }

    spinner.stop("Timed out");
    const choice = await p.select({
      message: "Still waiting for GitHub docs to become available",
      options: [
        { value: "retry", label: "Retry" },
        { value: "skip", label: "Skip for now" },
      ],
    });

    if (p.isCancel(choice)) {
      return null;
    }
    if (choice === "skip") {
      p.log.info("Skipped importing docs for now. You can import them later.");
      return [];
    }
  }
}

/**
 * Decide whether the GitHub doc scan has settled and the user can move on.
 *
 * - With `expectedDataSourceIds`: every id is either indexed in the current
 *   list or absent (the backend deleted it because Dosu can't reach the
 *   repo). A still-pending QUEUED row elsewhere in the org doesn't matter.
 * - Without it: keep the legacy "all GitHub data sources indexed" check so
 *   non-onboarding callers don't change behaviour.
 */
function isScanComplete(
  dataSources: GitHubDataSource[],
  expectedDataSourceIds?: string[],
): boolean {
  if (expectedDataSourceIds && expectedDataSourceIds.length > 0) {
    const byId = new Map<string, GitHubDataSource>();
    for (const ds of dataSources) {
      if (ds.data_source_id) byId.set(ds.data_source_id, ds);
    }
    for (const id of expectedDataSourceIds) {
      const ds = byId.get(id);
      if (!ds) continue; // backend deleted it — treat as resolved
      if (ds.is_indexed !== true) return false;
    }
    return true;
  }
  return dataSources.length > 0 && dataSources.every((ds) => ds.is_indexed === true);
}

async function fetchGitHubDataSources(
  trpc: TypedClient,
  orgID: string,
): Promise<GitHubDataSource[]> {
  try {
    const dataSources = await trpc.dataSource.list.query({
      org_id: orgID,
      excluded_provider_slugs: [],
    });
    return dataSources.filter((dataSource) => dataSource.provider_slug === "github");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `dataSource.list failed while waiting for docs: ${msg}`);
    return [];
  }
}

async function fetchImportableGithubFiles(
  trpc: TypedClient,
  spaceID: string,
): Promise<ImportableGithubFile[]> {
  try {
    return (await trpc.docImports.listImportableGithubFiles.query(
      spaceID,
    )) as ImportableGithubFile[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("setup", `listImportableGithubFiles failed: ${msg}`);
    return [];
  }
}

function buildRepositories(files: ImportableGithubFile[]): GitHubImportRepositoryOption[] {
  const repositories = new Map<string, GitHubImportRepositoryOption>();

  for (const file of files) {
    const slug = file.repository_slug ?? "unknown";
    if (!repositories.has(slug)) {
      repositories.set(slug, { slug, files: [] });
    }
    repositories.get(slug)?.files.push({
      id: file.id,
      path: file.file_path,
      is_synced: file.is_synced,
    } satisfies GitHubImportFileOption);
  }

  return Array.from(repositories.values())
    .map((repository) => ({
      ...repository,
      files: [...repository.files].sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

async function getKnowledgeStoreID(trpc: TypedClient, spaceID: string): Promise<string | null> {
  try {
    // Contract-typed (dosu#11679) — no cast needed.
    const store = await trpc.knowledgeStore.getBySpaceId.query({
      space_id: spaceID,
    });
    if (!store?.id) {
      p.log.error("No knowledge store found for this deployment.");
      return null;
    }
    return store.id;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("setup", `knowledgeStore.getBySpaceId failed: ${msg}`);
    p.log.error("Could not load the knowledge store for this deployment.");
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
