/** `dosu memory hook`: the one entry point for Claude Code's SessionStart, UserPromptSubmit, Stop,
 * and SessionEnd hooks. It must never block or break the session: every failure is logged
 * locally and the hook exits 0 with no output. Only an injected note is printed. */

import { logger } from "../debug/logger";
import { redactSecrets } from "../sessions/redact";
import { displayRepo, originRepoOfDir } from "../sessions/repo";
import { spawnDetachedSelf } from "../sync/detach";
import { type MemoryApi, memoryApiFromConfig, recall } from "./api";
import { headCommit } from "./git";
import { clip } from "./record-rules";
import {
  isSafeSessionId,
  newSessionState,
  readSessionState,
  type SessionState,
  writeSessionState,
} from "./state";

/** Same cap as the `user_prompt` event, so recall sees the text the episode will hold. */
const RECALL_PROMPT_CHARS = 32_000;
/** The writer's "no note" answer; never injected. */
const NO_NOTE = "NONE";

interface HookPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt?: string;
  source?: string;
}

function parsePayload(raw: unknown): HookPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (
    typeof p.hook_event_name !== "string" ||
    typeof p.session_id !== "string" ||
    !isSafeSessionId(p.session_id) ||
    typeof p.transcript_path !== "string" ||
    typeof p.cwd !== "string"
  ) {
    return null;
  }
  return {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    transcript_path: p.transcript_path,
    cwd: p.cwd,
    ...(typeof p.prompt === "string" ? { prompt: p.prompt } : {}),
    ...(typeof p.source === "string" ? { source: p.source } : {}),
  };
}

/** The exact block the frozen memwriter injected. */
function memoryBlock(note: string): string {
  return `<prior_task_memory>\n${note}\n</prior_task_memory>`;
}

function contextOutput(event: "SessionStart" | "UserPromptSubmit", note: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: memoryBlock(note) },
  });
}

export interface HookDeps {
  configDir?: string;
  api?: MemoryApi | null;
  fetchImpl?: typeof fetch;
  repoOf?: (dir: string) => string | null;
  headOf?: (dir: string) => string | null;
  spawn?: (args: string[]) => boolean;
  now?: Date;
}

function repoOfDir(dir: string): string | null {
  const repo = originRepoOfDir(dir);
  return repo ? displayRepo(repo) : null;
}

/** The session's state, created on first sight. SessionStart normally creates it; any later
 * event creates it too, so hooks enabled mid-session still work. An existing state is kept as
 * is: a resumed session continues the same transcript from the same cursor and start commit. */
function ensureState(payload: HookPayload, deps: HookDeps): SessionState {
  const existing = readSessionState(payload.session_id, deps.configDir);
  if (existing) return existing;
  const state = newSessionState({
    session_id: payload.session_id,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    repo: (deps.repoOf ?? repoOfDir)(payload.cwd),
    start_head: (deps.headOf ?? headCommit)(payload.cwd),
    now: deps.now,
  });
  writeSessionState(state, deps.configDir);
  return state;
}

/** First prompt of the session only: fetch the note and remember it for compaction. */
async function onFirstPrompt(
  payload: HookPayload,
  state: SessionState,
  deps: HookDeps,
): Promise<string | null> {
  if (state.recall_attempted) return null;
  state.recall_attempted = true;
  writeSessionState(state, deps.configDir);
  if (!state.repo) {
    logger.info("memory", `recall skipped for ${state.session_id}: no origin remote`);
    return null;
  }
  const api = deps.api === undefined ? memoryApiFromConfig() : deps.api;
  if (!api) {
    logger.info("memory", "recall skipped: not signed in to a Dosu deployment");
    return null;
  }
  const prompt = clip(redactSecrets(payload.prompt ?? "").text, RECALL_PROMPT_CHARS);
  const response = await recall(
    api,
    { repo: state.repo, session_id: state.session_id, prompt },
    deps.fetchImpl,
  );
  if ("error" in response) {
    logger.warn("memory", `recall failed for ${state.session_id}: ${response.error}`);
    return null;
  }
  const note = response.note.trim();
  logger.info(
    "memory",
    `recall for ${state.session_id}: ${note ? `${note.length} chars` : "no note"} from ` +
      `${response.available_episode_ids.length} episodes (${response.episode_ids.length} in ` +
      `full) in ${response.latency_ms} ms`,
  );
  if (!note || note === NO_NOTE) return null;
  state.note = note;
  writeSessionState(state, deps.configDir);
  return contextOutput("UserPromptSubmit", note);
}

/** Handle one hook payload; returns what to print on stdout, or null for nothing. */
export async function runMemoryHook(raw: unknown, deps: HookDeps = {}): Promise<string | null> {
  try {
    const payload = parsePayload(raw);
    if (!payload) {
      logger.warn("memory", "hook payload missing or malformed; ignored");
      return null;
    }
    const state = ensureState(payload, deps);
    const spawn = deps.spawn ?? spawnDetachedSelf;
    switch (payload.hook_event_name) {
      case "SessionStart":
        // Compaction can drop the note the first prompt injected; put the same note back.
        return payload.source === "compact" && state.note
          ? contextOutput("SessionStart", state.note)
          : null;
      case "UserPromptSubmit":
        return await onFirstPrompt(payload, state, deps);
      case "Stop":
        spawn(["memory", "sync", "--session", payload.session_id]);
        return null;
      case "SessionEnd":
        spawn(["memory", "sync", "--session", payload.session_id, "--flush"]);
        return null;
      default:
        return null;
    }
  } catch (err) {
    logger.warn("memory", `hook failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
