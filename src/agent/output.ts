/**
 * NDJSON event output for agent-mode commands.
 *
 * Every line written to stdout in `--agent` / `--json` mode is a single
 * JSON object on its own line. The `agent_next_steps` field is the
 * crucial bit — it tells the coding agent driving the CLI what to do
 * next without needing it to parse status codes or guess.
 *
 * This pattern is borrowed directly from Netlify CLI's `login --request`
 * output, which returns an `agent_next_steps` string aimed at AI agents.
 */

export type AgentStatus =
  | "ok"
  | "need_user_action"
  | "pending"
  | "authenticated"
  | "expired"
  | "error";

export interface AgentEventBase {
  step?: string;
  status: AgentStatus;
  agent_next_steps?: string;
}

/** Emit a single JSON line to stdout. */
export function emitJSONLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

/**
 * The CLI exits but the user still has to do something out-of-band —
 * typically open a URL in a browser. The agent should relay `url` to the
 * user and re-run `resume_command` when the user confirms they're done.
 */
export function emitNeedUserAction(opts: {
  step: string;
  url: string;
  ticket: string;
  resume_command: string;
  expires_in: number;
  agent_next_steps: string;
}): void {
  emitJSONLine({
    step: opts.step,
    status: "need_user_action",
    url: opts.url,
    ticket: opts.ticket,
    resume_command: opts.resume_command,
    expires_in: opts.expires_in,
    agent_next_steps: opts.agent_next_steps,
  });
}

/**
 * Emit a structured error with a `reason` machine code and a human/agent
 * remediation string. `reason` is for telemetry / agents to switch on;
 * `agent_next_steps` is what the calling agent should tell the user.
 *
 * Additional fields can be attached (e.g. `candidates` for a list of
 * deployments to pick from) — they're spread into the JSON line so the
 * driving agent can consume them programmatically without parsing
 * `agent_next_steps` prose.
 */
export function emitError(opts: {
  step: string;
  reason: string;
  agent_next_steps: string;
  [key: string]: unknown;
}): void {
  const { step, reason, agent_next_steps, ...rest } = opts;
  emitJSONLine({
    step,
    status: "error",
    reason,
    ...rest,
    agent_next_steps,
  });
}

/** Emit a normal progress event. */
export function emitStep(opts: {
  step: string;
  status?: Exclude<AgentStatus, "error" | "need_user_action">;
  [key: string]: unknown;
}): void {
  const { step, status = "ok", ...rest } = opts;
  emitJSONLine({ step, status, ...rest });
}
