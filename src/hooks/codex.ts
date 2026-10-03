/** Codex's Dosu hooks, all in `$CODEX_HOME/hooks.json`: the sync triggers and the prompt-time
 * memory hook, each recorded as trusted in config.toml so `codex exec` runs them (codex-trust.ts).
 * Which hooks depends on the installed Codex, so re-running `hooks enable codex` after an upgrade
 * converges on the right set:
 *
 * - always: Stop, which fires after every turn and starts a plain sync that ships sessions once
 *   they have been quiet for five minutes. hooks.json is read by every Codex that shares the home
 *   (the CLI on PATH, another install, the IDE extension, the desktop app), and one without
 *   SessionEnd skips that event silently, so Stop is what keeps its sessions shipping. It is also
 *   the backstop for a session that never fires SessionEnd (`codex exec` killed with SIGTERM).
 * - 0.160+: SessionEnd as well, which names the session that ended; that session ships at once.
 *   Verified to fire in `codex exec`.
 * - 0.116+ (or unknown): UserPromptSubmit, `dosu knowledge context --agent codex --format codex`,
 *   whose additionalContext Codex hands the model. Older versions ignore the unknown event. */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeSecureFile } from "../mcp/config-helpers";
import { expandHome, isInstalled } from "../mcp/detect";
import type { HookAgent } from "./agents";
import {
  applyHookTrust,
  CODEX_EVENTS,
  type CodexHookEvent,
  codexHooksKeySource,
  dosuHooksTrusted,
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

/** Codex is installed when its home exists or `codex` is on PATH. Codex creates its home on its
 * first run, and a freshly provisioned machine (a throwaway VM) sets up Dosu before that run: the
 * hooks and the MCP entry must already be there when it happens. */
export function codexInstalled(): boolean {
  if (isInstalled([codexHome()])) return true;
  const path = process.env.PATH ?? "";
  return path.split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, "codex")));
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
    Stop: [SYNC_HOOK],
    ...(sessionEnd ? { SessionEnd: [SESSION_END_SYNC] } : {}),
    ...(prompt ? { UserPromptSubmit: [CONTEXT] } : {}),
  };
}

function hooksPath(): string {
  return join(codexHome(), "hooks.json");
}

function configPath(): string {
  return join(codexHome(), "config.toml");
}

function readConfigText(): string {
  const path = configPath();
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

/** Rewrite hooks.json to hold exactly `planned` of Dosu's hooks and record their trust (moving
 * the user's own hooks' trust along with any positions that shifted). Both edits are worked out
 * before either file is written, so a config.toml Dosu cannot edit leaves hooks.json alone too:
 * hooks Codex would not run are never installed. */
function converge(planned: Partial<Record<CodexHookEvent, HookSpec[]>>): void {
  const path = hooksPath();
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

  const plan = planHookTrust(before, after, codexHooksKeySource(), isOurs);
  const text = readConfigText();
  let next = text;
  if (!isEmptyPlan(plan)) {
    try {
      next = applyHookTrust(text, plan, configPath());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new HookConfigError(
        `${reason}. Nothing was changed: Codex runs Dosu's hooks only once their trust is recorded there`,
      );
    }
  }
  if (!isDeepStrictEqual(before, after)) {
    if (isEmptyHookConfig(after)) rmSync(path, { force: true });
    else writeKeepingMode(path, `${JSON.stringify(after, null, 2)}\n`);
  }
  if (next !== text) {
    if (next === "") rmSync(configPath(), { force: true });
    else writeKeepingMode(configPath(), next);
  }
}

/** A hooks.json with no hooks left in it, which `disable` deletes rather than leave behind. */
function isEmptyHookConfig(config: Record<string, unknown>): boolean {
  const keys = Object.keys(config);
  if (keys.some((key) => key !== "hooks")) return false;
  const hooks = config.hooks;
  return hooks === undefined || (isPlainObject(hooks) && Object.keys(hooks).length === 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex's files are the user's: an existing one keeps its mode; a new one is owner-only. */
function writeKeepingMode(path: string, content: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o7777 : undefined;
  writeSecureFile(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

export function codexHookAgent(): HookAgent {
  return {
    id: () => "codex",
    name: () => "Codex",
    isInstalled: codexInstalled,
    configPath: hooksPath,
    // Installed and trusted: `codex exec` skips a hook whose trust is not recorded.
    isEnabled: () => {
      const config = readHookConfig(hooksPath());
      if (!hasGroupedHook(config, "Stop") && !hasGroupedHook(config, "SessionEnd")) return false;
      return dosuHooksTrusted(config, readConfigText(), codexHooksKeySource(), isOurs);
    },
    enable: () => converge(plannedHooks(codexVersion())),
    disable: () => converge({}),
    enableNote: () =>
      "Codex runs the Dosu hooks without asking: they are marked trusted in its config.toml.",
  };
}
