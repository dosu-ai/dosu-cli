/** Dosu for pi: pi has no hook config, so everything Dosu needs from a pi session lives in one
 * extension file, `<agent dir>/extensions/dosu.ts`, which pi loads on start. A single file rather
 * than a pi package: `pi install` would need pi on PATH, network for an npm source or a second
 * directory for a local one, and an edit to pi's settings.json to undo; a file in the extensions
 * folder is discovered as is, works offline in a throwaway VM, and disabling it is deleting it.
 *
 * The extension shells out to the `dosu` CLI for everything, so it carries no credentials and
 * stays correct across CLI upgrades: the CLI resolves the account, project and branch itself.
 * Pi started with `--no-extensions` (or `-ne`) loads none of it, and such sessions only ship on
 * the next sync some other trigger starts. */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeSecureFile } from "../mcp/config-helpers";
import { expandHome, isInstalled, isOnPath } from "../mcp/detect";
import { selfInvocation } from "../sync/detach";
import {
  INCOGNITO_COMMAND_NAME,
  INCOGNITO_MARKER,
  PI_INCOGNITO_ENTRY_TYPE,
} from "../sync/incognito";
import type { HookAgent } from "./agents";
import { devEnvAssignments, HookConfigError } from "./formats";

/** First line of every extension this CLI writes: how a later enable or disable knows the file is
 * Dosu's to replace or remove, and never touches a user's own `dosu.ts`. */
const EXTENSION_MARKER = "dosu:pi-extension";

/** The agent directory pi reads extensions from: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override ? expandHome(override) : expandHome("~/.pi/agent");
}

function extensionPath(): string {
  return join(piAgentDir(), "extensions", "dosu.ts");
}

/** How the extension runs the CLI: plain `dosu` from PATH, like every other agent's hook. Dev
 * installs pin this working copy with its endpoints, as the dev hook commands do. */
interface DosuInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function dosuInvocation(): DosuInvocation {
  if (process.env.DOSU_DEV !== "true") return { command: "dosu", args: [], env: {} };
  const { command, baseArgs } = selfInvocation();
  const env: Record<string, string> = {};
  for (const assignment of devEnvAssignments()) {
    const [, name, value] = /^([A-Z_]+)='?(.*?)'?$/.exec(assignment) ?? [];
    if (name) env[name] = value ?? "";
  }
  return { command, args: baseArgs, env };
}

/** What /dosu-incognito adds to the conversation: shown in pi's TUI, and handed to the model with
 * its next request. The record that keeps the session from shipping is a separate entry. */
const PI_INCOGNITO_NOTE = `Dosu incognito: this session stays off the record.

Dosu is off for the rest of this session. Do not call the Dosu memory tools (search_memory, get_memory_evidence), even where project rules ask you to. This session will not be shipped to Dosu memory.`;

/** The extension pi loads. Plain JavaScript (valid TypeScript for pi's loader) importing only
 * node builtins: pi validates the tools' plain JSON Schema parameters itself, so nothing pi ships
 * needs resolving from here. */
function piExtensionSource(dosu: DosuInvocation = dosuInvocation()): string {
  // Raw, so the extension's own escapes ("\n") reach the file as written.
  return String.raw`// ${EXTENSION_MARKER} v1 -- written by "dosu knowledge hooks enable pi"; every enable
// rewrites it and "dosu knowledge hooks disable pi" removes it, so edits do not last.
//
// Dosu memory for pi:
// - session_shutdown hands the session that ended to the Dosu CLI, which ships it to Dosu memory
//   right away;
// - before each agent run, the CLI may answer the prompt with a memory digest, added to the
//   conversation as a hidden message;
// - search_memory and get_memory_evidence pull memory on demand;
// - /${INCOGNITO_COMMAND_NAME} takes the session off the record: no digest, no memory tools, never shipped;
//   a fork or clone of such a session stays off too.
// Nothing here runs when pi starts with --no-extensions.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DOSU = ${JSON.stringify(dosu)};
const INCOGNITO_MARKER = ${JSON.stringify(INCOGNITO_MARKER)};
const INCOGNITO_ENTRY = ${JSON.stringify(PI_INCOGNITO_ENTRY_TYPE)};
const INCOGNITO_NOTE = ${JSON.stringify(PI_INCOGNITO_NOTE)};
const MEMORY_TOOLS = ["search_memory", "get_memory_evidence"];
// The CLI gives the server 4s and then gives up on its own (its debug log says why); this only
// stops a CLI that never answers. It leaves room for a slow start -- a freshly installed
// binary's first run, git lookups for the project key -- and matches the OpenCode plugin.
const CONTEXT_TIMEOUT_MS = 10000;
const TOOL_TIMEOUT_MS = 60000;
// How long quitting pi waits for the sync to take the ended session.
const HANDOFF_TIMEOUT_MS = 3000;
// How far up a chain of forks of forks session_start looks for the incognito marker.
const MAX_FORK_DEPTH = 32;

function launch(args, options) {
  return spawn(DOSU.command, [...DOSU.args, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...DOSU.env },
    detached: options.detached === true,
    stdio: ["pipe", options.detached ? "ignore" : "pipe", options.detached ? "ignore" : "pipe"],
  });
}

// Run the CLI with input on stdin. Never rejects: a missing or failing CLI is an exit code.
function dosu(args, options) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timer;
    let child;
    const finish = (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr });
    };
    const stop = () => {
      child?.kill();
      finish(-1);
    };
    try {
      child = launch(args, options);
    } catch (err) {
      stderr = String(err);
      finish(-1);
      return;
    }
    timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += String(err);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

// Hand the ended session to "dosu knowledge sync --quiet --detach", which reads it, re-spawns
// itself detached and exits; pi waits only for that first process, never for the upload.
function handOff(payload, cwd) {
  return new Promise((resolve) => {
    let timer;
    let child;
    const done = () => {
      clearTimeout(timer);
      child?.unref();
      resolve();
    };
    try {
      child = launch(["knowledge", "sync", "--quiet", "--detach"], { cwd, detached: true });
    } catch {
      done();
      return;
    }
    timer = setTimeout(done, HANDOFF_TIMEOUT_MS);
    child.on("error", done);
    child.on("exit", done);
    child.stdin.on("error", () => {});
    child.stdin.end(payload ? JSON.stringify(payload) : "");
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? part.text : "")).join("\n");
}

// The record /${INCOGNITO_COMMAND_NAME} leaves, or the user turn carrying the marker that this
// extension sent instead before it kept a record.
function isIncognitoEntry(entry) {
  if (entry?.type === "custom") {
    return entry.customType === INCOGNITO_ENTRY && entry.data?.marker === INCOGNITO_MARKER;
  }
  return (
    entry?.type === "message" &&
    entry.message?.role === "user" &&
    textOf(entry.message.content).includes(INCOGNITO_MARKER)
  );
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Whether the transcript a fork or clone was copied from, or one that was copied from in turn,
// has the user's incognito turn: a fork made before the marker holds what the session did off
// the record, and carries on from there.
function forkedFromIncognito(path) {
  const seen = new Set();
  while (typeof path === "string" && !seen.has(path) && seen.size < MAX_FORK_DEPTH) {
    seen.add(path);
    let text;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      return false;
    }
    const lines = text.split("\n");
    if (text.includes(INCOGNITO_MARKER) && lines.some((line) => isIncognitoEntry(parseLine(line)))) {
      return true;
    }
    const header = parseLine(lines[0]);
    path = header?.type === "session" ? header.parentSession : undefined;
  }
  return false;
}

export default function dosuForPi(pi) {
  let incognito = false;

  const hideMemoryTools = () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => !MEMORY_TOOLS.includes(name)));
  };

  pi.on("session_start", (_event, ctx) => {
    // A resumed session that went incognito stays incognito, and so does a fork or clone of one.
    incognito =
      ctx.sessionManager.getEntries().some(isIncognitoEntry) ||
      forkedFromIncognito(ctx.sessionManager.getHeader?.()?.parentSession);
    if (incognito) hideMemoryTools();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (incognito) return undefined;
    const input = JSON.stringify({
      prompt: event.prompt,
      session_id: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    });
    const result = await dosu(["knowledge", "context", "--agent", "pi", "--format", "plain"], {
      cwd: ctx.cwd,
      input,
      timeoutMs: CONTEXT_TIMEOUT_MS,
    });
    const digest = result.code === 0 ? result.stdout.trim() : "";
    if (!digest) return undefined;
    return { message: { customType: "dosu-memory", content: digest, display: false } };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // A reload brings this extension straight back on the same session.
    if (event.reason === "reload") return;
    const transcript = ctx.sessionManager.getSessionFile();
    // pi saves a session once it has a message, so a print run with nothing after
    // /${INCOGNITO_COMMAND_NAME} saved none, and a later run with its --session-id starts a new one.
    if (incognito && !ctx.hasUI && transcript && !existsSync(transcript)) {
      process.stderr.write(
        'Dosu incognito: pi saved no session, since nothing ran after /${INCOGNITO_COMMAND_NAME}. To work off the record, give the task in the same run: pi -p "/${INCOGNITO_COMMAND_NAME}" "<task>"\n',
      );
    }
    const payload = transcript
      ? {
          hook_event_name: "session_shutdown",
          agent: "pi",
          reason: event.reason,
          session_id: ctx.sessionManager.getSessionId(),
          transcript_path: transcript,
          cwd: ctx.cwd,
        }
      : null;
    await handOff(payload, ctx.cwd);
  });

  const memoryTool = async (args, signal, ctx) => {
    if (incognito) throw new Error("Dosu is off for this session (/${INCOGNITO_COMMAND_NAME}).");
    const result = await dosu(args, { cwd: ctx.cwd, signal, timeoutMs: TOOL_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "the Dosu CLI could not reach Dosu memory");
    }
    return { content: [{ type: "text", text: result.stdout.trim() }], details: undefined };
  };

  pi.registerTool({
    name: "search_memory",
    label: "Dosu memory",
    description:
      "Search long-term memory built from previous agent work in this organization. Returns lessons learned (semantic memories) and step-by-step runbooks (procedural memories) relevant to the query. Use it BEFORE exploring the codebase for a task: what took a previous agent many steps to learn -- where things live, environment quirks, commands that work, approaches that failed -- may already be recorded here. Query with a short description of what you are trying to do or learn.",
    promptSnippet: "Search what earlier agent sessions learned about this codebase (Dosu memory)",
    promptGuidelines: [
      "Use search_memory before exploring the codebase for a non-trivial task, and whenever you are about to work something out that a previous session plausibly already did; name the files, symbols, or tools involved. A Dosu memory digest may already be in context: act on its facts directly.",
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do or learn." },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return memoryTool(["memory", "search", "--client", "pi", "--", params.query], signal, ctx);
    },
  });

  pi.registerTool({
    name: "get_memory_evidence",
    label: "Dosu memory evidence",
    description:
      "Show the primary evidence behind one memory returned by search_memory or listed in a Dosu memory digest: the verbatim transcript excerpts (oldest first) that created, updated, or confirmed it, each with when it happened and why it mattered. Use it when a summary is ambiguous or you need the exact command, path, error text, or wording it was distilled from.",
    promptSnippet: "Show the transcript evidence behind one Dosu memory",
    parameters: {
      type: "object",
      properties: {
        memory_id: { type: "string", description: "The memory's id." },
      },
      required: ["memory_id"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return memoryTool(
        ["memory", "evidence", "--client", "pi", "--", params.memory_id],
        signal,
        ctx,
      );
    },
  });

  pi.registerCommand(${JSON.stringify(INCOGNITO_COMMAND_NAME)}, {
    description: "Turn Dosu off for this session: no memory tools, and it is never shipped to Dosu memory",
    // No turn of its own: pi runs a command while the rest of a print run's messages, or a run
    // under way, carry on, and a prompt started here collides with them ("Agent is already
    // processing a prompt").
    handler: async () => {
      incognito = true;
      hideMemoryTools();
      // What keeps the session from shipping: an entry only an extension can write, saved at once
      // in a session pi is already writing, else with the session's first message.
      pi.appendEntry(INCOGNITO_ENTRY, { marker: INCOGNITO_MARKER });
      // Shown in the TUI; the model gets it with its next request (mid-run, pi steers it in).
      pi.sendMessage({ customType: INCOGNITO_ENTRY, content: INCOGNITO_NOTE, display: true });
    },
  });
}
`;
}

function isOurs(path: string): boolean {
  try {
    return readFileSync(path, "utf-8").includes(EXTENSION_MARKER);
  } catch {
    return false;
  }
}

/** Pi is installed when its agent directory exists or `pi` is on PATH: pi creates the directory
 * on its first run, and a freshly provisioned machine sets Dosu up before that run. */
function piInstalled(): boolean {
  return isInstalled([piAgentDir()]) || isOnPath("pi");
}

/** Pi's HookAgent: the session-end trigger, prompt-time memory, the memory tools and
 * /dosu-incognito, installed and removed together as the one extension file. */
export function piHookAgent(): HookAgent {
  return {
    id: () => "pi",
    name: () => "Pi",
    isInstalled: piInstalled,
    configPath: extensionPath,
    isEnabled: () => isOurs(extensionPath()),
    enable: () => {
      const path = extensionPath();
      if (existsSync(path) && !isOurs(path)) {
        throw new HookConfigError(`${path} exists and is not Dosu's; move it aside, then retry`);
      }
      writeSecureFile(path, piExtensionSource());
    },
    disable: () => {
      const path = extensionPath();
      if (isOurs(path)) unlinkSync(path);
    },
    enableNote: () =>
      "Pi loads it from its next start (or /reload). Sessions run with `pi --no-extensions` skip it and ship only on a later sync.",
  };
}
