/** OpenCode has no command hooks; its extension point is a plugin, a JS module in its config dir
 * whose hooks run inside the opencode process. Dosu's plugin is generated here and does three
 * things, each through the same `dosu` commands the other agents' hooks run:
 *
 * - Session end. A session's definitive end is the exit of the opencode process that ran it,
 *   however it exits: `opencode run` finishing or interrupted, the TUI quitting, or a server
 *   (`opencode serve`, and the SDK, web UI, and `run --attach` built on it) stopped by any signal,
 *   SIGKILL included. opencode's `dispose` hook marks none of that reliably: a server killed by a
 *   signal never runs it, and a live process runs it whenever it reloads an instance (`/connect`,
 *   a config change), which ends nothing. Nor does `session.idle`, which fires after every turn.
 *   So the first session to run a turn here starts a detached watcher that reads session ids from
 *   a pipe only this process writes to. When the process exits, the kernel closes the pipe, and
 *   the watcher runs `dosu knowledge sync --quiet --detach` once with `--ended opencode:<id>` for
 *   every session that ran here. A session left idle in a long-lived TUI or server ships with a
 *   plain sync the plugin runs once that session is past the sync's quiet period.
 * - Prompt-time memory. `chat.message` runs before a prompt is saved or sent; the plugin asks
 *   `dosu knowledge context --agent opencode --format plain` and appends the digest to the user
 *   message as a synthetic text part flagged `dosu_memory`, which the shipper leaves out of the
 *   transcript. Incognito sessions and subagents' sessions are not asked about.
 * - Incognito. `/dosu-incognito` is an opencode custom command (src/incognito/agents.ts); its
 *   expansion carries the marker, which the plugin and the sync both read.
 *
 * The plugin is plain JavaScript importing only node builtins. opencode 1.18 still waits, before it
 * loads any local plugin, for the npm install of `@opencode-ai/plugin` it starts in its config dir
 * until that has a node_modules (one registry fetch; with no registry reachable, every start waits
 * for the install to fail), but this plugin never imports it. */

import { existsSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getIncognitoAgent } from "../incognito/agents";
import { writeSecureFile } from "../mcp/config-helpers";
import { isInstalled, isOnPath } from "../mcp/detect";
import { INCOGNITO_MARKER } from "../sync/incognito";
import { DEFAULT_QUIET_PERIOD_MS } from "../sync/state";
import type { HookAgent } from "./agents";
import { devEnvAssignments, devSelfCommand, HookConfigError, hookCommand } from "./formats";

/** Marks the plugin file as Dosu's; a user's own `dosu.js` is never rewritten or removed. */
const PLUGIN_MARKER = "dosu-opencode-plugin";

const CONTEXT_ARGS = "knowledge context --agent opencode --format plain";

/** opencode's global config and data dirs, which it finds through the XDG variables on every
 * platform. */
function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

function pluginPath(): string {
  return join(configDir(), "plugin", "dosu.js");
}

/** Dev installs pin this working copy with env inline, as the sync hook's command does. */
function contextCommand(): string {
  if (process.env.DOSU_DEV !== "true") return `dosu ${CONTEXT_ARGS}`;
  return `${devEnvAssignments().join(" ")} ${devSelfCommand()} ${CONTEXT_ARGS}`;
}

/** The watcher's script: one session id per line until the plugin's process exits, then one sync
 * naming each as ended. The plugin writes only ids that are safe on a command line. */
function endWatcherScript(): string {
  return [
    'ended=""',
    'while IFS= read -r id; do ended="$ended --ended opencode:$id"; done',
    `[ -z "$ended" ] || ${hookCommand()} $ended </dev/null`,
  ].join("\n");
}

/** The plugin module. Commands run through /bin/sh, like every other agent's hook commands. */
function opencodePluginSource(): string {
  return `// Dosu for OpenCode (${PLUGIN_MARKER} v1). Written by \`dosu knowledge hooks enable opencode\`,
// removed by \`dosu knowledge hooks disable opencode\`; edits are overwritten on the next enable.
// Ships each session that ran in this opencode process to Dosu memory once the process exits,
// and adds task memory to prompts that warrant it. Imports only node builtins.
import { spawn } from "node:child_process";

const SYNC_COMMAND = ${JSON.stringify(hookCommand())};
const CONTEXT_COMMAND = ${JSON.stringify(contextCommand())};
const INCOGNITO_MARKER = ${JSON.stringify(INCOGNITO_MARKER)};
// Reads one session id per line until this process exits, then reports each one ended.
const END_WATCHER = ${JSON.stringify(endWatcherScript())};
// The sync holds a session back until it has been quiet this long; the margin covers opencode's
// last writes to a session after its turn goes idle.
const QUIET_SYNC_MS = ${DEFAULT_QUIET_PERIOD_MS + 30_000};
// Past this the prompt is waiting on Dosu, and a late digest is not worth a stalled prompt.
const CONTEXT_TIMEOUT_MS = 10000;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

// Per process, not per plugin instance: opencode imports this module once and starts the plugin
// from it for each project instance, and again whenever it reloads one.
const ran = new Set();
const created = new Set();
const subagents = new Set();
const incognito = new Set();
let watcher;
let lastIdle = 0;
let quietSync;
let partCounter = 0;
let partMs = 0;

/** Start a shell command in its own session, so it outlives this process and its terminal. */
function detached(command, stdin) {
  try {
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: [stdin, "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.unref();
    return child;
  } catch {
    return undefined;
  }
}

/** A session ran a turn here. The watcher holds the read end of a pipe whose write end only this
 * process has, so however the process exits, a kill included, the watcher's input ends then and
 * not before: an instance reload is not an exit. */
function ranHere(sessionID) {
  if (!SESSION_ID.test(sessionID) || ran.has(sessionID)) return;
  ran.add(sessionID);
  watcher ??= detached(END_WATCHER, "pipe");
  watcher?.stdin?.write(sessionID + "\\n");
}

/** A plain sync once the latest session to go idle is past the quiet period, again later if
 * another turn went idle meanwhile. Never holds the process open. */
function syncWhenQuiet(delay) {
  quietSync = setTimeout(() => {
    quietSync = undefined;
    detached(SYNC_COMMAND, "ignore");
    const wait = lastIdle + QUIET_SYNC_MS - Date.now();
    if (wait > 0) syncWhenQuiet(wait);
  }, delay);
  quietSync.unref?.();
}

/** Run a shell command with JSON on stdin; resolves to its stdout, "" on any failure. */
function run(command, input, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      finish();
    }, timeoutMs);
    try {
      child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"] });
      child.on("error", finish);
      child.on("close", finish);
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    } catch {
      finish();
    }
  });
}

/** An id opencode would mint for a part now: ids ascend with time, and a message's parts are
 * ordered by id, so this one follows everything the user's message already holds. */
function partId() {
  const now = Date.now();
  if (now !== partMs) {
    partMs = now;
    partCounter = 0;
  }
  partCounter += 1;
  const time = (BigInt(now) * 4096n + BigInt(partCounter)).toString(16).padStart(12, "0");
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let random = "";
  for (let i = 0; i < 14; i++) random += chars[Math.floor(Math.random() * 62)];
  return "prt_" + time.slice(-12) + random;
}

function hasMarker(parts) {
  return (parts ?? []).some((p) => typeof p?.text === "string" && p.text.includes(INCOGNITO_MARKER));
}

export const DosuMemory = async ({ client, directory }) => {
  /** A session resumed in this process may have gone incognito before it. */
  async function wentIncognitoBefore(sessionID) {
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      return (Array.isArray(res?.data) ? res.data : []).some((m) => hasMarker(m?.parts));
    } catch {
      return false;
    }
  }

  return {
    event: async ({ event }) => {
      const props = event?.properties ?? {};
      if (event?.type === "session.created") {
        const info = props.info ?? {};
        if (typeof info.id !== "string") return;
        created.add(info.id);
        if (info.parentID) subagents.add(info.id);
        return;
      }
      if (event?.type !== "session.idle" || typeof props.sessionID !== "string") return;
      ranHere(props.sessionID);
      lastIdle = Date.now();
      if (!quietSync) syncWhenQuiet(QUIET_SYNC_MS);
    },

    "chat.message": async (input, output) => {
      const sessionID = input?.sessionID;
      if (typeof sessionID !== "string") return;
      ranHere(sessionID);
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      if (hasMarker(parts)) incognito.add(sessionID);
      if (incognito.has(sessionID) || subagents.has(sessionID)) return;
      if (!created.has(sessionID)) {
        created.add(sessionID);
        if (await wentIncognitoBefore(sessionID)) {
          incognito.add(sessionID);
          return;
        }
      }
      const prompt = parts
        .filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
        .map((p) => p.text)
        .join("\\n")
        .trim();
      if (!prompt) return;
      const digest = (
        await run(CONTEXT_COMMAND, { prompt, session_id: sessionID, cwd: directory }, CONTEXT_TIMEOUT_MS)
      ).trim();
      if (!digest || typeof output?.message?.id !== "string") return;
      parts.push({
        id: partId(),
        sessionID,
        messageID: output.message.id,
        type: "text",
        text: digest,
        synthetic: true,
        metadata: { dosu_memory: true },
      });
    },
  };
};
`;
}

function isOurs(path: string): boolean {
  try {
    return readFileSync(path, "utf-8").includes(PLUGIN_MARKER);
  } catch {
    return false;
  }
}

export function opencodeHookAgent(): HookAgent {
  return {
    id: () => "opencode",
    name: () => "OpenCode",
    isInstalled: () => isInstalled([configDir(), dataDir()]) || isOnPath("opencode"),
    configPath: pluginPath,
    isEnabled: () => isOurs(pluginPath()),
    enable: () => {
      const path = pluginPath();
      const source = opencodePluginSource();
      if (existsSync(path) && !isOurs(path)) {
        throw new HookConfigError(`${path} is not Dosu's plugin; rename or remove it, then retry`);
      }
      if (!existsSync(path) || readFileSync(path, "utf-8") !== source) {
        writeSecureFile(path, source);
      }
      getIncognitoAgent("opencode")?.enable();
    },
    disable: () => {
      const path = pluginPath();
      if (isOurs(path)) unlinkSync(path);
      getIncognitoAgent("opencode")?.disable();
      // enable() may have made these on a machine where opencode never ran, and left there empty
      // they would make it look installed. Anything in one, opencode's own files included, keeps it.
      for (const dir of [join(configDir(), "plugin"), join(configDir(), "command"), configDir()]) {
        try {
          rmdirSync(dir);
        } catch {
          // Not empty, or not there.
        }
      }
    },
    enableNote: () =>
      "Restart running OpenCode sessions to load the plugin. Before loading any plugin, OpenCode installs @opencode-ai/plugin from npm into its config dir once (Dosu's plugin does not use it).",
  };
}
