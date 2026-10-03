/** OpenCode has no command hooks; its extension point is a plugin, a JS module in its config dir
 * whose hooks run inside the opencode process. Dosu's plugin is generated here and does three
 * things, each through the same `dosu` commands the other agents' hooks run:
 *
 * - Session end. A session's definitive end is the shutdown of the opencode process that ran it:
 *   the plugin's `dispose` hook, which opencode awaits on exit (`opencode run` finishing, the TUI
 *   quitting on Ctrl+C, SIGTERM, or SIGHUP, a server stopping). `session.idle` is not an end: it
 *   fires after every turn in the TUI, and after every subagent's turn too. So at dispose the
 *   plugin runs `dosu knowledge sync --quiet --detach` once per session that ran a turn in this
 *   process, with an `opencode.session.end` payload the sync turns into `--ended`. A turn going
 *   idle runs a plain sync (no session named) at most every five minutes, so sessions left idle in
 *   a long-lived TUI or server ship without waiting for it to exit.
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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getIncognitoAgent } from "../incognito/agents";
import { writeSecureFile } from "../mcp/config-helpers";
import { isInstalled } from "../mcp/detect";
import { INCOGNITO_MARKER } from "../sync/incognito";
import type { HookAgent } from "./agents";
import { devEnvAssignments, devSelfCommand, hookCommand } from "./formats";

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

/** The plugin module. Commands run through /bin/sh, like every other agent's hook commands. */
function opencodePluginSource(): string {
  return `// Dosu for OpenCode (${PLUGIN_MARKER} v1). Written by \`dosu knowledge hooks enable opencode\`,
// removed by \`dosu knowledge hooks disable opencode\`; edits are overwritten on the next enable.
// Ships each session that ran in this opencode process to Dosu memory when the process shuts
// down, and adds task memory to prompts that warrant it. Imports only node builtins.
import { spawn } from "node:child_process";

const SYNC_COMMAND = ${JSON.stringify(hookCommand())};
const CONTEXT_COMMAND = ${JSON.stringify(contextCommand())};
const INCOGNITO_MARKER = ${JSON.stringify(INCOGNITO_MARKER)};
// A turn going idle runs a plain sync at most this often: the sync's own quiet period.
const IDLE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// Past this the prompt is waiting on Dosu, and a late digest is not worth a stalled prompt.
const CONTEXT_TIMEOUT_MS = 10000;
// The sync's --detach parent reads its stdin and hands off to a detached run within a second.
const SYNC_TIMEOUT_MS = 5000;

let lastIdleSync = Date.now();
let partCounter = 0;
let partMs = 0;

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
  const ran = new Set();
  const created = new Set();
  const subagents = new Set();
  const incognito = new Set();

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
      ran.add(props.sessionID);
      if (Date.now() - lastIdleSync < IDLE_SYNC_INTERVAL_MS) return;
      lastIdleSync = Date.now();
      const payload = {
        agent: "opencode",
        hook_event_name: "opencode.session.idle",
        session_id: props.sessionID,
        cwd: directory,
      };
      void run(SYNC_COMMAND, payload, SYNC_TIMEOUT_MS);
    },

    "chat.message": async (input, output) => {
      const sessionID = input?.sessionID;
      if (typeof sessionID !== "string") return;
      ran.add(sessionID);
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

    dispose: async () => {
      const ended = [...ran];
      ran.clear();
      for (const sessionID of ended) {
        const payload = {
          agent: "opencode",
          hook_event_name: "opencode.session.end",
          session_id: sessionID,
          cwd: directory,
        };
        await run(SYNC_COMMAND, payload, SYNC_TIMEOUT_MS);
      }
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
    isInstalled: () => isInstalled([configDir(), dataDir()]),
    configPath: pluginPath,
    isEnabled: () => isOurs(pluginPath()),
    enable: () => {
      const path = pluginPath();
      const source = opencodePluginSource();
      if (!existsSync(path) || readFileSync(path, "utf-8") !== source) {
        writeSecureFile(path, source);
      }
      getIncognitoAgent("opencode")?.enable();
    },
    disable: () => {
      const path = pluginPath();
      if (isOurs(path)) unlinkSync(path);
      getIncognitoAgent("opencode")?.disable();
    },
    enableNote: () =>
      "Restart running OpenCode sessions to load the plugin. Before loading any plugin, OpenCode installs @opencode-ai/plugin from npm into its config dir once (Dosu's plugin does not use it).",
  };
}
