/**
 * Per-session hook ticket state.
 *
 * State lives in the CLI config dir (NOT the repo), so prompt-derived data and
 * cwd never land inside a git-tracked tree. One file per Claude Code session,
 * keyed by a sanitized `session_id`. All IO is best-effort: a read failure
 * returns `null` and a write failure is swallowed — a hook must never throw.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/config";

/** Steady-state local lifecycle of a ticket. `ready` is transient and never persisted. */
type TicketLocalStatus = "pending" | "delivered" | "failed" | "expired";

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

/** Atomically take exclusive ownership of a session's ticket state.
 *
 * `rename(2)` is atomic, so when several hook processes race, exactly one gets
 * the state back and the rest get `null` (no state, or another holder). The
 * state is parked in a `.claim` file until `releaseState`; a holder that
 * crashes leaves only a stale park that the next claim overwrites. Never
 * throws.
 */
export function claimState(sessionId: string): TicketState | null {
  const file = stateFile(sessionId);
  try {
    renameSync(file, `${file}.claim`);
    return JSON.parse(readFileSync(`${file}.claim`, "utf8")) as TicketState;
  } catch {
    return null;
  }
}

/** Release a claim taken by `claimState`. Only the claim winner may call this.
 *
 * With a state, restores it — but never over a newer state written meanwhile
 * (`wx` = exclusive create), so a finished old ticket can't resurrect over a
 * newly registered one. With `null`, the parked state is discarded. Never
 * throws.
 */
export function releaseState(sessionId: string, state: TicketState | null): void {
  const file = stateFile(sessionId);
  if (state) {
    try {
      writeFileSync(file, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    } catch {
      // a newer state owns the slot (or the write failed) — discard ours
    }
  }
  try {
    rmSync(`${file}.claim`, { force: true });
  } catch {
    // best-effort
  }
}
