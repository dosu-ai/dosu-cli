/** The model a study run pins: whatever the gateway reports serving. Without a pin, Claude Code
 * shapes requests for its own default model, which the gateway's served model can reject. */

import { logger } from "../debug/logger";

/** What the gateway serves today; used when it can't be asked (older gateways 404). */
export const DEFAULT_LEARNER_MODEL = "claude-haiku-4-5";

const CAPABILITIES_TIMEOUT_MS = 5_000;

/** Also keeps the value safe to embed in an env var and a header line. */
const CLAUDE_MODEL_PATTERN = /^claude-[a-z0-9.-]+$/;

export interface ResolveServedModelOptions {
  gatewayURL: string;
  /** The user's Dosu API key (`sk_user_*`). */
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Ask the gateway which model it serves; any failure falls back to the default. Never throws. */
export async function resolveServedModel(options: ResolveServedModelOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const resp = await fetchImpl(`${options.gatewayURL}/capabilities`, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? CAPABILITIES_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.debug("learner", `gateway capabilities returned ${resp.status}; using default model`);
      return DEFAULT_LEARNER_MODEL;
    }
    const body = (await resp.json()) as { model?: unknown } | null;
    const model = body?.model;
    if (typeof model === "string" && CLAUDE_MODEL_PATTERN.test(model)) return model;
    logger.debug("learner", "gateway capabilities named no usable model; using default model");
    return DEFAULT_LEARNER_MODEL;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    logger.debug("learner", `gateway capabilities failed (${text}); using default model`);
    return DEFAULT_LEARNER_MODEL;
  }
}
