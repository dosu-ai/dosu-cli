/** Prompt-time memory: the Claude Code `UserPromptSubmit` hook behind `dosu knowledge context`.
 *
 * Reads the hook payload from stdin, asks the server whether this prompt warrants a memory
 * digest (POST /v1/memory/context), and prints the hook's JSON when it does. The server makes
 * the decision -- it skips steers, drops memories the session has already been shown, and asks
 * a classifier whether the rest would change how the task starts -- so this side only has to be
 * fast and harmless.
 *
 * Harmless is the hard constraint. The hook runs while the user's prompt waits, and a hook that
 * errors surfaces that error to them mid-sentence. So every failure -- no credentials, a slow
 * or down server, a malformed payload -- produces no output and a clean exit, and the prompt
 * goes through exactly as if Dosu were not installed. */

import { textHasIncognitoMarker, transcriptHasIncognitoMarker } from "../sync/incognito";

/** Retrieval is ~0.6s warm and ~2.5s cold, plus ~0.15s for the classifier. Past this the user
 * is waiting on us, and a late digest is not worth a stalled prompt. */
export const CONTEXT_TIMEOUT_MS = 4_000;

/** The trajectory source the session's transcript will later ingest under, so a pushed memory
 * ranks by the same scope its evidence will get. */
const CLAUDE_CODE_AGENT = "claude-code";

interface PromptHookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
}

interface ContextResponse {
  digest?: unknown;
}

export interface ContextHookOptions {
  apiKey: string;
  deploymentId: string;
  backendUrl: string;
  timeoutMs?: number;
  /** Injectable boundaries, for tests. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  branchOf?: (cwd: string) => string | null;
  isIncognito?: (transcriptPath: string) => boolean;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The hook's stdout for one payload: the additionalContext JSON, or "" to add nothing. */
export async function contextHookOutput(
  stdin: string,
  options: ContextHookOptions,
): Promise<string> {
  let payload: PromptHookPayload;
  try {
    payload = JSON.parse(stdin) as PromptHookPayload;
  } catch {
    return "";
  }
  if (payload.hook_event_name !== "UserPromptSubmit") return "";
  const prompt = str(payload.prompt);
  if (!prompt) return "";

  // The prompt is sent to Dosu and logged as the retrieval query, so a session the user took
  // off the record must not be queried either -- same opt-out transcript shipping honors.
  if (textHasIncognitoMarker(prompt)) return "";
  const transcript = str(payload.transcript_path);
  const isIncognito = options.isIncognito ?? transcriptHasIncognitoMarker;
  if (transcript && isIncognito(transcript)) return "";

  const cwd = str(payload.cwd);
  const branch = cwd ? (options.branchOf?.(cwd) ?? null) : null;
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.backendUrl.replace(/\/$/, "")}/v1/memory/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dosu-API-Key": options.apiKey },
      body: JSON.stringify({
        deployment_id: options.deploymentId,
        prompt,
        session_id: str(payload.session_id),
        branch,
        agent: CLAUDE_CODE_AGENT,
        repo: cwd,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? CONTEXT_TIMEOUT_MS),
    });
    if (response.status !== 200) return "";
    const body = (await response.json()) as ContextResponse;
    const digest = str(body.digest);
    if (!digest) return "";
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: digest },
    });
  } catch {
    return "";
  }
}
