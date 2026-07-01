/**
 * Non-blocking PR-ready notifier for `dosu audit`.
 *
 * Uses the same "check now, display next run" pattern as `update-check.ts`:
 * 1. On startup, reads cached pending tasks from disk.
 * 2. For any task that already has a `prUrl` (or `error`) and hasn't been shown
 *    yet, prints a notice to stderr and latches it (`displayedAt`). Finished +
 *    displayed tasks are pruned from the cache.
 * 3. For tasks still in flight whose `lastCheck` is stale (>60 s), fires a
 *    background `GET /v1/cli/task/run/{task_id}` (not awaited) and records the
 *    result so the next CLI run can surface it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir, loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";

const CACHE_FILENAME = "pending-tasks.json";
const CHECK_INTERVAL_MS = 60_000; // 60s between polls per task
const FETCH_TIMEOUT_MS = 5_000;

export interface PendingTask {
  task_id: string;
  doc_types: string[];
  repo: string;
  lastCheck: number;
  prUrl?: string;
  error?: string;
  displayedAt?: number;
}

interface PendingTasksCache {
  tasks: PendingTask[];
}

type TaskRunState = "PROGRESS" | "SUCCESS" | "FAILURE";

interface TaskRunResponse {
  state: TaskRunState;
  detail?: Record<string, unknown>;
  pr_url?: string;
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILENAME);
}

export function readPendingTasks(): PendingTasksCache {
  try {
    const path = getCachePath();
    if (!existsSync(path)) return { tasks: [] };
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(data?.tasks)) {
      return { tasks: data.tasks as PendingTask[] };
    }
    return { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

export function writePendingTasks(cache: PendingTasksCache): void {
  try {
    const dir = getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(getCachePath(), JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Graceful degradation — cache write failure is non-fatal
  }
}

/** Append a pending task to the cache. Used by `dosu audit` after firing tasks. */
export function addPendingTask(task: { task_id: string; doc_types: string[]; repo: string }): void {
  const cache = readPendingTasks();
  cache.tasks.push({
    task_id: task.task_id,
    doc_types: task.doc_types,
    repo: task.repo,
    // 0 → immediately stale so the next CLI run polls it.
    lastCheck: 0,
  });
  writePendingTasks(cache);
}

/** Fetch a task's run status from the backend. Never throws. */
export async function fetchTaskRun(
  backendURL: string,
  apiKey: string,
  taskId: string,
): Promise<TaskRunResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${backendURL}/v1/cli/task/run/${taskId}`, {
      headers: { "X-Dosu-API-Key": apiKey },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as TaskRunResponse;
    if (typeof data?.state !== "string") return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function displayTask(task: PendingTask): void {
  // Only ever called for a finished task (prUrl set, else an error).
  if (task.prUrl) {
    console.error(`\n${pc.green(`✓ Dosu PR ready (${task.repo}): ${task.prUrl}`)}\n`);
  } else {
    console.error(`\n${pc.yellow(`✗ Dosu doc generation failed (${task.repo}): ${task.error}`)}\n`);
  }
}

/**
 * Surface ready PRs and poll in-flight tasks — called synchronously from the
 * preAction hook.
 */
export function checkForReadyTasks(): void {
  try {
    const cache = readPendingTasks();
    if (cache.tasks.length === 0) return;

    let mutated = false;

    // 1. Display any finished-but-undisplayed tasks, then prune them.
    for (const task of cache.tasks) {
      if ((task.prUrl || task.error) && !task.displayedAt) {
        displayTask(task);
        task.displayedAt = Date.now();
        mutated = true;
      }
    }
    const remaining = cache.tasks.filter((t) => !((t.prUrl || t.error) && t.displayedAt));
    if (remaining.length !== cache.tasks.length) {
      cache.tasks = remaining;
      mutated = true;
    }

    // 2. Fire background polls for stale, in-flight tasks.
    const cfg = loadConfig();
    const backendURL = getBackendURL();
    const apiKey = cfg.api_key;
    if (backendURL && apiKey) {
      const now = Date.now();
      // Only in-flight tasks remain here — finished ones were displayed and
      // pruned above — so we just skip those polled too recently.
      for (const task of cache.tasks) {
        if (now - task.lastCheck < CHECK_INTERVAL_MS) continue;
        pollTask(backendURL, apiKey, task.task_id);
      }
    }

    if (mutated) {
      writePendingTasks(cache);
    }
  } catch (err) {
    logger.error("pending-tasks", `Pending-tasks check failed: ${err}`);
  }
}

/**
 * Fire-and-forget poll. Re-reads + re-writes the cache inside the `.then` so a
 * concurrent write from `checkForReadyTasks` (step 1 pruning) isn't clobbered.
 */
function pollTask(backendURL: string, apiKey: string, taskId: string): void {
  fetchTaskRun(backendURL, apiKey, taskId)
    .then((result) => {
      const cache = readPendingTasks();
      const task = cache.tasks.find((t) => t.task_id === taskId);
      if (!task) return;
      task.lastCheck = Date.now();
      if (result?.state === "SUCCESS") {
        task.prUrl = result.pr_url ?? "(no URL returned)";
      } else if (result?.state === "FAILURE") {
        const detail = result.detail;
        const message =
          detail && typeof detail.message === "string" ? detail.message : "generation failed";
        task.error = message;
      }
      writePendingTasks(cache);
    })
    .catch(
      /* v8 ignore next 3 -- fetchTaskRun never rejects */ (err) => {
        logger.error("pending-tasks", `Background task poll failed: ${err}`);
      },
    );
}
