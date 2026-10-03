/** The Dosu pi extension as pi runs it: `hooks enable pi` writes the file, the test loads that very
 * file and drives it through a stand-in for pi's extension API, and the `dosu` it shells out to is
 * a fake executable on PATH that records each call. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endedSessionOf } from "../sessions/capture";
import { textHasIncognitoMarker } from "../sync/incognito";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fakeHome };
});

import { getHookAgent } from "./agents";
import { HookConfigError } from "./formats";

/** A `dosu` that logs argv, cwd and stdin, and answers per `<command> <subcommand>`. */
const FAKE_DOSU = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(process.env.FAKE_DOSU_LOG, JSON.stringify({ argv, cwd: process.cwd(), input }) + "\\n");
  const reply = JSON.parse(process.env.FAKE_DOSU_REPLIES || "{}")[argv.slice(0, 2).join(" ")] || {};
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exit(reply.code || 0);
});
`;

let bin: string;
let log: string;
let cwd: string;

beforeEach(() => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "dosu-pi-ext-")));
  bin = join(fakeHome, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "dosu"), FAKE_DOSU);
  chmodSync(join(bin, "dosu"), 0o755);
  log = join(fakeHome, "dosu-calls.jsonl");
  cwd = join(fakeHome, "work");
  mkdirSync(cwd);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("FAKE_DOSU_LOG", log);
  vi.stubEnv("FAKE_DOSU_REPLIES", "{}");
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
});

function replies(map: Record<string, { stdout?: string; stderr?: string; code?: number }>): void {
  vi.stubEnv("FAKE_DOSU_REPLIES", JSON.stringify(map));
}

interface DosuCall {
  argv: string[];
  cwd: string;
  input: string;
}

function calls(): DosuCall[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

// biome-ignore lint/suspicious/noExplicitAny: pi's extension API, faked loosely
type Any = any;

/** A stand-in for the slice of pi's ExtensionAPI the extension uses. */
function fakePi() {
  const handlers = new Map<string, (event: Any, ctx: Any) => Any>();
  const tools = new Map<string, Any>();
  const commands = new Map<string, Any>();
  const sent: { content: string; options: unknown }[] = [];
  let active: string[] = ["read", "bash"];
  const api = {
    on: (event: string, handler: (event: Any, ctx: Any) => Any) => {
      handlers.set(event, handler);
      return () => {};
    },
    registerTool: (tool: Any) => {
      tools.set(tool.name, tool);
      active.push(tool.name);
    },
    registerCommand: (name: string, options: Any) => commands.set(name, options),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    sendUserMessage: (content: string, options?: unknown) => sent.push({ content, options }),
  };
  return { api, handlers, tools, commands, sent, active: () => active };
}

const TRANSCRIPT_NAME = "2026-10-02T17-59-42-611Z_01a0fdc5-a112.jsonl";

/** pi's context for a session in `cwd`. */
function piContext(entries: unknown[] = [], transcript: string | undefined = undefined) {
  return {
    cwd,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "01a0fdc5-a112",
      getSessionFile: () => transcript,
      getEntries: () => entries,
    },
  };
}

/** Enable pi the way `dosu knowledge hooks enable pi` does, then load the file pi would load. */
async function loadExtension() {
  const agent = getHookAgent("pi");
  agent?.enable();
  const path = agent?.configPath() as string;
  const { default: extension } = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const pi = fakePi();
  extension(pi.api);
  return pi;
}

describe("pi hook agent", () => {
  it("installs the extension in pi's extensions folder, and removes it", () => {
    const pi = getHookAgent("pi");
    expect(pi?.name()).toBe("Pi");
    expect(pi?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
    expect(pi?.isInstalled()).toBe(true);
    expect(pi?.configPath()).toBe(join(fakeHome, ".pi", "agent", "extensions", "dosu.ts"));
    expect(pi?.isEnabled()).toBe(false);

    pi?.enable();
    expect(pi?.isEnabled()).toBe(true);
    expect(pi?.enableNote?.()).toContain("--no-extensions");
    pi?.enable();
    expect(pi?.isEnabled()).toBe(true);

    pi?.disable();
    expect(pi?.isEnabled()).toBe(false);
    expect(existsSync(pi?.configPath() as string)).toBe(false);
    pi?.disable();
  });

  it("honors PI_CODING_AGENT_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "~/relocated-pi");
    const pi = getHookAgent("pi");
    pi?.enable();
    expect(existsSync(join(fakeHome, "relocated-pi", "extensions", "dosu.ts"))).toBe(true);
  });

  it("never replaces or removes a dosu.ts that is not Dosu's", () => {
    const pi = getHookAgent("pi");
    const path = pi?.configPath() as string;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "export default function mine() {}\n");

    expect(() => pi?.enable()).toThrow(HookConfigError);
    expect(pi?.isEnabled()).toBe(false);
    pi?.disable();
    expect(readFileSync(path, "utf-8")).toBe("export default function mine() {}\n");
  });

  it("pins this working copy and its endpoints in dev mode", () => {
    vi.stubEnv("DOSU_DEV", "true");
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "http://127.0.0.1:9");
    const pi = getHookAgent("pi");
    pi?.enable();
    const source = readFileSync(pi?.configPath() as string, "utf-8");
    expect(source).toContain(JSON.stringify(process.execPath));
    expect(source).toContain('"DOSU_DEV":"true"');
    expect(source).toContain('"DOSU_BACKEND_URL_OVERRIDE":"http://127.0.0.1:9"');
  });
});

describe("the Dosu pi extension", () => {
  it("hands the session that ended to the sync hook, which reads it as ended", async () => {
    const pi = await loadExtension();
    const transcript = join(fakeHome, ".pi", "agent", "sessions", "--work--", TRANSCRIPT_NAME);

    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, piContext([], transcript));

    const [call] = calls();
    expect(call.argv).toEqual(["knowledge", "sync", "--quiet", "--detach"]);
    expect(call.cwd).toBe(cwd);
    expect(endedSessionOf(JSON.parse(call.input))).toEqual({
      harness: "pi",
      id: "01a0fdc5-a112",
      path: transcript,
    });
  });

  it("names no session for a reload, or for a session pi never saved", async () => {
    const pi = await loadExtension();
    const shutdown = pi.handlers.get("session_shutdown");

    await shutdown?.({ reason: "reload" }, piContext([], "/x/a_01a0fdc5-a112.jsonl"));
    expect(calls()).toEqual([]);

    // `pi --no-session`: still a trigger for the backlog, with nothing of its own to ship.
    await shutdown?.({ reason: "quit" }, piContext([], undefined));
    expect(calls().map((c) => [c.argv.join(" "), c.input])).toEqual([
      ["knowledge sync --quiet --detach", ""],
    ]);
  });

  it("adds the memory digest the CLI returns for a prompt, and nothing when there is none", async () => {
    const pi = await loadExtension();
    const beforeStart = pi.handlers.get("before_agent_start");
    replies({ "knowledge context": { stdout: "Dosu memory: the deploy codeword is PELICAN\n" } });

    const result = await beforeStart?.({ prompt: "how do I deploy?" }, piContext());

    expect(result).toEqual({
      message: {
        customType: "dosu-memory",
        content: "Dosu memory: the deploy codeword is PELICAN",
        display: false,
      },
    });
    const [call] = calls();
    expect(call.argv).toEqual(["knowledge", "context", "--agent", "pi", "--format", "plain"]);
    expect(JSON.parse(call.input)).toEqual({
      prompt: "how do I deploy?",
      session_id: "01a0fdc5-a112",
      cwd,
    });

    replies({});
    expect(await beforeStart?.({ prompt: "and then?" }, piContext())).toBeUndefined();
    replies({ "knowledge context": { stdout: "partial", code: 1 } });
    expect(await beforeStart?.({ prompt: "and then?" }, piContext())).toBeUndefined();
  });

  it("answers search_memory and get_memory_evidence through `dosu memory`", async () => {
    const pi = await loadExtension();
    replies({
      "memory search": { stdout: "1 memory: deploy with make ship\n" },
      "memory evidence": { stdout: "excerpt: ran make ship\n" },
    });
    expect(pi.active()).toEqual(["read", "bash", "search_memory", "get_memory_evidence"]);

    const search = await pi.tools
      .get("search_memory")
      .execute("call1", { query: "--how to deploy" }, undefined, undefined, piContext());
    const evidence = await pi.tools
      .get("get_memory_evidence")
      .execute("call2", { memory_id: "m-1" }, undefined, undefined, piContext());

    expect(search.content).toEqual([{ type: "text", text: "1 memory: deploy with make ship" }]);
    expect(evidence.content).toEqual([{ type: "text", text: "excerpt: ran make ship" }]);
    expect(calls().map((c) => [c.argv, c.cwd])).toEqual([
      [["memory", "search", "--client", "pi", "--", "--how to deploy"], cwd],
      [["memory", "evidence", "--client", "pi", "--", "m-1"], cwd],
    ]);
  });

  it("reports a failed memory lookup as a failed tool call", async () => {
    const pi = await loadExtension();
    replies({ "memory search": { stderr: "Not signed in. Run dosu setup.\n", code: 1 } });

    await expect(
      pi.tools.get("search_memory").execute("c", { query: "x" }, undefined, undefined, piContext()),
    ).rejects.toThrow("Not signed in. Run dosu setup.");
  });

  it("/dosu-incognito records the marker as the user's turn and turns Dosu off", async () => {
    const pi = await loadExtension();

    await pi.commands.get("dosu-incognito").handler("", piContext());

    const [message] = pi.sent;
    expect(textHasIncognitoMarker(message.content)).toBe(true);
    expect(message.options).toBeUndefined();
    expect(pi.active()).toEqual(["read", "bash"]);
    expect(
      await pi.handlers.get("before_agent_start")?.({ prompt: message.content }, piContext()),
    ).toBeUndefined();
    expect(
      await pi.handlers.get("before_agent_start")?.({ prompt: "next" }, piContext()),
    ).toBeUndefined();
    await expect(
      pi.tools.get("search_memory").execute("c", { query: "x" }, undefined, undefined, piContext()),
    ).rejects.toThrow(/off for this session/);
    expect(calls()).toEqual([]);
  });

  it("steers the marker in when the agent is mid-run", async () => {
    const pi = await loadExtension();

    await pi.commands.get("dosu-incognito").handler("", { ...piContext(), isIdle: () => false });

    expect(pi.sent[0].options).toEqual({ deliverAs: "steer" });
  });

  it("a resumed session that went incognito stays off", async () => {
    const pi = await loadExtension();
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Dosu incognito marker: dosu:incognito:v1" }],
        },
      },
    ];

    pi.handlers.get("session_start")?.({ reason: "resume" }, piContext(entries));

    expect(pi.active()).toEqual(["read", "bash"]);
    expect(await pi.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toBe(
      undefined,
    );
    expect(calls()).toEqual([]);
  });

  it("never breaks pi when the CLI is missing", async () => {
    const pi = await loadExtension();
    vi.stubEnv("PATH", join(fakeHome, "empty"));

    pi.handlers.get("session_start")?.({ reason: "startup" }, piContext());
    expect(await pi.handlers.get("before_agent_start")?.({ prompt: "q" }, piContext())).toBe(
      undefined,
    );
    await pi.handlers.get("session_shutdown")?.({ reason: "quit" }, piContext([], "/x/a_b.jsonl"));
    await expect(
      pi.tools.get("search_memory").execute("c", { query: "x" }, undefined, undefined, piContext()),
    ).rejects.toThrow();
  });
});
