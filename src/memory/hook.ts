/** `dosu memory hook`: the one entry point for Claude Code's SessionStart, UserPromptSubmit,
 * PostToolUse, PostToolUseFailure, Stop, and SessionEnd hooks. It must never block or break the session: every
 * failure is logged locally and the hook exits 0 with no output. Only an injected note is
 * printed. */

import { logger } from "../debug/logger";
import { readHookStdin } from "../sessions/capture";
import { redactSecrets } from "../sessions/redact";
import { displayRepo, originRepoOfDir } from "../sessions/repo";
import { spawnDetachedSelf } from "../sync/detach";
import { type MemoryApi, memoryApiFromConfig, type RecallRequest, recall, usableNote } from "./api";
import { headCommit } from "./git";
import { clip } from "./record-rules";
import {
  isSafeSessionId,
  newSessionState,
  type RecallMode,
  readSessionState,
  type SessionState,
  writeSessionState,
} from "./state";
import { claimFullNote, injectedFullNote, startTwoStageRecall } from "./two-stage";

/** Same cap as the `user_prompt` event, so recall sees the text the episode will hold. */
const RECALL_PROMPT_CHARS = 32_000;
/** One line ahead of stage two's block, which arrives mid-task after stage one. */
export const FULL_NOTE_PREFACE = "Addendum: detailed notes for this task.";

interface HookPayload {
  hook_event_name: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt?: string;
  source?: string;
  /** Set when the hook fires inside a subagent, whose context is not the main agent's. */
  agent_id?: string;
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
    ...(typeof p.agent_id === "string" ? { agent_id: p.agent_id } : {}),
  };
}

/** The exact block the frozen memwriter injected. */
function memoryBlock(note: string): string {
  return `<prior_task_memory>\n${note}\n</prior_task_memory>`;
}

/** Stage two: the same block behind a one-line preface. */
function fullNoteBlock(note: string): string {
  return `${FULL_NOTE_PREFACE}\n${memoryBlock(note)}`;
}

type ContextEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure";

function contextOutput(event: ContextEvent, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
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

/** `DOSU_MEMORY_RECALL_MODE=single` returns to phase 1's single recall; two-stage otherwise. */
function recallModeFromEnv(): RecallMode {
  const value = process.env.DOSU_MEMORY_RECALL_MODE?.trim();
  if (value === "single") return "single";
  if (value && value !== "two_stage") {
    logger.warn(
      "memory",
      "DOSU_MEMORY_RECALL_MODE is neither single nor two_stage; using two_stage",
    );
  }
  return "two_stage";
}

/** The backend's `owner/name` shape. */
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

/** `owner/name` for the session: `DOSU_MEMORY_REPO` when set (for checkouts without an origin,
 * such as evaluation containers), else the origin remote. A malformed override disables memory
 * for the session rather than silently falling back to another name. */
export function repoOfDir(dir: string): string | null {
  const override = process.env.DOSU_MEMORY_REPO?.trim();
  if (override) {
    if (REPO_NAME.test(override)) return override;
    logger.warn("memory", "DOSU_MEMORY_REPO is not owner/name; memory is off for this session");
    return null;
  }
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
    recall_mode: recallModeFromEnv(),
    now: deps.now,
  });
  writeSessionState(state, deps.configDir);
  return state;
}

/** Phase 1: one recall, waited for in full. Returns the note to inject, or null. */
async function singleRecall(
  api: MemoryApi,
  request: RecallRequest,
  deps: HookDeps,
): Promise<string | null> {
  const response = await recall(api, request, deps.fetchImpl);
  if ("error" in response) {
    logger.warn("memory", `recall failed for ${request.session_id}: ${response.error}`);
    return null;
  }
  const note = usableNote(response.note);
  logger.info(
    "memory",
    `recall for ${request.session_id}: ${note ? `${note.length} chars` : "no note"} from ` +
      `${response.available_episode_ids.length} episodes (${response.episode_ids.length} in ` +
      `full) in ${response.latency_ms} ms`,
  );
  return note;
}

/** First prompt: recall and remember the note for compaction. Later prompts in two-stage mode:
 * hand over stage two if it became ready after the last tool call. */
async function onPrompt(
  payload: HookPayload,
  state: SessionState,
  deps: HookDeps,
): Promise<string | null> {
  if (state.recall_attempted) {
    const full = claimFullNote(state.session_id, deps.configDir);
    return full ? contextOutput("UserPromptSubmit", fullNoteBlock(full)) : null;
  }
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
  const request = { repo: state.repo, session_id: state.session_id, prompt };
  const note =
    state.recall_mode === "single"
      ? await singleRecall(api, request, deps)
      : await startTwoStageRecall(api, request, deps);
  if (!note) return null;
  state.note = note;
  writeSessionState(state, deps.configDir);
  return contextOutput("UserPromptSubmit", memoryBlock(note));
}

/** After compaction: everything injected so far, stage one then stage two. */
function afterCompaction(state: SessionState, deps: HookDeps): string | null {
  const full = injectedFullNote(state.session_id, deps.configDir);
  const blocks = [
    ...(state.note ? [memoryBlock(state.note)] : []),
    ...(full ? [fullNoteBlock(full)] : []),
  ];
  return blocks.length > 0 ? contextOutput("SessionStart", blocks.join("\n\n")) : null;
}

/** Handle one hook payload; returns what to print on stdout, or null for nothing. */
export async function runMemoryHook(raw: unknown, deps: HookDeps = {}): Promise<string | null> {
  try {
    const payload = parsePayload(raw);
    if (!payload) {
      logger.warn("memory", "hook payload missing or malformed; ignored");
      return null;
    }
    const event = payload.hook_event_name;
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
      // Every tool call lands here, failed or not: local files only, and not even the session
      // state. A subagent's tool call would hand stage two to the subagent, not the main agent.
      if (payload.agent_id) return null;
      const full = claimFullNote(payload.session_id, deps.configDir);
      return full ? contextOutput(event, fullNoteBlock(full)) : null;
    }
    const state = ensureState(payload, deps);
    const spawn = deps.spawn ?? spawnDetachedSelf;
    switch (payload.hook_event_name) {
      case "SessionStart":
        // Compaction can drop what was injected; put the same notes back.
        return payload.source === "compact" ? afterCompaction(state, deps) : null;
      case "UserPromptSubmit":
        return await onPrompt(payload, state, deps);
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

/** `dosu memory hook`: payload on stdin, injected context (if any) on stdout. */
export async function runMemoryHookCommand(): Promise<void> {
  const output = await runMemoryHook(await readHookStdin());
  if (output) process.stdout.write(`${output}\n`);
}
