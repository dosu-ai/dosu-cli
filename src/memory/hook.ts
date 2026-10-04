/** `dosu memory hook`: the one entry point for Claude Code's SessionStart, UserPromptSubmit,
 * PostToolBatch, Stop, and SessionEnd hooks, and, with `--agent codex`, for Codex's SessionStart,
 * UserPromptSubmit, Stop, and SessionEnd hooks. Both agents send the same payload fields and take
 * the same output. It must never block or break the session: every failure is logged locally and
 * the hook exits 0 with no output. Only an injected note is printed. */

import { logger } from "../debug/logger";
import { readHookStdin } from "../sessions/capture";
import { redactSecrets } from "../sessions/redact";
import { displayRepo, originRepoOfDir } from "../sessions/repo";
import { spawnDetachedSelf } from "../sync/detach";
import { type MemoryApi, memoryApiFromConfig, type RecallRequest, recall, usableNote } from "./api";
import { headCommit } from "./git";
import { clip } from "./record-rules";
import {
  claimFullRecallStart,
  isSafeSessionId,
  MEMORY_AGENTS,
  type MemoryAgent,
  newSessionState,
  type RecallMode,
  readSessionState,
  removeStaleFullRecallRequests,
  type SessionState,
  writeSessionState,
} from "./state";
import {
  claimFullNote,
  injectedFullNote,
  quickRecall,
  runFullRecall,
  startTwoStageRecall,
} from "./two-stage";

/** Same cap as the `user_prompt` event, so recall sees the text the episode will hold. */
const RECALL_PROMPT_CHARS = 32_000;
/** One line ahead of stage two's block, which arrives mid-task after stage one. */
export const FULL_NOTE_PREFACE = "Addendum: detailed notes for this task.";

interface HookPayload {
  hook_event_name: string;
  session_id: string;
  /** Codex sends null for a session it keeps no transcript of. */
  transcript_path: string | null;
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
    (typeof p.transcript_path !== "string" && p.transcript_path !== null) ||
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

type ContextEvent = "SessionStart" | "UserPromptSubmit" | "PostToolBatch";

function contextOutput(event: ContextEvent, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  });
}

/** Which installed hook ran: the agent, and whether it is Codex's background prompt hook, which
 * runs stage two. */
export interface HookEntry {
  agent: MemoryAgent;
  stageTwo?: boolean;
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
function ensureState(payload: HookPayload, agent: MemoryAgent, deps: HookDeps): SessionState {
  const existing = readSessionState(payload.session_id, deps.configDir);
  if (existing) return existing;
  const state = newSessionState({
    session_id: payload.session_id,
    agent,
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

function recallRequest(repo: string, payload: HookPayload): RecallRequest {
  const prompt = clip(redactSecrets(payload.prompt ?? "").text, RECALL_PROMPT_CHARS);
  return { repo, session_id: payload.session_id, prompt };
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
  const request = recallRequest(state.repo, payload);
  let note: string | null;
  if (state.recall_mode === "single") {
    note = await singleRecall(api, request, deps);
  } else if (state.agent === "codex") {
    // Codex's background prompt hook runs stage two.
    note = await quickRecall(api, request, deps);
  } else {
    note = await startTwoStageRecall(api, request, deps);
  }
  if (!note) return null;
  state.note = note;
  writeSessionState(state, deps.configDir);
  return contextOutput("UserPromptSubmit", memoryBlock(note));
}

/** Codex's background prompt hook: stage two for the session's first prompt, started and waited
 * for here; Codex hands what it prints to the next model request of the turn, or of the next turn
 * once this one has ended. It runs alongside the prompt hook, which may not have written the
 * session state yet, so it reads that state at most and never writes it. */
async function stageTwo(payload: HookPayload, deps: HookDeps): Promise<string | null> {
  const sessionId = payload.session_id;
  const mode = readSessionState(sessionId, deps.configDir)?.recall_mode ?? recallModeFromEnv();
  if (mode !== "two_stage" || !claimFullRecallStart(sessionId, deps.configDir)) return null;
  const repo = (deps.repoOf ?? repoOfDir)(payload.cwd);
  const api = deps.api === undefined ? memoryApiFromConfig() : deps.api;
  if (!repo || !api) return null;
  const request = recallRequest(repo, payload);
  await runFullRecall(api, request, { configDir: deps.configDir, fetchImpl: deps.fetchImpl });
  const full = claimFullNote(sessionId, deps.configDir);
  return full ? contextOutput("UserPromptSubmit", fullNoteBlock(full)) : null;
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
export async function runMemoryHook(
  raw: unknown,
  deps: HookDeps = {},
  entry: HookEntry = { agent: "claude-code" },
): Promise<string | null> {
  try {
    const payload = parsePayload(raw);
    if (!payload) {
      logger.warn("memory", "hook payload missing or malformed; ignored");
      return null;
    }
    // A subagent's hooks carry its parent's session id: a note handed over there would reach the
    // subagent, and its prompt would count as the session's first.
    if (payload.agent_id) return null;
    if (payload.hook_event_name === "PostToolBatch") {
      // Every batch of tool calls lands here, failed calls included: local files only, and not
      // even the session state.
      const full = claimFullNote(payload.session_id, deps.configDir);
      return full ? contextOutput("PostToolBatch", fullNoteBlock(full)) : null;
    }
    if (entry.stageTwo) {
      return payload.hook_event_name === "UserPromptSubmit" ? await stageTwo(payload, deps) : null;
    }
    const state = ensureState(payload, entry.agent, deps);
    const spawn = deps.spawn ?? spawnDetachedSelf;
    switch (payload.hook_event_name) {
      case "SessionStart":
        // Requests a dead poller left behind. Swept here and on SessionEnd, not on the prompt and
        // tool-batch hooks, which the agent waits for.
        removeStaleFullRecallRequests(deps.configDir, deps.now);
        // Compaction can drop what was injected; put the same notes back.
        return payload.source === "compact" ? afterCompaction(state, deps) : null;
      case "UserPromptSubmit":
        return await onPrompt(payload, state, deps);
      case "Stop":
        spawn(["memory", "sync", "--session", payload.session_id]);
        return null;
      case "SessionEnd":
        removeStaleFullRecallRequests(deps.configDir, deps.now);
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

/** `[--agent claude-code|codex] [--stage-two]`, parsed without Commander for the fast path in
 * index.ts; null for anything else. */
export function parseHookArgs(args: readonly string[]): HookEntry | null {
  const entry: HookEntry = { agent: "claude-code" };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--stage-two") {
      entry.stageTwo = true;
    } else if (args[i] === "--agent" && MEMORY_AGENTS.some((agent) => agent === args[i + 1])) {
      entry.agent = args[i + 1] as MemoryAgent;
      i += 1;
    } else {
      return null;
    }
  }
  return entry;
}

/** `dosu memory hook`: payload on stdin, injected context (if any) on stdout. */
export async function runMemoryHookCommand(entry: HookEntry): Promise<void> {
  const output = await runMemoryHook(await readHookStdin(), {}, entry);
  if (output) process.stdout.write(`${output}\n`);
}
