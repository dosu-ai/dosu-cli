/** Two-stage recall. The first prompt waits only for stage one (the quick note, at most 5 s) and
 * starts stage two, the note written for this task, in the background; a detached
 * `dosu memory recall-poll` waits for it and saves it locally. Hooks after the first prompt read
 * local files only: stage two goes to the agent with the first tool result after it is ready
 * (PostToolUse, or PostToolUseFailure for a failed call), or with the next prompt if no tool ran
 * in between, once per session. */

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
  writeFullRecallState,
} from "./state";

interface TwoStageDeps {
  configDir?: string;
  fetchImpl?: typeof fetch;
  spawn?: (args: string[]) => boolean;
  now?: Date;
}

/** First prompt: ask for both stages at once, return stage one's note (null for none), and leave
 * stage two to a detached poller. Never waits for stage two. */
export async function startTwoStageRecall(
  api: MemoryApi,
  request: RecallRequest,
  deps: TwoStageDeps,
): Promise<string | null> {
  const sessionId = request.session_id;
  const [quick, job] = await Promise.all([
    recallQuick(api, request, deps.fetchImpl),
    startFullRecall(api, request, deps.fetchImpl),
  ]);

  if ("error" in job) {
    logger.warn("memory", `full recall not started for ${sessionId}: ${job.error}`);
  } else {
    writeFullRecallState(
      {
        session_id: sessionId,
        job_id: job.job_id,
        status: "pending",
        note: null,
        error: null,
        started_at: (deps.now ?? new Date()).toISOString(),
        finished_at: null,
      },
      deps.configDir,
    );
    const spawn = deps.spawn ?? spawnDetachedSelf;
    if (!spawn(["memory", "recall-poll", "--session", sessionId])) {
      logger.warn("memory", `full recall poller for ${sessionId} did not start`);
    }
  }

  if ("error" in quick) {
    logger.warn("memory", `quick recall failed for ${sessionId}: ${quick.error}`);
    return null;
  }
  const note = usableNote(quick.note);
  logger.info(
    "memory",
    `quick recall for ${sessionId}: ${note ? `${note.length} chars` : "no note"} in ` +
      `${quick.latency_ms} ms`,
  );
  return note;
}

/** Stage two's note if it is ready and this caller won the session's one injection; else null.
 * Local files only, no network: this runs on every tool call. */
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
/** A note later than this is not worth handing over; the job counts as failed. */
const POLL_DEADLINE_MS = 120_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `dosu memory recall-poll --session <id>`: poll stage two until it is done, fails, or runs past
 * the deadline, then save the outcome. Network errors and 5xx are retried until the deadline; a
 * 4xx (unknown job) ends the wait. Returns the saved state, or null when there was nothing to
 * wait for. */
export async function pollFullRecall(
  sessionId: string,
  deps: PollDeps = {},
): Promise<FullRecallState | null> {
  const full = readFullRecallState(sessionId, deps.configDir);
  if (full?.status !== "pending") return full;
  const api = deps.api === undefined ? memoryApiFromConfig() : deps.api;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now().getTime() + (deps.deadlineMs ?? POLL_DEADLINE_MS);

  const finish = (outcome: Pick<FullRecallState, "status" | "note" | "error">) => {
    const done: FullRecallState = { ...full, ...outcome, finished_at: now().toISOString() };
    writeFullRecallState(done, deps.configDir);
    const detail = outcome.note ? `${outcome.note.length} chars` : (outcome.error ?? "no note");
    logger.info("memory", `full recall for ${sessionId}: ${outcome.status}, ${detail}`);
    return done;
  };

  if (!api) return finish({ status: "failed", note: null, error: "not signed in" });
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
    await sleep(deps.intervalMs ?? POLL_INTERVAL_MS);
  }
}
