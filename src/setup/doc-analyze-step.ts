/**
 * Setup step: auto-import docs from a connected repo and queue AI analysis.
 *
 * Called after `stepConnectGitHubPat` successfully creates a data source.
 * Unlike the interactive `stepImportGitHubDocs`, this step runs silently
 * during the FTUE — no file picker, imports all markdown automatically.
 *
 * Never throws — returns partial results on failure.
 */

import * as p from "@clack/prompts";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { logger } from "../debug/logger";
import type { GithubPatStepResult } from "./github-pat-step";

const DOC_SCAN_POLL_INTERVAL_MS = 2_000;
const DOC_SCAN_POLL_TIMEOUT_MS = 60_000;
const IMPORT_STATUS_POLL_INTERVAL_MS = 2_000;
const IMPORT_STATUS_MAX_ERRORS = 3;

const IMPORTABLE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".markdown"]);

interface ImportableFile {
  id: string;
  file_path: string;
  repository_slug: string | null;
  is_synced?: boolean;
  file_ext?: string;
}

type AsyncTaskState = "PROGRESS" | "SUCCESS" | "FAILURE";

interface ImportTaskStatusResponse {
  task_id: string;
  state: AsyncTaskState;
  detail: {
    total: number;
    completed: number;
    failed: number;
  } | null;
}

export interface DocAnalyzeStepResult {
  imported_count: number;
  failed_count: number;
  suggestions_queued: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDocFile(f: ImportableFile): boolean {
  if (f.file_ext) return IMPORTABLE_EXTENSIONS.has(f.file_ext.toLowerCase());
  const ext = f.file_path.slice(f.file_path.lastIndexOf(".")).toLowerCase();
  return IMPORTABLE_EXTENSIONS.has(ext);
}

type WaitForFilesOutcome =
  /** Data source finished indexing and we got the file list back. */
  | { kind: "indexed"; files: ImportableFile[] }
  /** Backend deleted the data source — repo unreachable. */
  | { kind: "data_source_missing" }
  /** Polling timed out before the data source reached is_indexed=true. */
  | { kind: "indexing_timeout"; files: ImportableFile[] };

async function waitForFiles(
  trpc: TypedClient,
  spaceID: string,
  dataSourceID: string,
  orgID: string,
): Promise<WaitForFilesOutcome> {
  const deadline = Date.now() + DOC_SCAN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Check if data source is indexed yet
      const sources = (await trpc.dataSource.list.query({
        org_id: orgID,
        excluded_provider_slugs: [],
      })) as { data_source_id?: string; is_indexed?: boolean }[];
      const ds = sources.find((s) => s.data_source_id === dataSourceID);
      if (ds?.is_indexed) {
        const files = (await trpc.docImports.listImportableGithubFiles.query(
          spaceID,
        )) as ImportableFile[];
        return { kind: "indexed", files };
      }
      if (!ds) {
        return { kind: "data_source_missing" };
      }
    } catch (err: unknown) {
      logger.warn(
        "setup",
        `waitForFiles poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await sleep(DOC_SCAN_POLL_INTERVAL_MS);
  }
  // Timed out before is_indexed=true — best-effort fetch in case files were
  // produced anyway, but mark the outcome so the caller can warn the user
  // about the underlying sync problem rather than mis-reporting "no docs".
  let files: ImportableFile[] = [];
  try {
    files = (await trpc.docImports.listImportableGithubFiles.query(spaceID)) as ImportableFile[];
  } catch {
    /* swallow — return empty */
  }
  return { kind: "indexing_timeout", files };
}

async function pollImportCompletion(
  trpc: TypedClient,
  taskID: string,
): Promise<{ imported: number; failed: number }> {
  let errors = 0;
  while (true) {
    try {
      const status = (await trpc.docImports.getImportStatus.query(
        taskID,
      )) as ImportTaskStatusResponse | null;

      if (!status) {
        errors += 1;
        if (errors >= IMPORT_STATUS_MAX_ERRORS) return { imported: 0, failed: 0 };
      } else {
        errors = 0;
        if (status.state !== "PROGRESS") {
          const detail = status.detail;
          return {
            imported: detail?.completed ?? 0,
            failed: detail?.failed ?? 0,
          };
        }
      }
    } catch (err: unknown) {
      errors += 1;
      logger.warn(
        "setup",
        `getImportStatus error: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (errors >= IMPORT_STATUS_MAX_ERRORS) return { imported: 0, failed: 0 };
    }
    await sleep(IMPORT_STATUS_POLL_INTERVAL_MS);
  }
}

export async function stepAnalyzeDocs(
  cfg: Config,
  patResult: GithubPatStepResult,
): Promise<DocAnalyzeStepResult> {
  const { data_source_id, space_id } = patResult;
  if (!data_source_id || !space_id || !cfg.org_id) {
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  logger.info("setup", `Step: analyze docs for data_source=${data_source_id}`);

  const trpc = createTypedClient(cfg);
  const s = p.spinner();
  s.start("Scanning repo for docs...");

  // Wait for the data source to be indexed (or give up)
  // biome-ignore lint/style/noNonNullAssertion: checked above
  const outcome = await waitForFiles(trpc, space_id, data_source_id, cfg.org_id!);
  const docFiles = outcome.kind === "data_source_missing" ? [] : outcome.files.filter(isDocFile);

  // Distinguish "indexing didn't complete" from "repo really has no docs" —
  // the previous behavior conflated them, which was misleading when the PAT
  // hadn't been stored and sync never ran.
  if (outcome.kind === "data_source_missing") {
    s.stop("Repo not reachable");
    p.log.warn(
      "Dosu could not reach the repo — the data source was removed. " +
        "Re-run `dosu setup` to retry the connection.",
    );
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  if (outcome.kind === "indexing_timeout" && docFiles.length === 0) {
    s.stop("Indexing didn't complete in time");
    p.log.warn(
      "The repo hasn't finished indexing yet — Dosu's GitHub sync may not have access " +
        "(common when the PAT wasn't stored). Run `dosu sources list` to check status, " +
        "then re-run `dosu setup` once sync is healthy.",
    );
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  if (docFiles.length === 0) {
    s.stop("No docs found");
    p.log.info(
      "No .md/.mdx/.txt/.rst files found in the repo to import. " +
        "Add some documentation and run `dosu setup` again, or import files manually with `dosu docs import github`.",
    );
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  s.message(`Found ${docFiles.length} doc${docFiles.length === 1 ? "" : "s"} — importing...`);

  // Get knowledge store ID
  let ksID: string;
  try {
    const store = await trpc.knowledgeStore.getBySpaceId.query({ space_id });
    if (!store) {
      s.stop("No knowledge store found");
      logger.warn("setup", "No knowledge store found for space");
      return { imported_count: 0, failed_count: 0, suggestions_queued: false };
    }
    ksID = store.id;
  } catch (err: unknown) {
    s.stop("Could not reach knowledge store");
    logger.error(
      "setup",
      `getBySpaceId failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  // Queue the import
  let taskID: string | undefined;
  try {
    const importResult = (await trpc.docImports.importGithubFiles.mutate({
      knowledge_store_id: ksID,
      space_id,
      file_ids: docFiles.map((f) => f.id),
    })) as { task_id?: string } | null;
    taskID = importResult?.task_id;
  } catch (err: unknown) {
    s.stop("Import failed to start");
    logger.error(
      "setup",
      `importGithubFiles failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { imported_count: 0, failed_count: 0, suggestions_queued: false };
  }

  // Poll for completion if we got a task ID
  let imported = 0;
  let failed = 0;
  if (taskID) {
    const result = await pollImportCompletion(trpc, taskID);
    imported = result.imported;
    failed = result.failed;
  } else {
    // Queued in background with no task ID — treat as success
    imported = docFiles.length;
  }

  // Fire-and-forget: queue AI suggestion generation
  let suggestionsQueued = false;
  try {
    await trpc.suggestedDoc.generate.mutate({
      knowledgeStoreId: ksID,
      dataSourceIds: [data_source_id],
    });
    suggestionsQueued = true;
    logger.info("setup", "Suggestion generation queued");
  } catch (err: unknown) {
    logger.warn(
      "setup",
      `suggestedDoc.generate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const summary = suggestionsQueued
    ? `Imported ${imported} doc${imported === 1 ? "" : "s"} · Queued AI analysis`
    : `Imported ${imported} doc${imported === 1 ? "" : "s"}`;
  s.stop(summary);

  if (suggestionsQueued) {
    p.log.info("Run `dosu suggest list` to see improvement opportunities once analysis completes.");
  }

  return { imported_count: imported, failed_count: failed, suggestions_queued: suggestionsQueued };
}
