/**
 * Dosu knowledge-injection hooks for Claude Code.
 *
 * Two kinds of subcommands:
 *  - Hook entrypoints (`user-prompt-submit`, `post-tool-use`, `stop`, `status`) —
 *    invoked by Claude Code on every turn. They read a hook-event JSON object on
 *    stdin and print the hook contract on stdout. They are async, idempotent, and
 *    fail silently: ANY error results in no stdout (or `{continue:true}` for stop)
 *    and exit 0, so the agent is never disrupted.
 *  - Lifecycle commands (`install`/`uninstall`/`doctor`) — run once by a human or
 *    setup agent.
 *
 * Latency: the no-op path (no active ticket / already delivered / within cooldown)
 * uses only Node built-ins + a small state-file read and returns before importing
 * the HTTP client. Network/auth modules are lazy-imported only when a create or a
 * poll is actually required.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Argument, Command } from "commander";
import { isAuthenticated, loadConfig, MODE_OSS } from "../config/config";
import { logger } from "../debug/logger";
import { loadState, saveState, type TicketState } from "../hooks/state";

interface HookInput {
  session_id?: string;
  turn_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

type HookEvent = "user-prompt-submit" | "post-tool-use" | "stop";

const COOLDOWN_DEFAULT_MS = 3000;
const TTL_DEFAULT_MS = 10 * 60 * 1000; // 10 minutes

/** Coding agents that have a Dosu hook adapter today (Codex is a follow-up). */
const SUPPORTED_AGENTS = ["claude-code"];

// ---------------------------------------------------------------------------
// Timing knobs (env-overridable; production relies on the cooldown only)
// ---------------------------------------------------------------------------

function cooldownMs(): number {
  const n = Number.parseInt(process.env.DOSU_HOOK_CHECK_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : COOLDOWN_DEFAULT_MS;
}

function ttlMs(): number {
  const n = Number.parseInt(process.env.DOSU_HOOK_TTL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : TTL_DEFAULT_MS;
}

// ---------------------------------------------------------------------------
// stdout helpers (the hook wire contract)
// ---------------------------------------------------------------------------

function printHookContext(event: string, additionalContext: string): void {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

function printContinue(): void {
  console.log(JSON.stringify({ continue: true }));
}

function sid8(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Repo identifier for retrieval/correlation — basename only, never the absolute path (privacy §8.2). */
function repoSlug(cwd?: string): string | undefined {
  return cwd ? basename(cwd) : undefined;
}

// ---------------------------------------------------------------------------
// Hook entrypoint handlers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/** UserPromptSubmit: create a ticket (fire-and-forget) and inject the "lookup started" note. */
export async function runUserPromptSubmit(
  input: HookInput,
  now: number = Date.now(),
): Promise<void> {
  const sessionId = input.session_id;
  if (!sessionId) return;
  const prompt = (input.prompt ?? "").trim();
  if (!prompt) return; // nothing to retrieve

  // One active ticket per session: reuse a live pending ticket; don't mint a second.
  const existing = loadState(sessionId);
  if (existing && existing.status === "pending" && now <= existing.expiresAt) {
    logger.debug("hooks", `submit sid=${sid8(sessionId)} reuse tid=${existing.ticketId}`);
    return;
  }

  const cfg = loadConfig();
  if (!isAuthenticated(cfg) || !cfg.deployment_id) {
    logger.debug("hooks", "submit skipped reason=not-configured");
    return; // a hook never prompts the user; `doctor` surfaces this
  }

  const tc = await import("../hooks/ticket-client");
  const startedAt = Date.now();
  let resp: import("../hooks/ticket-client").CreateTicketResponse;
  try {
    resp = await tc.requestCreateTicket(cfg, {
      deployment_id: cfg.deployment_id,
      agent: "claude-code",
      session_id: sessionId,
      turn_id: input.turn_id ?? String(now),
      prompt,
      repo: repoSlug(input.cwd),
    });
  } catch (err) {
    logger.warn("hooks", `error event=user-prompt-submit reason=${errMsg(err)}`);
    return; // no state, no output — a failed lookup is invisible
  }

  saveState({
    ticketId: resp.ticket_id,
    sessionId,
    turnId: input.turn_id ?? String(now),
    status: "pending",
    createdAt: now,
    expiresAt: now + ttlMs(),
  });
  logger.info(
    "hooks",
    `create sid=${sid8(sessionId)} tid=${resp.ticket_id} latency=${Date.now() - startedAt}ms`,
  );

  const { LOOKUP_STARTED_NOTE } = await import("../hooks/prompts");
  printHookContext("UserPromptSubmit", LOOKUP_STARTED_NOTE);
}

/** PostToolUse: poll a pending ticket (throttled) and inject the route map exactly once. */
export async function runPostToolUse(input: HookInput, now: number = Date.now()): Promise<void> {
  const sessionId = input.session_id;
  if (!sessionId) return;

  const state = loadState(sessionId);
  if (!state) {
    logger.debug("hooks", "noop reason=no-active-ticket");
    return;
  }
  // Fast no-op terminal states — never call the server again.
  if (state.status === "delivered" || state.status === "failed" || state.status === "expired") {
    return;
  }
  if (now > state.expiresAt) {
    saveState({ ...state, status: "expired" });
    logger.debug("hooks", `expire tid=${state.ticketId}`);
    return;
  }
  // Cooldown gate — most PostToolUse ticks exit here with no network.
  if (state.lastCheckedAt !== undefined && now - state.lastCheckedAt < cooldownMs()) {
    logger.debug("hooks", `poll tid=${state.ticketId} skipped=cooldown`);
    return;
  }

  const cfg = loadConfig();
  if (!isAuthenticated(cfg) || !cfg.deployment_id) {
    saveState({ ...state, lastCheckedAt: now });
    return;
  }

  const tc = await import("../hooks/ticket-client");
  const startedAt = Date.now();
  let resp: import("../hooks/ticket-client").TicketStatusResponse;
  try {
    resp = await tc.requestGetTicket(cfg, state.ticketId);
  } catch (err) {
    if (tc.isDefinitiveError(err)) {
      saveState({ ...state, status: "failed", lastCheckedAt: now });
      logger.warn("hooks", `error event=post-tool-use reason=${errMsg(err)} definitive`);
    } else {
      saveState({ ...state, lastCheckedAt: now }); // transient → retry next tick
      logger.debug("hooks", `poll tid=${state.ticketId} transient-error`);
    }
    return;
  }

  if (resp.status === "pending") {
    saveState({ ...state, lastCheckedAt: now });
    logger.debug("hooks", `poll tid=${state.ticketId} status=pending`);
    return;
  }
  if (resp.status === "failed" || resp.status === "expired") {
    saveState({ ...state, status: resp.status, lastCheckedAt: now });
    return;
  }
  if (!resp.result) {
    // ready but no payload — defensive: treat as failed, never inject empty context.
    saveState({ ...state, status: "failed", lastCheckedAt: now });
    return;
  }

  // The single delivery moment. Persist `delivered` BEFORE printing so a crash
  // after disk fails toward "no duplicate injection" rather than a re-poll.
  saveState({ ...state, status: "delivered", deliveredAt: now, lastCheckedAt: now });
  const { buildReadyEnvelope } = await import("../hooks/prompts");
  const context = buildReadyEnvelope(resp.result.context, resp.result.save_recommended ?? false);
  if (context) {
    printHookContext("PostToolUse", context);
    logger.info(
      "hooks",
      `deliver tid=${state.ticketId} latency=${Date.now() - startedAt}ms bytes=${context.length}`,
    );
  } else {
    logger.debug("hooks", `deliver tid=${state.ticketId} nothing-to-inject`);
  }
}

/** Stop (opt-in): last-chance delivery. Blocks ONLY for a ready-but-undelivered ticket. */
export async function runStop(input: HookInput, now: number = Date.now()): Promise<void> {
  const sessionId = input.session_id;
  if (!sessionId) return printContinue();
  // Loop-guard: a Stop triggered by a prior Stop-hook block must not re-block.
  if (input.stop_hook_active === true) return printContinue();

  const state = loadState(sessionId);
  if (!state) return printContinue();
  if (state.status !== "pending" || now > state.expiresAt) return printContinue();
  if (state.lastCheckedAt !== undefined && now - state.lastCheckedAt < cooldownMs()) {
    return printContinue();
  }

  const cfg = loadConfig();
  if (!isAuthenticated(cfg) || !cfg.deployment_id) return printContinue();

  const tc = await import("../hooks/ticket-client");
  let resp: import("../hooks/ticket-client").TicketStatusResponse;
  try {
    resp = await tc.requestGetTicket(cfg, state.ticketId);
  } catch {
    saveState({ ...state, lastCheckedAt: now }); // never hold the agent open
    return printContinue();
  }

  if (resp.status === "ready" && resp.result) {
    // Consume the ticket either way, but only BLOCK the agent for real knowledge.
    // A bare save nudge (knowledge gap, empty context) is not worth holding the
    // agent open at Stop — drop it rather than block on nothing actionable.
    saveState({ ...state, status: "delivered", deliveredAt: now, lastCheckedAt: now });
    if (resp.result.context.trim()) {
      const { buildReadyEnvelope, STOP_PREFIX } = await import("../hooks/prompts");
      const envelope = buildReadyEnvelope(
        resp.result.context,
        resp.result.save_recommended ?? false,
      );
      console.log(JSON.stringify({ decision: "block", reason: `${STOP_PREFIX}\n\n${envelope}` }));
      logger.info("hooks", `stop tid=${state.ticketId} delivered=true`);
      return;
    }
    logger.debug("hooks", `stop tid=${state.ticketId} delivered=true gap-no-block`);
    return printContinue();
  }

  saveState({ ...state, lastCheckedAt: now });
  logger.debug("hooks", `stop tid=${state.ticketId} delivered=false`);
  printContinue();
}

/** status: print the active ticket for a session (human or `--json`). */
export function runStatus(
  input: HookInput,
  opts: { json?: boolean },
  now: number = Date.now(),
): void {
  const sessionId = input.session_id ?? "";
  const state: TicketState | null = sessionId ? loadState(sessionId) : null;
  const data = state
    ? { ...state, expired: now > state.expiresAt, delivered: state.deliveredAt !== undefined }
    : null;

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (!data) {
    console.log("No active Dosu knowledge ticket for this session.");
    return;
  }
  console.log(`Ticket: ${data.ticketId}`);
  console.log(`Status: ${data.status}`);
  console.log(`Delivered: ${data.delivered ? "yes" : "no"}`);
}

/**
 * Parse stdin + dispatch + the global "never disrupt the agent" error wrapper.
 * Exported so the parse/dispatch/error-handling is unit-testable with a raw string.
 */
export async function runHookEntrypoint(
  event: HookEvent,
  raw: string,
  now: number = Date.now(),
): Promise<void> {
  let input: HookInput = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    input = {}; // malformed stdin → treat as empty → silent no-op
  }
  try {
    if (event === "user-prompt-submit") await runUserPromptSubmit(input, now);
    else if (event === "post-tool-use") await runPostToolUse(input, now);
    else await runStop(input, now);
  } catch (err) {
    logger.warn("hooks", `error event=${event} reason=${errMsg(err)}`);
    if (event === "stop") printContinue();
  }
}

/* v8 ignore start -- fd-0 read is process glue, exercised only at runtime */
function readStdinRaw(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Lifecycle commands (run once by a human / setup agent)
// ---------------------------------------------------------------------------

function resolveDir(dir?: string): string {
  return dir ?? process.cwd();
}

export interface LifecycleOptions {
  scope?: string;
  dir?: string;
  withStop?: boolean;
  json?: boolean;
}

async function emitErrorLine(step: string, reason: string, agentNextSteps: string): Promise<void> {
  const { emitError } = await import("../agent/output");
  emitError({ step, reason, agent_next_steps: agentNextSteps });
}

/** `dosu hooks install claude-code` — merge Dosu hooks into local Claude Code config. */
export async function runInstall(agent: string, opts: LifecycleOptions): Promise<void> {
  if (agent !== "claude-code") {
    process.exitCode = 2;
    if (opts.json) {
      await emitErrorLine("hooks-install", "unsupported_agent", `Only 'claude-code' is supported.`);
    } else {
      console.error(`Unsupported agent '${agent}'. The MVP supports: claude-code.`);
    }
    return;
  }
  if (opts.scope && opts.scope !== "local") {
    process.exitCode = 2;
    if (opts.json) {
      await emitErrorLine("hooks-install", "unsupported_scope", "Only --scope local is supported.");
    } else {
      console.error(`Unsupported --scope '${opts.scope}'. The MVP supports: local.`);
    }
    return;
  }

  const { installClaudeHooks, claudeLocalSettingsPath } = await import("../hooks/claude-code");
  const configPath = claudeLocalSettingsPath(resolveDir(opts.dir));
  try {
    const { events } = installClaudeHooks(configPath, { withStop: opts.withStop });
    if (opts.json) {
      const { emitStep } = await import("../agent/output");
      emitStep({ step: "hooks-install", path: configPath, events });
    } else {
      console.log(`✓ Installed Dosu hooks for Claude Code (${events.join(", ")}).`);
      console.log(`  → ${configPath}`);
      console.log("  Start a new Claude Code session in this project to use them.");
    }
  } catch (err) {
    process.exitCode = 1;
    if (opts.json) {
      await emitErrorLine("hooks-install", "write_failed", errMsg(err));
    } else {
      console.error(`Failed to install hooks: ${errMsg(err)}`);
    }
  }
}

/** `dosu hooks uninstall claude-code` — remove only Dosu-owned hook entries. */
export async function runUninstall(agent: string, opts: LifecycleOptions): Promise<void> {
  if (agent !== "claude-code") {
    process.exitCode = 2;
    if (opts.json) {
      await emitErrorLine(
        "hooks-uninstall",
        "unsupported_agent",
        "Only 'claude-code' is supported.",
      );
    } else {
      console.error(`Unsupported agent '${agent}'. The MVP supports: claude-code.`);
    }
    return;
  }
  const { removeClaudeHooks, claudeLocalSettingsPath } = await import("../hooks/claude-code");
  const configPath = claudeLocalSettingsPath(resolveDir(opts.dir));
  const { removed } = removeClaudeHooks(configPath);
  if (opts.json) {
    const { emitStep } = await import("../agent/output");
    emitStep({ step: "hooks-uninstall", path: configPath, removed });
  } else if (removed) {
    console.log(`✓ Removed Dosu hooks from ${configPath}.`);
  } else {
    console.log("No Dosu hooks were installed.");
  }
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** Build the `doctor` check chain (exported for testing). Read-only; never throws. */
export async function collectDoctorChecks(opts: { dir?: string }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const { claudeLocalSettingsPath, inspectClaudeHooks } = await import("../hooks/claude-code");
  const configPath = claudeLocalSettingsPath(resolveDir(opts.dir));
  const inspection = inspectClaudeHooks(configPath);

  // 1. Config present + valid JSON.
  if (!inspection.fileExists) {
    checks.push({
      name: "config",
      status: "fail",
      detail: `not found: ${configPath} (run 'dosu hooks install claude-code')`,
    });
  } else if (inspection.parseError) {
    checks.push({ name: "config", status: "fail", detail: `invalid JSON: ${configPath}` });
  } else {
    checks.push({ name: "config", status: "ok", detail: configPath });
  }

  // 2. Dosu hooks installed.
  const hasSubmit = inspection.events.includes("UserPromptSubmit");
  const hasPostTool = inspection.events.includes("PostToolUse");
  if (hasSubmit && hasPostTool) {
    checks.push({
      name: "hooks",
      status: "ok",
      detail: `installed: ${inspection.events.join(", ")}`,
    });
  } else {
    checks.push({
      name: "hooks",
      status: "fail",
      detail: "UserPromptSubmit + PostToolUse not both installed",
    });
  }

  // 3. Auth + 4. Deployment.
  const cfg = loadConfig();
  if (isAuthenticated(cfg)) {
    checks.push({ name: "auth", status: "ok", detail: "logged in" });
  } else {
    checks.push({ name: "auth", status: "fail", detail: "not logged in (run 'dosu login')" });
  }
  if (cfg.deployment_id || cfg.mode === MODE_OSS) {
    checks.push({
      name: "deployment",
      status: "ok",
      detail: cfg.deployment_name ?? cfg.deployment_id ?? "oss",
    });
  } else {
    checks.push({
      name: "deployment",
      status: "fail",
      detail: "no deployment selected (run 'dosu setup')",
    });
  }

  // 5. Backend reachable + key valid (best-effort; optimistic on network error).
  if (cfg.api_key && cfg.deployment_id && isAuthenticated(cfg)) {
    const { Client } = await import("../client/client");
    const ok = await new Client(cfg).validateAPIKey(cfg.api_key, cfg.deployment_id);
    checks.push({
      name: "backend",
      status: ok ? "ok" : "fail",
      detail: ok ? "reachable" : "API key rejected",
    });
  } else {
    checks.push({
      name: "backend",
      status: "warn",
      detail: "skipped (not authenticated / no deployment)",
    });
  }

  return checks;
}

/** `dosu hooks doctor` — diagnose the full chain. */
export async function runDoctor(opts: { dir?: string; json?: boolean }): Promise<void> {
  const checks = await collectDoctorChecks(opts);
  if (opts.json) {
    const { emitJSONLine } = await import("../agent/output");
    for (const c of checks) {
      emitJSONLine({ step: `doctor-${c.name}`, status: c.status, detail: c.detail });
    }
  } else {
    const icon = { ok: "✓", warn: "⚠", fail: "✗" };
    for (const c of checks) {
      console.log(`${icon[c.status]} ${c.name}: ${c.detail}`);
    }
  }
  if (checks.some((c) => c.status === "fail")) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function hooksCommand(): Command {
  const cmd = new Command("hooks").description("Dosu knowledge-injection hooks for Claude Code");

  /* v8 ignore start -- thin Commander glue: reads fd 0 and delegates to tested handlers */
  cmd
    .command("user-prompt-submit")
    .description("Hook entrypoint: create a knowledge ticket on prompt submit")
    .action(async () => {
      await runHookEntrypoint("user-prompt-submit", readStdinRaw());
    });

  cmd
    .command("post-tool-use")
    .description("Hook entrypoint: poll and inject ready knowledge once")
    .action(async () => {
      await runHookEntrypoint("post-tool-use", readStdinRaw());
    });

  cmd
    .command("stop")
    .description("Hook entrypoint (opt-in): last-chance non-blocking delivery")
    .action(async () => {
      await runHookEntrypoint("stop", readStdinRaw());
    });

  cmd
    .command("status")
    .description("Show the active Dosu knowledge ticket for this session")
    .option("--json", "Output JSON", false)
    .action((opts: { json?: boolean }) => {
      let input: HookInput = {};
      try {
        const raw = readStdinRaw().trim();
        input = raw ? (JSON.parse(raw) as HookInput) : {};
      } catch {
        input = {};
      }
      runStatus(input, opts);
    });
  /* v8 ignore stop */

  cmd
    .command("install")
    .description("Install Dosu hooks into a coding agent's local config")
    .addArgument(new Argument("<agent>", "coding agent to configure").choices(SUPPORTED_AGENTS))
    .option("--scope <scope>", "Config scope (local only)", "local")
    .option("--dir <path>", "Project root (defaults to current directory)")
    .option("--with-stop", "Also install the optional Stop hook", false)
    .option("--json", "Emit machine-readable JSON", false)
    .addHelpText(
      "after",
      [
        "",
        `Supported agents: ${SUPPORTED_AGENTS.join(", ")}`,
        "",
        "Examples:",
        "  $ dosu hooks install claude-code",
        "  $ dosu hooks install claude-code --with-stop",
        "  $ dosu hooks install claude-code --dir ./my-project",
      ].join("\n"),
    )
    .action((agent: string, opts: LifecycleOptions) => runInstall(agent, opts));

  cmd
    .command("uninstall")
    .description("Remove Dosu hooks from a coding agent's local config (Dosu-owned entries only)")
    .addArgument(new Argument("<agent>", "coding agent to clean up").choices(SUPPORTED_AGENTS))
    .option("--scope <scope>", "Config scope (local only)", "local")
    .option("--dir <path>", "Project root (defaults to current directory)")
    .option("--json", "Emit machine-readable JSON", false)
    .addHelpText(
      "after",
      [
        "",
        `Supported agents: ${SUPPORTED_AGENTS.join(", ")}`,
        "",
        "Example:",
        "  $ dosu hooks uninstall claude-code",
      ].join("\n"),
    )
    .action((agent: string, opts: LifecycleOptions) => runUninstall(agent, opts));

  cmd
    .command("doctor")
    .description("Diagnose Dosu hook config, auth, deployment, and backend connectivity")
    .option("--dir <path>", "Project root (defaults to current directory)")
    .option("--json", "Emit machine-readable JSON", false)
    .action((opts: { dir?: string; json?: boolean }) => runDoctor(opts));

  return cmd;
}
