/**
 * Per-session hook ticket state.
 *
 * State lives in the CLI config dir (NOT the repo), so prompt-derived data and
 * cwd never land inside a git-tracked tree. One file per Claude Code session,
 * keyed by a sanitized `session_id`. All IO is best-effort: a read failure
 * returns `null` and a write failure is swallowed — a hook must never throw.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/config";

/** Steady-state local lifecycle of a ticket. `ready` is transient and never persisted. */
export type TicketLocalStatus = "pending" | "delivered" | "failed" | "expired";

export interface TicketState {
  ticketId: string;
  sessionId: string;
  turnId?: string;
  status: TicketLocalStatus;
  createdAt: number;
  expiresAt: number;
  /** Last poll attempt (epoch ms). Drives the cooldown gate. Undefined until first poll. */
  lastCheckedAt?: number;
  /** Set once at the single delivery moment. Its presence is the idempotency latch. */
  deliveredAt?: number;
}

/**
 * Resolve the directory that holds per-session state files.
 *
 * `DOSU_HOOK_STATE_DIR` overrides everything (used by tests). Otherwise state
 * lives under the CLI config dir (`~/.config/dosu-cli/hooks/`, or the
 * `dosu-cli-dev` variant when `DOSU_DEV=true`).
 */
export function getStateDir(): string {
  return process.env.DOSU_HOOK_STATE_DIR ?? join(getConfigDir(), "hooks");
}

/** Replace any character outside a conservative allow-list so a session id is filename-safe. */
export function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function stateFile(sessionId: string): string {
  return join(getStateDir(), `${sanitize(sessionId)}.json`);
}

/** Load the active ticket state for a session, or `null` if none / unreadable. */
export function loadState(sessionId: string): TicketState | null {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8")) as TicketState;
  } catch {
    return null;
  }
}

/** Persist ticket state with owner-only permissions. Never throws. */
export function saveState(state: TicketState): void {
  try {
    const file = stateFile(state.sessionId);
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // best-effort; a failed state write must not disrupt the agent
  }
}

/** Remove a session's state file. Never throws. */
export function clearState(sessionId: string): void {
  try {
    rmSync(stateFile(sessionId), { force: true });
  } catch {
    // best-effort
  }
}
