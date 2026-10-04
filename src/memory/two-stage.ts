/** Two-stage recall. The first prompt hands stage two, the note written for this task, to a
 * detached `dosu memory recall-poll`, which starts it, waits for it and saves it locally; the
 * prompt itself waits only for stage one (the quick note, at most 2.5 s by default). Hooks after
 * the first prompt read local files only: stage two goes to the agent with the first batch of tool
 * results after it is ready (PostToolBatch), or with the next prompt if no tool ran in between,
 * once per session. Codex has no PostToolBatch but runs hooks in the background: there a
 * background prompt hook takes the poller's place and hands the note over itself. */

import { logger } from "../debug/logger";
import { spawnDetachedSelf } from "../sync/detach";
import {
  fullRecallStatus,
  type MemoryApi,
  memoryApiFromConfig,
  type RecallRequest,
  recallQuick,
  startFullRecall,
  usableNote,
} from "./api";
import {
  claimFullRecallInjection,
  type FullRecallState,
  fullRecallInjected,
  readFullRecallState,
  takeFullRecallRequest,
  writeFullRecallRequest,
  writeFullRecallState,
} from "./state";

interface TwoStageDeps {
  configDir?: string;
  fetchImpl?: typeof fetch;
  spawn?: (args: string[]) => boolean;
}

/** First prompt: leave stage two to a detached poller, then return stage one's note (null for
 * none). Never waits for stage two, not even for its start. */
export async function startTwoStageRecall(
  api: MemoryApi,
  request: RecallRequest,
  deps: TwoStageDeps,
): Promise<string | null> {
  const sessionId = request.session_id;
  // The prompt goes in a file, not argv: argv is visible to every local user in `ps`.
  writeFullRecallRequest(request, deps.configDir);
  const spawn = deps.spawn ?? spawnDetachedSelf;
  if (!spawn(["memory", "recall-poll", "--session", sessionId])) {
    logger.warn("memory", `full recall poller for ${sessionId} did not start`);
    takeFullRecallRequest(sessionId, deps.configDir);
  }
  return quickRecall(api, request, deps);
}

/** Stage one's note, or null for none. */
export async function quickRecall(
  api: MemoryApi,
  request: RecallRequest,
  deps: TwoStageDeps,
): Promise<string | null> {
  const sessionId = request.session_id;
  const quick = await recallQuick(api, request, deps.fetchImpl);
  if ("error" in quick) {
    logger.warn("memory", `quick recall failed for ${sessionId}: ${quick.error}`);
    return null;
  }
  const note = usableNote(quick.note);
  logger.info(
    "memory",
    `quick recall ${quick.recall_id ?? "(no id)"} for ${sessionId}: ` +
      `${note ? `${note.length} chars` : "no note"} in ${quick.latency_ms} ms`,
  );
  return note;
}

/** Stage two's note if it is ready and this caller won the session's one injection; else null.
 * Local files only, no network: this runs after every batch of tool calls. */
export function claimFullNote(sessionId: string, configDir?: string): string | null {
  if (fullRecallInjected(sessionId, configDir)) return null;
  const full = readFullRecallState(sessionId, configDir);
  if (full?.status !== "done" || !full.note) return null;
  if (!claimFullRecallInjection(sessionId, configDir)) return null;
  logger.info("memory", `full recall note handed over for ${sessionId}`);
  return full.note;
}

/** Stage two's note when it has already been injected (to put back after compaction). */
export function injectedFullNote(sessionId: string, configDir?: string): string | null {
  if (!fullRecallInjected(sessionId, configDir)) return null;
  return readFullRecallState(sessionId, configDir)?.note ?? null;
}

export interface PollDeps {
  api?: MemoryApi | null;
  fetchImpl?: typeof fetch;
  configDir?: string;
  intervalMs?: number;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const POLL_INTERVAL_MS = 1_000;
/** The backend gives a job 120 s from the start request; a few seconds more so a note finished
 * right at its deadline is still read. It counts from the first start attempt, so retried starts
 * shorten the wait. A job whose worker died only reads as failed 30 s after the deadline; the
 * poller has stopped by then and records it as timed out. */
const POLL_DEADLINE_MS = 125_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `dosu memory recall-poll --session <id>`: run stage two with the request the first prompt
 * left. Returns the saved state, or null when no job started. */
export async function pollFullRecall(
  sessionId: string,
  deps: PollDeps = {},
): Promise<FullRecallState | null> {
  const request = takeFullRecallRequest(sessionId, deps.configDir);
  if (!request) return null;
  const api = deps.api === undefined ? memoryApiFromConfig() : deps.api;
  if (!api) {
    logger.warn("memory", `full recall not started for ${sessionId}: not signed in`);
    return null;
  }
  return runFullRecall(api, request, deps);
}

/** Start stage two, poll it until it is done, fails, or runs past the deadline, then save the
 * outcome. The start is retried until the deadline only while the request cannot leave (see
 * `startFullRecall`). Polls retry network errors and 5xx until the deadline; a 4xx (unknown job)
 * ends the wait. Returns the saved state, or null when no job started. */
export async function runFullRecall(
  api: MemoryApi,
  request: RecallRequest,
  deps: Omit<PollDeps, "api"> = {},
): Promise<FullRecallState | null> {
  const sessionId = request.session_id;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = now().getTime() + (deps.deadlineMs ?? POLL_DEADLINE_MS);

  let job = await startFullRecall(api, request, deps.fetchImpl);
  while ("error" in job && !job.permanent && now().getTime() < deadline) {
    await sleep(intervalMs);
    job = await startFullRecall(api, request, deps.fetchImpl);
  }
  if ("error" in job) {
    logger.warn("memory", `full recall not started for ${sessionId}: ${job.error}`);
    return null;
  }
  const full: FullRecallState = {
    session_id: sessionId,
    job_id: job.job_id,
    status: "pending",
    note: null,
    error: null,
    started_at: now().toISOString(),
    finished_at: null,
  };
  writeFullRecallState(full, deps.configDir);

  const finish = (outcome: Pick<FullRecallState, "status" | "note" | "error">) => {
    const done: FullRecallState = { ...full, ...outcome, finished_at: now().toISOString() };
    writeFullRecallState(done, deps.configDir);
    const detail = outcome.note ? `${outcome.note.length} chars` : (outcome.error ?? "no note");
    logger.info("memory", `full recall for ${sessionId}: ${outcome.status}, ${detail}`);
    return done;
  };

  for (;;) {
    const answer = await fullRecallStatus(api, full.job_id, deps.fetchImpl);
    if ("permanent" in answer) {
      if (answer.permanent) return finish({ status: "failed", note: null, error: answer.error });
    } else if (answer.status === "done") {
      return finish({ status: "done", note: usableNote(answer.note), error: null });
    } else if (answer.status === "failed") {
      return finish({ status: "failed", note: null, error: answer.error ?? "failed" });
    }
    if (now().getTime() >= deadline) {
      return finish({ status: "failed", note: null, error: "timed out" });
    }
    await sleep(intervalMs);
  }
}
