/** Codex hook trust. Codex (0.129+) runs a user hook only once `config.toml` records the hook's
 * hash under `[hooks.state."<hooks.json path>:<event>:<group>:<handler>"] trusted_hash`, and
 * `codex exec` never asks: an untrusted hook simply does not run. So the hooks Dosu installs are
 * recorded here exactly as Codex's own review would record them (codex-rs/hooks/src/engine/
 * discovery.rs `hook_hash`, codex-rs/config/src/fingerprint.rs `version_for_toml`; checked
 * against `codex app-server` hooks/list on 0.140 and 0.160).
 *
 * config.toml is the user's file: it is edited as text, touching only the `hooks.state` tables
 * of the hooks whose positions Dosu changed, and every edit is checked by parsing the result --
 * anything a text edit cannot express exactly is refused rather than written. */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { HookConfigError } from "./formats";

/** The hook events Dosu installs into, with the label Codex keys their state by. */
const CODEX_EVENT_LABELS = {
  Stop: "stop",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
} as const;
export type CodexHookEvent = keyof typeof CODEX_EVENT_LABELS;
export const CODEX_EVENTS = Object.keys(CODEX_EVENT_LABELS) as CodexHookEvent[];

/** Codex's timeouts, in seconds: SessionEnd defaults to 1 and is capped at 3 (it runs during
 * teardown); every other event defaults to 600. The hash covers the normalized value. */
function normalizedTimeout(event: CodexHookEvent, timeout: unknown): number {
  const given = typeof timeout === "number" && Number.isInteger(timeout) ? timeout : undefined;
  if (event === "SessionEnd") return Math.min(Math.max(given ?? 1, 1), 3);
  return Math.max(given ?? 600, 1);
}

/** JSON with object keys sorted at every level and no whitespace: Codex's `canonical_json`. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// biome-ignore lint/suspicious/noExplicitAny: hook config files are arbitrary JSON
type JsonConfig = Record<string, any>;

/** The `trusted_hash` Codex computes for a command hook: sha256 over the normalized hook (event,
 * the group's matcher where the event has one, and the handler with defaults filled in). */
function codexHookHash(event: CodexHookEvent, handler: JsonConfig, matcher?: unknown): string {
  const identity = {
    event_name: CODEX_EVENT_LABELS[event],
    // Stop and UserPromptSubmit ignore matchers; of Dosu's events only SessionEnd has one.
    ...(event === "SessionEnd" && typeof matcher === "string" ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: handler.command,
        timeout: normalizedTimeout(event, handler.timeout),
        async: handler.async === true,
        ...(typeof handler.statusMessage === "string"
          ? { statusMessage: handler.statusMessage }
          : {}),
      },
    ],
  };
  return `sha256:${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
}

/** The hooks.json path as Codex names it in state keys: CODEX_HOME canonicalized (Codex resolves
 * symlinks in it), else `~/.codex` taken as is. */
export function codexHooksKeySource(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const codexHome = env.CODEX_HOME;
  if (!codexHome) return join(resolve(home), ".codex", "hooks.json");
  try {
    return join(realpathSync(codexHome), "hooks.json");
  } catch {
    return join(resolve(codexHome), "hooks.json");
  }
}

interface PlacedHook {
  key: string;
  ours: boolean;
  hash: string;
}

/** Every handler of `event` in a hooks.json, in order, with the state key its position gives it. */
function placedHooks(
  config: JsonConfig,
  event: CodexHookEvent,
  keySource: string,
  isOurs: (command: unknown) => boolean,
): PlacedHook[] {
  const groups = config.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  const placed: PlacedHook[] = [];
  groups.forEach((group, groupIndex) => {
    const handlers = group?.hooks;
    if (!Array.isArray(handlers)) return;
    handlers.forEach((handler, handlerIndex) => {
      placed.push({
        key: `${keySource}:${CODEX_EVENT_LABELS[event]}:${groupIndex}:${handlerIndex}`,
        ours: isOurs(handler?.command),
        hash: codexHookHash(event, handler ?? {}, group?.matcher),
      });
    });
  });
  return placed;
}

/** How the `hooks.state` tables follow a hooks.json edit that added, moved or removed Dosu's
 * handlers. State keys are positional, so the user's own handlers behind a removed one shift too:
 * their tables move with them, or Codex would ask to trust them again. */
export interface TrustPlan {
  /** State table at the key -> the key its handler now has (Dosu's and the user's). */
  moves: Map<string, string>;
  /** Tables of Dosu handlers that are gone. */
  drops: Set<string>;
  /** Dosu handlers' keys -> the hash to record as trusted. */
  trust: Map<string, string>;
  /** Every key a handler holds after the edit: a table there that no handler brought along is
   * left over from some earlier handler and must not pass for this one's. */
  occupied: Set<string>;
}

export function planHookTrust(
  before: JsonConfig,
  after: JsonConfig,
  keySource: string,
  isOurs: (command: unknown) => boolean,
): TrustPlan {
  const plan: TrustPlan = {
    moves: new Map(),
    drops: new Set(),
    trust: new Map(),
    occupied: new Set(),
  };
  for (const event of CODEX_EVENTS) {
    const was = placedHooks(before, event, keySource, isOurs);
    const now = placedHooks(after, event, keySource, isOurs);
    for (const hook of now) plan.occupied.add(hook.key);
    // Dosu edits only its own handlers, so the user's keep their order: pair them by rank.
    const userWas = was.filter((h) => !h.ours);
    const userNow = now.filter((h) => !h.ours);
    userNow.forEach((hook, i) => {
      const from = userWas[i]?.key;
      if (from !== undefined) plan.moves.set(from, hook.key);
    });
    const oursWas = was.filter((h) => h.ours);
    const oursNow = now.filter((h) => h.ours);
    for (let i = 0; i < Math.max(oursWas.length, oursNow.length); i++) {
      const from = oursWas[i]?.key;
      const to = oursNow[i];
      if (to === undefined) {
        if (from !== undefined) plan.drops.add(from);
        continue;
      }
      // A handler that stays keeps its table (an `enabled = false` the user set in Codex).
      if (from !== undefined) plan.moves.set(from, to.key);
      plan.trust.set(to.key, to.hash);
    }
  }
  return plan;
}

export function isEmptyPlan(plan: TrustPlan): boolean {
  return (
    plan.trust.size === 0 &&
    plan.drops.size === 0 &&
    [...plan.moves].every(([from, to]) => from === to)
  );
}

type TomlTable = Record<string, unknown>;

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** The `hooks.state` key a line opens a table for, or null when it opens anything else. Parsed
 * by the TOML parser itself, so quoting and escapes in the key are TOML's, not a regex's. */
function stateTableKey(line: string): string | null {
  const text = line.trim();
  if (!text.startsWith("[") || text.startsWith("[[")) return null;
  let node: unknown;
  try {
    node = parse(text);
  } catch {
    return null;
  }
  const path: string[] = [];
  while (isTable(node)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) break;
    path.push(keys[0]);
    node = node[keys[0]];
  }
  return path.length === 3 && path[0] === "hooks" && path[1] === "state" ? path[2] : null;
}

/** Whether Codex would run every Dosu handler in a hooks.json: each one's state table in
 * config.toml records the hash the handler has now. A config.toml that does not parse trusts
 * nothing (Codex will not start on it either). */
export function dosuHooksTrusted(
  config: JsonConfig,
  configText: string,
  keySource: string,
  isOurs: (command: unknown) => boolean,
): boolean {
  let state: TomlTable;
  try {
    const hooks = parse(configText).hooks;
    state = isTable(hooks) && isTable(hooks.state) ? hooks.state : {};
  } catch {
    return false;
  }
  return CODEX_EVENTS.every((event) =>
    placedHooks(config, event, keySource, isOurs)
      .filter((hook) => hook.ours)
      .every((hook) => {
        const entry = state[hook.key];
        return isTable(entry) && entry.trusted_hash === hook.hash;
      }),
  );
}

/** Whether a line opens any table, so a section ends there. */
function opensTable(line: string): boolean {
  const text = line.trim();
  if (text.startsWith("[[")) return true;
  if (!text.startsWith("[")) return false;
  try {
    parse(text);
    return true;
  } catch {
    return false;
  }
}

function stateHeader(key: string): string {
  return `[hooks.state.${JSON.stringify(key)}]`;
}

function trustedHashLine(hash: string): string {
  return `trusted_hash = ${JSON.stringify(hash)}`;
}

const TRUSTED_HASH_LINE = /^\s*trusted_hash\s*=/;

/** Drop empty tables, which a text edit leaves or removes at will. */
function pruned(value: unknown): unknown {
  if (!isTable(value)) return value;
  const out: TomlTable = {};
  for (const [key, child] of Object.entries(value)) {
    const next = pruned(child);
    if (isTable(next) && Object.keys(next).length === 0) continue;
    out[key] = next;
  }
  return out;
}

/** What the plan means for the parsed file: the yardstick the text edit is checked against. */
function expectedState(original: TomlTable, plan: TrustPlan): TomlTable {
  const hooks = isTable(original.hooks) ? original.hooks : {};
  const state = isTable(hooks.state) ? hooks.state : {};
  const next: TomlTable = { ...state };
  for (const from of plan.moves.keys()) delete next[from];
  for (const key of plan.drops) delete next[key];
  for (const key of plan.occupied) delete next[key];
  for (const [from, to] of plan.moves) if (isTable(state[from])) next[to] = { ...state[from] };
  for (const [key, hash] of plan.trust) {
    next[key] = { ...(isTable(next[key]) ? next[key] : {}), trusted_hash: hash };
  }
  return { ...original, hooks: { ...hooks, state: next } };
}

/** Apply a trust plan to config.toml's text. Throws HookConfigError when the file does not parse
 * or keeps its hook state in a shape a text edit cannot follow exactly (inline tables, dotted
 * keys); the file is never half-edited. */
export function applyHookTrust(text: string, plan: TrustPlan, path: string): string {
  let original: TomlTable;
  try {
    original = parse(text);
  } catch {
    throw new HookConfigError(`${path} is not valid TOML; fix it, then retry`);
  }

  const lines = text.split("\n");
  const out: string[] = [];
  const written = new Set<string>();
  let section: "keep" | "drop" | { trust?: string; wrote: boolean; headerAt: number } = "keep";
  const closeSection = () => {
    // A moved table with no trusted_hash line yet gets one right under its header.
    if (typeof section === "object" && section.trust !== undefined && !section.wrote) {
      out.splice(section.headerAt + 1, 0, trustedHashLine(section.trust));
    }
  };
  for (const line of lines) {
    if (opensTable(line)) {
      closeSection();
      const key = stateTableKey(line);
      const moved = key === null ? undefined : plan.moves.get(key);
      if (key !== null && moved !== undefined) {
        out.push(stateHeader(moved));
        written.add(moved);
        section = { trust: plan.trust.get(moved), wrote: false, headerAt: out.length - 1 };
        continue;
      }
      if (key !== null && (plan.drops.has(key) || plan.occupied.has(key))) {
        section = "drop";
        continue;
      }
      section = "keep";
    }
    if (section === "drop") continue;
    if (
      typeof section === "object" &&
      section.trust !== undefined &&
      TRUSTED_HASH_LINE.test(line)
    ) {
      out.push(trustedHashLine(section.trust));
      section.wrote = true;
      continue;
    }
    out.push(line);
  }
  closeSection();

  // A new table goes at the end behind one newline of its own: a blank line after a final
  // newline, the line break a file without one lacks. Dropping the table later takes exactly that
  // newline with it, so `disable` gives back the file `enable` found.
  let result = out.join("\n");
  for (const [key, hash] of plan.trust) {
    if (written.has(key)) continue;
    if (result !== "") result += "\n";
    result += `${stateHeader(key)}\n${trustedHashLine(hash)}\n`;
  }

  let parsed: TomlTable | null = null;
  try {
    parsed = parse(result);
  } catch {
    parsed = null;
  }
  if (!parsed || !isDeepStrictEqual(pruned(parsed), pruned(expectedState(original, plan)))) {
    throw new HookConfigError(
      `${path} keeps Codex's hook state in a form Dosu cannot edit safely; left unchanged`,
    );
  }
  return result;
}
