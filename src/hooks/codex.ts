/** Codex's Dosu hooks, all in `$CODEX_HOME/hooks.json`: the sync trigger and the prompt-time
 * memory hook, each recorded as trusted in config.toml so `codex exec` runs them (codex-trust.ts).
 * Which trigger depends on the installed Codex, so re-running `hooks enable codex` after an
 * upgrade converges on the right set:
 *
 * - 0.160+: SessionEnd, which names the session that ended; that session ships at once. Verified
 *   to fire in `codex exec`. No per-turn Stop as well: it would ship nothing SessionEnd's own run
 *   does not (the live session is inside its quiet period at every Stop), and a session killed
 *   before SessionEnd is caught by the next session's run either way.
 * - older, or no `codex` on PATH: Stop, which fires after every turn; it starts a plain sync that
 *   ships sessions once they have been quiet for five minutes.
 * - 0.116+ (or unknown): UserPromptSubmit, `dosu knowledge context --agent codex --format codex`,
 *   whose additionalContext Codex hands the model. Older versions ignore the unknown event. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeSecureFile } from "../mcp/config-helpers";
import { expandHome, isInstalled } from "../mcp/detect";
import type { HookAgent } from "./agents";
import {
  applyHookTrust,
  CODEX_EVENTS,
  type CodexHookEvent,
  codexHooksKeySource,
  isEmptyPlan,
  planHookTrust,
} from "./codex-trust";
import { contextHookCommand, isDosuContextHookCommand } from "./context";
import {
  addGroupedHook,
  HookConfigError,
  type HookSpec,
  hasGroupedHook,
  isDosuHookCommand,
  readHookConfig,
  removeGroupedHook,
  SYNC_HOOK,
  writeHookConfig,
} from "./formats";

type Version = readonly [number, number, number];

/** SessionEnd exists from 0.145; 0.160 is the first release verified to run it under `codex exec`. */
const SESSION_END_SINCE: Version = [0, 160, 0];
/** UserPromptSubmit (with additionalContext) exists from 0.116. */
const PROMPT_HOOK_SINCE: Version = [0, 116, 0];

/** Codex gives SessionEnd hooks 1s by default; the sync's detach parent reads the payload and
 * spawns its child well inside that, but a cold start on a slow VM may not. 3s is Codex's cap. */
const SESSION_END_TIMEOUT_SEC = 3;

const SESSION_END_SYNC: HookSpec = { ...SYNC_HOOK, timeout: SESSION_END_TIMEOUT_SEC };
const CONTEXT: HookSpec = {
  command: () => contextHookCommand(["--agent", "codex", "--format", "codex"]),
  isOurs: isDosuContextHookCommand,
};

function isOurs(command: unknown): boolean {
  return isDosuHookCommand(command) || isDosuContextHookCommand(command);
}

/** CODEX_HOME when set and non-empty, as Codex reads it. */
function codexHome(): string {
  return process.env.CODEX_HOME || expandHome("~/.codex");
}

/** The `codex` on PATH's version, from `codex --version` ("codex-cli 0.160.0"); null when there
 * is none or it does not answer in time. */
function codexVersion(): Version | null {
  try {
    const out = execFileSync("codex", ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  } catch {
    return null;
  }
}

function atLeast(version: Version, floor: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

/** The hooks Dosu wants for this Codex, by event. */
function plannedHooks(version: Version | null): Partial<Record<CodexHookEvent, HookSpec[]>> {
  const sessionEnd = version !== null && atLeast(version, SESSION_END_SINCE);
  const prompt = version === null || atLeast(version, PROMPT_HOOK_SINCE);
  return {
    ...(sessionEnd ? { SessionEnd: [SESSION_END_SYNC] } : { Stop: [SYNC_HOOK] }),
    ...(prompt ? { UserPromptSubmit: [CONTEXT] } : {}),
  };
}

/** Rewrite hooks.json to hold exactly `planned` of Dosu's hooks, then record their trust (and
 * move the user's own hooks' trust along with any positions that shifted). */
function converge(planned: Partial<Record<CodexHookEvent, HookSpec[]>>): void {
  const path = join(codexHome(), "hooks.json");
  const before = readHookConfig(path);
  const after = structuredClone(before);
  for (const event of CODEX_EVENTS) {
    const wanted = planned[event] ?? [];
    for (const spec of [SYNC_HOOK, CONTEXT]) {
      const want = wanted.find((w) => w.isOurs === spec.isOurs);
      if (want) addGroupedHook(after, event, want);
      else removeGroupedHook(after, event, spec);
    }
  }
  if (!isDeepStrictEqual(before, after)) writeHookConfig(path, after);

  const plan = planHookTrust(before, after, codexHooksKeySource(), isOurs);
  if (isEmptyPlan(plan)) return;
  const configPath = join(codexHome(), "config.toml");
  const text = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  let next: string;
  try {
    next = applyHookTrust(text, plan, configPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new HookConfigError(
      `${reason}. The hooks are in ${path}, but Codex will not run them until you trust them (/hooks)`,
    );
  }
  if (next !== text) writeSecureFile(configPath, next);
}

export function codexHookAgent(): HookAgent {
  const configPath = () => join(codexHome(), "hooks.json");
  return {
    id: () => "codex",
    name: () => "Codex",
    isInstalled: () => isInstalled([codexHome()]),
    configPath,
    isEnabled: () => {
      const config = readHookConfig(configPath());
      return hasGroupedHook(config, "SessionEnd") || hasGroupedHook(config, "Stop");
    },
    enable: () => converge(plannedHooks(codexVersion())),
    disable: () => converge({}),
    enableNote: () =>
      "Codex runs the Dosu hooks without asking: they are marked trusted in its config.toml.",
  };
}
