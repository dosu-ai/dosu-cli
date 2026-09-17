/** NDJSON output for agent mode: one JSON object per stdout line, where `agent_next_steps`
 * tells the driving agent what to do next without parsing status codes. */

export type AgentStatus =
  | "ok"
  | "need_user_action"
  | "pending"
  | "authenticated"
  | "expired"
  | "error";

/** Emit a single JSON line to stdout. */
export function emitJSONLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** The user must act out-of-band: the agent relays `url`, then re-runs `resume_command`. */
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

/** Emit a structured error: `reason` is a machine code to switch on, `agent_next_steps` is the
 * remediation to relay, and any extra fields are spread into the JSON line. */
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
