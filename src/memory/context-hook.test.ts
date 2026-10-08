import { execFileSync } from "node:child_process";
import {
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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getConfigDir } from "../config/config";
import { logger } from "../debug/logger";
import type { IncognitoSwitch } from "../mcp/call-session";
import { createProjectDirResolver } from "../sessions/project-dir";
import { createShipStep } from "../shipper/runner";
import { INCOGNITO_MARKER } from "../sync/incognito";
import type { LedgerEntry } from "../sync/state";
import { contextHookOutput } from "./context-hook";

const DIGEST = "## Task Memory (Dosu)\n\n### Facts\n- a fact — memory_id: m1";

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-1",
    prompt: "reset the local database and rerun the migration tests",
    cwd: "/Users/me/dosu",
    transcript_path: "/Users/me/.claude/projects/x/sess-1.jsonl",
    ...over,
  });
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const base = {
  apiKey: "sk_user_x",
  deploymentId: "dep-1",
  backendUrl: "https://api.test/",
  isIncognito: () => false,
};

let savedProject: string | undefined;

beforeEach(() => {
  savedProject = process.env.DOSU_PROJECT;
  delete process.env.DOSU_PROJECT;
});

afterEach(() => {
  if (savedProject === undefined) delete process.env.DOSU_PROJECT;
  else process.env.DOSU_PROJECT = savedProject;
});

/** A ledger holding one session the agents' incognito switch settled (`by_agent`). */
function settledByAgent(key: string): Record<string, LedgerEntry> {
  return {
    [key]: {
      updated: "2026-10-01T00:00:00.000Z",
      outcome: "incognito",
      at: "2026-10-01T00:05:00.000Z",
      cli_version: "0.67.0",
      by_agent: true,
    },
  };
}

function sentBody(fetchImpl: ReturnType<typeof respond>): Record<string, unknown> {
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("contextHookOutput", () => {
  it("turns a digest into Claude Code's additionalContext", async () => {
    const fetchImpl = respond(200, { digest: DIGEST, reason: "injected", memory_ids: ["m1"] });
    const out = await contextHookOutput(payload(), {
      ...base,
      fetchImpl,
      branchOf: () => "feat/x",
    });
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DIGEST },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/memory/context");
    expect((init.headers as Record<string, string>)["X-Dosu-API-Key"]).toBe("sk_user_x");
    expect(JSON.parse(init.body as string)).toEqual({
      deployment_id: "dep-1",
      prompt: "reset the local database and rerun the migration tests",
      session_id: "sess-1",
      branch: "feat/x",
      agent: "claude-code",
      // Not a checkout on this machine: the path rule, sent as both fields for older servers.
      project: "path:/Users/me/dosu",
      repo: "path:/Users/me/dosu",
    });
  });

  it("sends the cwd's project key, which the shipped session later carries too", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "dosu-context-repo-")));
    try {
      execFileSync("git", ["-C", repo, "init", "-q"]);
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "add",
        "origin",
        "git@github.com:Acme/Widget.git",
      ]);
      const fetchImpl = respond(200, { digest: null });

      await contextHookOutput(payload({ cwd: repo, session_id: "sess-42" }), {
        ...base,
        fetchImpl,
      });

      expect(sentBody(fetchImpl)).toMatchObject({
        project: "github.com/acme/widget",
        repo: "github.com/acme/widget",
      });
      // The checkout is gone by the time the session ships; its key is not.
      rmSync(repo, { recursive: true, force: true });
      const shipped = createProjectDirResolver().resolveProject({
        id: "sess-42",
        harness: "claude",
        path: join(repo, "missing.jsonl"),
        updated: "2026-10-02T00:00:00.000Z",
      });
      expect(shipped?.project).toBe("github.com/acme/widget");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("the session ships under the DOSU_PROJECT its prompts were served by", async () => {
    // A clone without an origin, where git alone would say git:<root commit>.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "dosu-context-repo-")));
    try {
      execFileSync("git", ["-C", repo, "init", "-q"]);
      execFileSync("git", [
        "-C",
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ]);
      process.env.DOSU_PROJECT = "poc-gamma";
      const context = respond(200, { digest: null });
      await contextHookOutput(payload({ cwd: repo, session_id: "sess-77" }), {
        ...base,
        fetchImpl: context,
      });
      expect(sentBody(context)).toMatchObject({ project: "poc-gamma" });

      // The transcript ships from a sync run whose environment lacks the variable.
      delete process.env.DOSU_PROJECT;
      const transcript = join(repo, "sess-77.jsonl");
      writeFileSync(
        transcript,
        [
          { type: "user", uuid: "u", cwd: repo, message: { role: "user", content: "fix it" } },
          {
            type: "assistant",
            uuid: "a",
            message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2500) }] },
          },
        ]
          .map((r) =>
            JSON.stringify({ ...r, sessionId: "sess-77", timestamp: "2026-10-02T00:00:00Z" }),
          )
          .join("\n"),
      );
      const ingest = respond(202, { task_id: "t" });
      const ship = createShipStep({
        apiKey: "k",
        deploymentId: "dep-1",
        backendUrl: "https://api.test",
        fetchImpl: ingest,
      });
      await ship([
        { id: "sess-77", harness: "claude", path: transcript, updated: "2026-10-02T00:00:00Z" },
      ]);

      expect(sentBody(ingest).metadata).toMatchObject({ project: "poc-gamma", repo: "poc-gamma" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a session's first branch for its later prompts, and its transcript", async () => {
    const asked = (branch: string) => async (stdin: string) => {
      const fetchImpl = respond(200, { digest: null });
      await contextHookOutput(stdin, { ...base, fetchImpl, branchOf: () => branch });
      return sentBody(fetchImpl).branch;
    };
    const session = payload({ session_id: "sess-branch" });

    expect(await asked("feat/first")(session)).toBe("feat/first");
    // The user checked out another branch mid-session.
    expect(await asked("feat/second")(session)).toBe("feat/first");
    expect(await asked("feat/second")(payload({ session_id: "sess-other" }))).toBe("feat/second");
    const shipped = createProjectDirResolver().resolveBranch({
      id: "sess-branch",
      harness: "claude",
      path: "/gone/sess-branch.jsonl",
      updated: "2026-10-02T00:00:00.000Z",
    });
    expect(shipped).toBe("feat/first");
  });

  it("a session first served partway through asks with the branch its transcript recorded", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-context-resumed-")));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    // The session began before the hook was installed, on a branch since left.
    const transcript = join(dir, "sess-resumed.jsonl");
    writeFileSync(
      transcript,
      [
        { type: "user", uuid: "u", cwd: dir, message: { role: "user", content: "fix it" } },
        {
          type: "assistant",
          uuid: "a",
          message: { role: "assistant", content: [{ type: "text", text: "x".repeat(2500) }] },
        },
      ]
        .map((r) =>
          JSON.stringify({
            ...r,
            sessionId: "sess-resumed",
            gitBranch: "feat/began",
            timestamp: "2026-10-02T00:00:00Z",
          }),
        )
        .join("\n"),
    );
    const asked = async (checkedOut: string) => {
      const fetchImpl = respond(200, { digest: null });
      const stdin = payload({ session_id: "sess-resumed", transcript_path: transcript, cwd: dir });
      await contextHookOutput(stdin, { ...base, fetchImpl, branchOf: () => checkedOut });
      return sentBody(fetchImpl).branch;
    };

    expect(await asked("feat/now")).toBe("feat/began");
    expect(await asked("feat/later")).toBe("feat/began");
  });

  it("resolves the cwd directly when the payload names no session", async () => {
    const fetchImpl = respond(200, { digest: null });

    await contextHookOutput(payload({ session_id: undefined }), { ...base, fetchImpl });

    expect(sentBody(fetchImpl)).toMatchObject({ session_id: null, project: "path:/Users/me/dosu" });
  });

  it("honors DOSU_PROJECT, even without a cwd", async () => {
    process.env.DOSU_PROJECT = "poc-widget";
    const fetchImpl = respond(200, { digest: null });

    await contextHookOutput(payload({ cwd: undefined }), { ...base, fetchImpl });

    expect(sentBody(fetchImpl)).toMatchObject({ project: "poc-widget", repo: "poc-widget" });
  });

  it("adds nothing when the server declines", async () => {
    const fetchImpl = respond(200, { digest: null, reason: "not_worth_it", memory_ids: [] });
    expect(await contextHookOutput(payload(), { ...base, fetchImpl })).toBe("");
  });

  // The user's prompt is waiting on this hook. Anything that goes wrong must look, to them,
  // exactly like Dosu not being installed.
  it.each([
    ["a server error", respond(500, { detail: "boom" })],
    ["an auth failure", respond(401, { detail: "no key" })],
    [
      "a network failure",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    ],
    [
      "a timeout",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    ],
    ["a body that is not JSON", vi.fn(async () => new Response("<html>", { status: 200 }))],
  ])("fails open on %s", async (_label, fetchImpl) => {
    expect(await contextHookOutput(payload(), { ...base, fetchImpl })).toBe("");
  });

  it("ignores payloads that are not a prompt submission", async () => {
    const fetchImpl = respond(200, { digest: DIGEST });
    expect(await contextHookOutput("not json", { ...base, fetchImpl })).toBe("");
    expect(
      await contextHookOutput(payload({ hook_event_name: "Stop" }), { ...base, fetchImpl }),
    ).toBe("");
    expect(await contextHookOutput(payload({ prompt: "" }), { ...base, fetchImpl })).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends the prompt of a session taken off the record", async () => {
    // The prompt is logged server-side as the retrieval query, so incognito has to stop the
    // request itself, not just the transcript upload.
    const fetchImpl = respond(200, { digest: DIGEST });
    const marked = await contextHookOutput(payload(), {
      ...base,
      fetchImpl,
      isIncognito: () => true,
    });
    // The marker typed into a prompt works in any agent.
    const typed = await contextHookOutput(payload({ prompt: `${INCOGNITO_MARKER} then fix it` }), {
      ...base,
      fetchImpl,
    });
    expect(marked).toBe("");
    expect(typed).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends the prompt that runs /dosu-incognito, which the transcript does not yet show", async () => {
    // Claude Code hands its prompt hook the command as typed, before the expansion is recorded.
    const fetchImpl = respond(200, { digest: DIGEST });
    for (const prompt of ["/dosu-incognito", "  /dosu-incognito then fix the login bug"]) {
      expect(await contextHookOutput(payload({ prompt }), { ...base, fetchImpl })).toBe("");
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    // Only a command at the start runs; a prompt that merely names it is asked about as usual.
    await contextHookOutput(payload({ prompt: "what does /dosu-incognito do?" }), {
      ...base,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never sends a prompt of an agent in incognito, or of a session that ran while it was", async () => {
    // `dosu knowledge incognito on` keeps every prompt of the agent on the machine, as
    // /dosu-incognito does one session's; a session the switch settled stays out once it is off.
    const fetchImpl = respond(200, { digest: DIGEST });
    for (const incognito of [
      { incognito_agents: ["claude"], sessions: {} },
      { sessions: settledByAgent("claude/sess-1") },
    ]) {
      expect(await contextHookOutput(payload(), { ...base, fetchImpl, incognito })).toBe("");
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    // Another agent in incognito, or another session the switch settled, takes nothing off this.
    await contextHookOutput(payload(), {
      ...base,
      fetchImpl,
      incognito: { incognito_agents: ["codex", "cursor"], sessions: settledByAgent("claude/s-2") },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("contextHookOutput for other agents", () => {
  const ROLLOUT = "rollout-2026-10-02T17-33-20-01a0ff2e-029b-7153-9702-1dbfdee28612";

  /** Codex 0.160's UserPromptSubmit payload: `session_id` is the root session, also in a subagent. */
  function codexPayload(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: "01a0ff2e-029b-7153-9702-1dbfdee28612",
      turn_id: "01a0ff2e-6306-73d1-aa1b-4a24313481f9",
      transcript_path: `/home/u/.codex/sessions/2026/10/02/${ROLLOUT}.jsonl`,
      cwd: "/work/widget",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6-luna",
      permission_mode: "bypassPermissions",
      prompt: "add a cache to the layout pass",
      ...over,
    });
  }

  const codex = { ...base, agent: "codex", format: "codex" as const };

  it("answers Codex's prompt hook in Codex's hook JSON, as the codex agent", async () => {
    const fetchImpl = respond(200, { digest: DIGEST });

    const out = await contextHookOutput(codexPayload(), { ...codex, fetchImpl });

    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DIGEST },
    });
    // The rollout names the session, as the scanner and the shipped session name it.
    expect(sentBody(fetchImpl)).toMatchObject({
      agent: "codex",
      session_id: ROLLOUT,
      project: "path:/work/widget",
    });
  });

  it("never sends a Codex prompt that mentions $dosu-incognito, which runs the skill", async () => {
    const fetchImpl = respond(200, { digest: DIGEST });
    for (const prompt of [
      "$dosu-incognito",
      "fix the login bug $dosu-incognito",
      "[$dosu-incognito](/home/u/.codex/skills/dosu-incognito/SKILL.md) fix it",
    ]) {
      expect(await contextHookOutput(codexPayload({ prompt }), { ...codex, fetchImpl })).toBe("");
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    // Another skill whose name starts the same is not this one.
    await contextHookOutput(codexPayload({ prompt: "$dosu-incognito-notes summarize" }), {
      ...codex,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a Codex subagent or fork of a session taken off the record", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "dosu-codex-home-"));
    onTestFinished(() => rmSync(codexHome, { recursive: true, force: true }));
    const sessions = join(codexHome, "sessions", "2026", "10", "02");
    mkdirSync(sessions, { recursive: true });
    const rollout = (name: string, meta: Record<string, unknown>, text: string) => {
      const path = join(sessions, `${name}.jsonl`);
      const items = [
        { type: "session_meta", payload: { id: name.slice(-36), cwd: "/work/widget", ...meta } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
        },
      ];
      writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
      return path;
    };
    const parent = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    rollout(`rollout-2026-10-02T18-50-30-${parent}`, {}, `${INCOGNITO_MARKER} keep it out`);
    const subagent = rollout(
      "rollout-2026-10-02T18-50-38-01a0ff74-c903-73c2-b6b1-7546b84710ff",
      { parent_thread_id: parent, thread_source: "subagent" },
      "write the tests",
    );
    const fork = rollout(
      "rollout-2026-10-02T18-56-30-01a0ff7a-277c-74f1-b64b-59ffa01a7d14",
      { forked_from_id: parent },
      "go on",
    );
    const unrelated = rollout(
      "rollout-2026-10-02T19-10-00-01a0ff86-0000-7000-8000-000000000002",
      { parent_thread_id: "01a0ff86-0000-7000-8000-00000000ffff", thread_source: "subagent" },
      "write the docs",
    );
    const { isIncognito: _, ...defaults } = codex;
    const fetchImpl = respond(200, { digest: DIGEST });

    for (const transcript_path of [subagent, fork]) {
      expect(
        await contextHookOutput(codexPayload({ transcript_path }), { ...defaults, fetchImpl }),
      ).toBe("");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // A subagent whose parent's rollout is gone, or on the record, is asked about as usual.
    await contextHookOutput(codexPayload({ transcript_path: unrelated }), {
      ...defaults,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a Codex session ships under the DOSU_PROJECT its prompts were served by", async () => {
    const rollout = "rollout-2026-10-02T18-00-00-01a0ff40-0000-7000-8000-000000000001";
    process.env.DOSU_PROJECT = "poc-codex";
    await contextHookOutput(
      codexPayload({ transcript_path: `/home/u/.codex/sessions/2026/10/02/${rollout}.jsonl` }),
      { ...codex, fetchImpl: respond(200, {}) },
    );
    delete process.env.DOSU_PROJECT;

    const shipped = createProjectDirResolver().resolveProject({
      id: rollout,
      harness: "codex",
      path: "/gone/rollout.jsonl",
      updated: "2026-10-02T00:00:00.000Z",
    });
    expect(shipped?.project).toBe("poc-codex");
  });

  it("takes a harness-neutral payload and prints the digest alone in plain format", async () => {
    const fetchImpl = respond(200, { digest: DIGEST });
    const stdin = JSON.stringify({
      prompt: "why is the build slow",
      session_id: "ses_1",
      cwd: "/w",
    });

    const out = await contextHookOutput(stdin, {
      ...base,
      agent: "opencode",
      format: "plain",
      fetchImpl,
    });

    expect(out).toBe(DIGEST);
    expect(sentBody(fetchImpl)).toMatchObject({
      agent: "opencode",
      session_id: "ses_1",
      prompt: "why is the build slow",
      project: "path:/w",
    });
  });

  it("judges a pi transcript off the record as its upload is judged: by what the user typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-context-pi-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const transcript = (name: string, role: "user" | "toolResult") => {
      const path = join(dir, name);
      const entries = [
        { type: "session", version: 3, id: name, timestamp: "2026-10-02T00:00:00Z", cwd: dir },
        {
          type: "message",
          id: "m1",
          message: { role, content: [{ type: "text", text: `see ${INCOGNITO_MARKER}` }] },
        },
      ];
      writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n"));
      return path;
    };
    const asks = async (path: string) => {
      const fetchImpl = respond(200, { digest: null });
      const stdin = JSON.stringify({
        prompt: "go on",
        session_id: "p",
        cwd: dir,
        transcript_path: path,
      });
      const { isIncognito: _, ...options } = base;
      await contextHookOutput(stdin, { ...options, agent: "pi", format: "plain", fetchImpl });
      return fetchImpl.mock.calls.length > 0;
    };

    // A file the agent read that mentions the marker takes nothing off the record.
    expect(await asks(transcript("read.jsonl", "toolResult"))).toBe(true);
    expect(await asks(transcript("typed.jsonl", "user"))).toBe(false);
  });

  it.each([
    ["codex", codexPayload(), codex],
    [
      "opencode",
      JSON.stringify({ prompt: "why is the build slow", session_id: "ses_1", cwd: "/w" }),
      { ...base, agent: "opencode", format: "plain" as const },
    ],
    [
      "pi",
      JSON.stringify({ prompt: "why is the build slow", session_id: "p1", cwd: "/w" }),
      { ...base, agent: "pi", format: "plain" as const },
    ],
  ])("asks nothing for %s while it is in incognito", async (harness, stdin, options) => {
    const fetchImpl = respond(200, { digest: DIGEST });
    const incognito = { incognito_agents: [harness], sessions: {} };

    expect(await contextHookOutput(stdin, { ...options, fetchImpl, incognito })).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks nothing for a Codex session that ran while Codex was in incognito", async () => {
    // The ledger names a Codex session by its rollout's stem, not the payload's session_id.
    const fetchImpl = respond(200, { digest: DIGEST });
    const incognito = { sessions: settledByAgent(`codex/${ROLLOUT}`) };

    expect(await contextHookOutput(codexPayload(), { ...codex, fetchImpl, incognito })).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints nothing in plain format when there is no digest", async () => {
    const stdin = JSON.stringify({ prompt: "hi", session_id: "ses_1", cwd: "/w" });
    const out = await contextHookOutput(stdin, {
      ...base,
      format: "plain",
      fetchImpl: respond(200, { digest: null }),
    });
    expect(out).toBe("");
  });

  it.each([
    [
      "Claude Code's task notification",
      payload({ prompt: "<task-notification>\n<task-id>a1</task-id>" }),
      base,
    ],
    [
      "Codex's subagent notification",
      codexPayload({ prompt: '<subagent_notification>\n{"agent_path":"x"}' }),
      codex,
    ],
  ])("never asks about %s, which no one typed", async (_label, stdin, options) => {
    const fetchImpl = respond(200, { digest: DIGEST });
    expect(await contextHookOutput(stdin, { ...options, fetchImpl })).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// A prompt that gets no digest looks the same to the user whatever the reason; the debug log is
// where `dosu` says which it was, without the prompt or the digest.
describe("contextHookOutput's debug log", () => {
  const logged = () => readFileSync(logger.getLogPath(), "utf-8");

  it("says when the server missed the budget", async () => {
    // A server that never answers: only the hook's own budget ends the wait.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const stdin = JSON.stringify({ prompt: "fix the flaky test", session_id: "ses_9", cwd: "/w" });

    const out = await contextHookOutput(stdin, {
      ...base,
      agent: "pi",
      format: "plain",
      fetchImpl,
      timeoutMs: 30,
    });

    expect(out).toBe("");
    expect(logged()).toMatch(/\[context\] pi ses_9: no digest, no answer within the 30ms budget/);
  });

  it("records the server's answer and how long it took", async () => {
    const answers = [
      respond(200, { digest: DIGEST, reason: "injected", memory_ids: ["m1", "m2"] }),
      respond(200, { digest: null, reason: "nothing_new", memory_ids: [] }),
      respond(503, { detail: "busy" }),
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    ];
    for (const fetchImpl of answers) {
      await contextHookOutput(payload(), { ...base, fetchImpl });
    }

    const log = logged();
    expect(log).toMatch(/\[context\] claude-code sess-1: injected 2 memories in \d+ms/);
    expect(log).toMatch(/\[context\] claude-code sess-1: no digest, nothing_new in \d+ms/);
    expect(log).toMatch(/\[context\] claude-code sess-1: no digest, HTTP 503 in \d+ms/);
    expect(log).toMatch(/\[context\] claude-code sess-1: no digest, fetch failed in \d+ms/);
    expect(log).not.toContain("reset the local database");
    expect(log).not.toContain("Task Memory");
  });
});

describe("contextHookOutput when git hangs", () => {
  let bin: string;
  let calls: string;

  beforeEach(() => {
    // A git that never answers in time, as a hung network filesystem would; it logs each call.
    bin = mkdtempSync(join(tmpdir(), "dosu-context-git-"));
    calls = join(bin, "calls.log");
    writeFileSync(calls, "");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${calls}"\nsleep 3\n`, {
      mode: 0o755,
    });
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(bin, { recursive: true, force: true });
  });

  /** The git subcommands run since the last look. */
  const gitRan = (() => {
    let seen = 0;
    return () => {
      const lines = readFileSync(calls, "utf-8").split("\n").filter(Boolean);
      const fresh = lines.slice(seen).map((line) => line.split(" ")[2]);
      seen = lines.length;
      return fresh;
    };
  })();

  async function ask(stdin: string): Promise<Record<string, unknown>> {
    const fetchImpl = respond(200, { digest: null });
    await contextHookOutput(stdin, { ...base, fetchImpl });
    return sentBody(fetchImpl);
  }

  it("waits on git once per session, for the project and the branch alike", async () => {
    gitRan();
    expect(await ask(payload({ session_id: "slow-1" }))).toMatchObject({
      project: null,
      branch: null,
    });
    // The project lookup ran out of time: the branch is not asked for on top of it.
    expect(gitRan()).not.toContain("symbolic-ref");
    expect(await ask(payload({ session_id: "slow-1" }))).toMatchObject({ branch: null });
    expect(gitRan()).toEqual([]);
  });

  it("a branch lookup that runs out of time is not retried on the session's later prompts", async () => {
    // The project needs no git; the branch does.
    process.env.DOSU_PROJECT = "poc-slow";
    gitRan();
    expect(await ask(payload({ session_id: "slow-2" }))).toMatchObject({
      project: "poc-slow",
      branch: null,
    });
    gitRan();
    expect(await ask(payload({ session_id: "slow-2" }))).toMatchObject({ branch: null });
    expect(gitRan()).toEqual([]);
  });

  it("without a session to remember it for, skips the branch once the project ran out", async () => {
    gitRan();
    expect(await ask(payload({ session_id: undefined }))).toMatchObject({
      project: null,
      branch: null,
    });
    expect(gitRan()).not.toContain("symbolic-ref");
  });
});

describe("Claude Code's PreToolUse hook on Dosu's memory tools", () => {
  function toolPayload(over: Record<string, unknown> = {}): string {
    return payload({
      hook_event_name: "PreToolUse",
      prompt: undefined,
      tool_name: "mcp__dosu__search_memory",
      tool_input: { query: "q" },
      tool_use_id: "toolu_1",
      ...over,
    });
  }

  it("denies a memory tool in a session the user took off the record, asking nothing", async () => {
    const fetchImpl = respond(200, {});
    for (const tool of ["mcp__dosu__search_memory", "mcp__dosu__get_memory_evidence"]) {
      const out = await contextHookOutput(toolPayload({ tool_name: tool }), {
        ...base,
        isIncognito: () => true,
        fetchImpl,
      });
      expect(JSON.parse(out).hookSpecificOutput).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("denies a memory tool while Claude Code is in incognito, naming the switch, and records nothing", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-pretool-")));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });
    const fetchImpl = respond(200, {});
    const reason = async (incognito: IncognitoSwitch) => {
      const out = await contextHookOutput(toolPayload(), { ...base, fetchImpl, incognito });
      return out ? JSON.parse(out).hookSpecificOutput : null;
    };

    const listed = await reason({ incognito_agents: ["claude"], sessions: {} });
    expect(listed).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(listed.permissionDecisionReason).toContain("'dosu knowledge incognito off claude'");
    expect(listed.permissionDecisionReason).not.toContain("/dosu-incognito");
    // A session the switch settled stays denied once it is off: nothing turns it back on.
    const sealed = await reason({ sessions: settledByAgent("claude/sess-1") });
    expect(sealed.permissionDecisionReason).toContain("ran while its agent was incognito");
    expect(sealed.permissionDecisionReason).not.toContain("incognito off");
    // The call never reaches the proxy, so there is no session to record for it.
    expect(existsSync(join(getConfigDir(), "mcp-calls", "toolu_1.json"))).toBe(false);

    // Another agent's switch leaves Claude Code's calls to go on as usual.
    expect(await reason({ incognito_agents: ["codex"], sessions: {} })).toBeNull();
    expect(existsSync(join(getConfigDir(), "mcp-calls", "toolu_1.json"))).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves the decision to Claude Code otherwise, and other tools alone", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-pretool-")));
    vi.stubEnv("XDG_CONFIG_HOME", home);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });
    const fetchImpl = respond(200, {});
    expect(await contextHookOutput(toolPayload(), { ...base, fetchImpl })).toBe("");
    const offTheRecord = { ...base, isIncognito: () => true, fetchImpl };
    expect(await contextHookOutput(toolPayload({ tool_name: "Bash" }), offTheRecord)).toBe("");
    expect(
      await contextHookOutput(
        toolPayload({ tool_name: "mcp__dosu__read_knowledge" }),
        offTheRecord,
      ),
    ).toBe("");
    // Another server's tools of the same names are not Dosu's to stop, or to record for its proxy.
    const elsewhere = toolPayload({
      tool_name: "mcp__mem0__search_memory",
      tool_use_id: "toolu_m",
    });
    expect(await contextHookOutput(elsewhere, offTheRecord)).toBe("");
    expect(await contextHookOutput(elsewhere, { ...base, fetchImpl })).toBe("");
    expect(existsSync(join(getConfigDir(), "mcp-calls", "toolu_m.json"))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
