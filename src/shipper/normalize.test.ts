import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import type { AgentSession } from "../sessions/scan";
import { normalizeSessionRecords, redactRecords } from "./normalize";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-ship-normalize-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

/** A minimal real Claude Code transcript: prose, a tool call, and its result. */
function claudeTranscript(): string {
  return [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: "/repo/app",
      gitBranch: "main",
      sessionId: "sess1",
      message: { role: "user", content: 'How does auth work? password: "hunter2secretvalue42"' },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-01T00:00:05.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Token is ${GITHUB_TOKEN} here.` }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-09-01T00:00:06.000Z",
      sessionId: "sess1",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [
          {
            type: "tool_use",
            id: "toolu_01AbCdEfGhJkLmNpQr",
            name: "Read",
            input: { file_path: "/repo/app/auth.ts" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-01T00:00:07.000Z",
      sessionId: "sess1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01AbCdEfGhJkLmNpQr",
            content: "export const KEY = 1;",
          },
        ],
      },
    }),
  ].join("\n");
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  const path = join(dir, "sess1.jsonl");
  writeFileSync(path, claudeTranscript());
  return {
    id: "sess1",
    harness: "claude",
    path,
    updated: "2026-09-01T00:00:07.000Z",
    ...overrides,
  };
}

describe("normalizeSessionRecords", () => {
  it("normalizes a claude session to trajectory-v1 with the meta record first", async () => {
    const records = await normalizeSessionRecords(session());

    expect(records).not.toBeNull();
    expect(records?.[0]).toMatchObject({
      role: "meta",
      source: "claude-code",
      cwd: "/repo/app",
      git_branch: "main",
    });
    expect(records?.map((r) => r.role)).toEqual(["meta", "user", "assistant", "assistant", "tool"]);
  });

  it("redacts every text that ships — prose, and keeps tool linkage intact", async () => {
    const records = await normalizeSessionRecords(session());

    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain(GITHUB_TOKEN);
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).toContain("[redacted:github-token]");
    expect(shipped).toContain("[redacted:credential]");
    // The entropy pass must not touch the structural ids that link call to result.
    const call = records?.find((r) => "tool_calls" in r && r.tool_calls) as {
      tool_calls: { id: string }[];
    };
    const result = records?.find((r) => r.role === "tool") as { tool_call_id: string };
    expect(call.tool_calls[0].id).toBe("toolu_01AbCdEfGhJkLmNpQr");
    expect(result.tool_call_id).toBe("toolu_01AbCdEfGhJkLmNpQr");
  });

  it("keeps a Claude Code task notification, in place, as what the agent observed", async () => {
    const path = join(dir, "bg.jsonl");
    const row = (uuid: string, type: string, content: unknown, extra = {}) =>
      JSON.stringify({
        type,
        uuid,
        timestamp: `2026-09-01T00:00:0${uuid.slice(-1)}.000Z`,
        sessionId: "bg",
        message: { role: type, content },
        ...extra,
      });
    const notification =
      "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
      "<result>README.md has 4 lines.</result>\n</task-notification>";
    writeFileSync(
      path,
      [
        row("u1", "user", "Launch a background agent to count README lines."),
        row("a2", "assistant", [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }]),
        row("u3", "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "launched" }]),
        row("u4", "user", notification, { origin: { kind: "task-notification" } }),
        // The same notification as content blocks, as a queued prompt can record it.
        row("u5", "user", [{ type: "text", text: notification }]),
        row("a6", "assistant", [{ type: "text", text: "The agent counted 4 lines." }]),
      ].join("\n"),
    );

    const records = await normalizeSessionRecords(session({ path }));

    expect(records?.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "observation",
      "observation",
      "assistant",
    ]);
    expect(records?.[4]).toEqual({
      role: "observation",
      content: notification,
      timestamp: "2026-09-01T00:00:04.000Z",
    });
  });

  it("keeps input queued while the agent was busy: what nobody typed as observations, the user's as user records", async () => {
    const path = join(dir, "busy.jsonl");
    const row = (uuid: string, type: string, content: unknown) =>
      JSON.stringify({
        type,
        uuid,
        timestamp: `2026-09-01T00:00:${uuid.slice(1)}.000Z`,
        sessionId: "busy",
        message: { role: type, content },
      });
    /** Claude Code's record of input that arrived mid-turn: an attachment the adapter skips. */
    const queued = (uuid: string, attachment: Record<string, unknown>, timestamp: string) =>
      JSON.stringify({
        type: "attachment",
        uuid,
        timestamp,
        sessionId: "busy",
        isSidechain: false,
        attachment: { type: "queued_command", ...attachment },
      });
    const notification =
      "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n" +
      "<result>LINES=18 MARKER=OSPREY-5521</result>\n</task-notification>";
    const peer = '<agent-message from="planner">The schema change is merged.</agent-message>';
    writeFileSync(
      path,
      [
        row("u10", "user", "Count the lines in a background agent, then sleep 60."),
        row("a11", "assistant", [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }]),
        row("u12", "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "launched" }]),
        row("a13", "assistant", [{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }]),
        row("u14", "user", [{ type: "tool_result", tool_use_id: "toolu_2", content: "slept" }]),
        // Logged after the sleep it waited out, stamped when the agent finished during it.
        queued(
          "q15",
          {
            prompt: notification,
            commandMode: "task-notification",
            origin: { kind: "task-notification" },
          },
          "2026-09-01T00:00:13.500Z",
        ),
        queued(
          "q16",
          { prompt: "Also check the CHANGELOG.", commandMode: "prompt", origin: { kind: "human" } },
          "2026-09-01T00:00:16.000Z",
        ),
        queued(
          "q17",
          { prompt: peer, isMeta: true, origin: { kind: "peer" } },
          "2026-09-01T00:00:17.000Z",
        ),
        // Any other attachment is still transport.
        JSON.stringify({
          type: "attachment",
          uuid: "x18",
          timestamp: "2026-09-01T00:00:18.000Z",
          attachment: { type: "hook_additional_context", content: ["Dosu memory: PELICAN"] },
        }),
        row("a19", "assistant", [{ type: "text", text: "LINES=18; the CHANGELOG is current." }]),
      ].join("\n"),
    );

    const records = await normalizeSessionRecords(session({ path }));

    expect(records?.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "observation",
      "user",
      "observation",
      "assistant",
    ]);
    expect(records?.slice(6, 9)).toEqual([
      { role: "observation", content: notification, timestamp: "2026-09-01T00:00:13.500Z" },
      { role: "user", content: "Also check the CHANGELOG.", timestamp: "2026-09-01T00:00:16.000Z" },
      { role: "observation", content: peer, timestamp: "2026-09-01T00:00:17.000Z" },
    ]);
    expect(JSON.stringify(records)).not.toContain("PELICAN");
  });

  it("returns null for an unreadable transcript", async () => {
    expect(await normalizeSessionRecords(session({ path: join(dir, "missing.jsonl") }))).toBeNull();
  });

  it("returns no records for an empty transcript", async () => {
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "\n\n");
    expect(await normalizeSessionRecords(session({ path }))).toEqual([]);
  });

  it("returns no records for a transcript with no conversation in it", async () => {
    const path = join(dir, "junk.jsonl");
    // Parseable JSONL with no user turn: the adapter refuses it, which only means "nothing here".
    writeFileSync(path, `${JSON.stringify({ type: "summary", summary: "nothing" })}\n`);
    expect(await normalizeSessionRecords(session({ path }))).toEqual([]);
  });

  it("returns null when the adapter fails for any other reason, instead of throwing", async () => {
    const path = join(dir, "ok.jsonl");
    writeFileSync(path, "{}\n");
    vi.resetModules();
    vi.doMock("@letta-ai/trajectory", () => ({
      normalizeTranscript: () => {
        throw new Error("parser bug");
      },
    }));
    try {
      const fresh = await import("./normalize");
      expect(await fresh.normalizeSessionRecords(session({ path }))).toBeNull();
    } finally {
      vi.doUnmock("@letta-ai/trajectory");
      vi.resetModules();
    }
  });
});

/** A Codex rollout as 0.160 writes it: one JSON line per item, each with its `ordinal`. */
function codexSession(items: Record<string, unknown>[]): AgentSession {
  const path = join(dir, "rollout-2026-10-02T18-50-38-01a0ff74-c903-73c2-b6b1-7546b84710ff.jsonl");
  const at = "2026-10-02T10:00:00.000Z";
  writeFileSync(
    path,
    `${items.map((item, ordinal) => JSON.stringify({ timestamp: at, ordinal, ...item })).join("\n")}\n`,
  );
  return { id: "rollout-x", harness: "codex", path, updated: at };
}

function codexMeta(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: { id, timestamp: "2026-10-02T10:00:00.000Z", cwd: "/repo/app", ...extra },
  };
}

function codexMessage(role: string, text: string): Record<string, unknown> {
  const type = role === "assistant" ? "output_text" : "input_text";
  return { type: "response_item", payload: { type: "message", role, content: [{ type, text }] } };
}

describe("normalizeSessionRecords for Codex", () => {
  it("keeps a subagent's report to its parent as an observation, not as something the user said", async () => {
    const report =
      '<subagent_notification>\n{"agent_path":"01a0ff74-c903","status":{"completed":"Wrote test_calc.py"}}';
    const records = await normalizeSessionRecords(
      codexSession([
        codexMeta("01a0ff74-a68d-7ad0-83ee-80cf02c29b14"),
        codexMessage("user", "Spawn a subagent to write the tests"),
        codexMessage("assistant", "Spawned one."),
        codexMessage("user", report),
        codexMessage("assistant", "The subagent wrote the tests."),
      ]),
    );

    expect(records?.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "observation",
      "assistant",
    ]);
    expect(records?.[3]).toMatchObject({ role: "observation", content: report });
  });

  it("ships a forked subagent without the parent history its rollout copies", async () => {
    const parent = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const records = await normalizeSessionRecords(
      codexSession([
        codexMeta("01a0ff74-c903-73c2-b6b1-7546b84710ff", {
          forked_from_id: parent,
          parent_thread_id: parent,
          thread_source: "subagent",
          subagent_history_start_ordinal: 4,
        }),
        // Ordinals 1-3: the parent's history, copied in when the subagent was spawned.
        codexMeta(parent, { thread_source: "user" }),
        codexMessage("user", "Spawn a subagent to write the tests"),
        codexMessage("assistant", "Spawning one."),
        codexMessage("user", "Write test_calc.py for calc.py"),
        codexMessage("assistant", "Wrote test_calc.py."),
      ]),
    );

    expect(records?.filter((r) => r.role !== "meta").map((r) => r.content)).toEqual([
      "Write test_calc.py for calc.py",
      "Wrote test_calc.py.",
    ]);
  });
});

const OPENCODE_ID = "ses_0ff3fixture00001";

/** A session whose prompt carries a password, whose answer carries a token, and whose user message
 * Dosu's plugin added a memory digest to. */
function doc() {
  return opencodeDocument({
    id: OPENCODE_ID,
    user: 'How does auth work? password: "hunter2secretvalue42"',
    answer: `Auth reads KEY; the token is ${GITHUB_TOKEN} here.`,
    memory: "Dosu memory: the deploy codeword is PELICAN-0",
  });
}

describe("normalizeSessionRecords for opencode", () => {
  let bin: string;
  let dbPath: string;
  let opencode: AgentSession;

  beforeEach(() => {
    bin = join(dir, "bin");
    mkdirSync(bin);
    dbPath = join(dir, "opencode.db");
    opencode = {
      id: OPENCODE_ID,
      harness: "opencode",
      path: dbPath,
      project: "/repo/app",
      updated: "2026-09-01T00:00:00.000Z",
    };
    vi.stubEnv("PATH", bin);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** An `opencode` on PATH that records its arguments, prints `stdout`, and exits `code`. */
  function fakeOpencode(stdout: string, code = 0): string {
    const out = join(dir, "export.json");
    const argsFile = join(dir, "args.txt");
    writeFileSync(out, stdout);
    const script = join(bin, "opencode");
    writeFileSync(
      script,
      `#!/bin/sh\necho "$@" > '${argsFile}'\n/bin/cat '${out}'\necho "Exporting session: $3" >&2\nexit ${code}\n`,
    );
    chmodSync(script, 0o755);
    return argsFile;
  }

  it("normalizes `opencode export`, leaving out the memory Dosu pushed into the prompt", async () => {
    const args = fakeOpencode(JSON.stringify(doc(), null, 2));

    const records = await normalizeSessionRecords(opencode);

    expect(readFileSync(args, "utf8").trim()).toBe(`export --pure ${OPENCODE_ID}`);
    expect(records?.[0]).toMatchObject({ role: "meta", source: "opencode", cwd: "/repo/app" });
    expect(records?.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
    const shipped = JSON.stringify(records);
    expect(shipped).not.toContain("PELICAN");
    expect(shipped).not.toContain("hunter2secretvalue42");
    expect(shipped).not.toContain(GITHUB_TOKEN);
    expect(shipped).toContain("toolu_0156L5aHDegRahdNMdG7zTv9");
  });

  it("rebuilds the same records from the sqlite DB when no opencode binary is on PATH", async () => {
    if (!makeOpencodeDb(dbPath, doc())) return; // no sqlite builtin
    fakeOpencode(JSON.stringify(doc()));
    const exported = await normalizeSessionRecords(opencode);
    rmSync(join(bin, "opencode"));

    const rebuilt = await normalizeSessionRecords(opencode);

    expect(rebuilt).not.toBeNull();
    expect(rebuilt).toEqual(exported);
  });

  it("falls back to the DB when the export fails or answers for another session", async () => {
    if (!makeOpencodeDb(dbPath, doc())) return;
    rmSync(join(bin), { recursive: true });
    mkdirSync(bin);
    const fromDb = await normalizeSessionRecords(opencode);

    fakeOpencode("Error: Session not found", 1);
    expect(await normalizeSessionRecords(opencode)).toEqual(fromDb);

    const other = opencodeDocument({ id: "ses_someoneelse", user: "a different conversation" });
    fakeOpencode(JSON.stringify(other));
    expect(await normalizeSessionRecords(opencode)).toEqual(fromDb);

    fakeOpencode("not json");
    expect(await normalizeSessionRecords(opencode)).toEqual(fromDb);
  });

  it("rebuilds around DB rows it cannot parse", async () => {
    const t = 1790963950000;
    const created = makeOpencodeDb(dbPath, doc(), [
      `INSERT INTO message VALUES ('msg_${OPENCODE_ID}_9', '${OPENCODE_ID}', ${t}, ${t}, 'not json')`,
      `INSERT INTO part VALUES ('prt_${OPENCODE_ID}_9', 'msg_${OPENCODE_ID}_3', '${OPENCODE_ID}', ${t}, ${t}, '[1]')`,
    ]);
    if (!created) return;

    const records = await normalizeSessionRecords(opencode);

    expect(records?.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("returns null for a session neither the export nor the DB has", async () => {
    if (!makeOpencodeDb(dbPath, doc())) return;

    expect(await normalizeSessionRecords({ ...opencode, id: "ses_missing" })).toBeNull();
    expect(await normalizeSessionRecords({ ...opencode, id: "ses_x' OR '1'='1" })).toBeNull();
    expect(await normalizeSessionRecords({ ...opencode, path: join(dir, "nope.db") })).toBeNull();
  });
});

describe("redactRecords", () => {
  it("redacts tool args and content but never structural keys", () => {
    const records = [
      { role: "meta", source: "claude-code", cwd: "/repo/app" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_01AbCdEfGhJkLmNpQr",
            name: "Bash",
            args: `{"command":"export API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456"}`,
          },
        ],
        timestamp: "2026-09-01T00:00:06.000Z",
      },
    ] as unknown as NormalizedRecord[];

    const redacted = redactRecords(records);
    const shipped = JSON.stringify(redacted);

    expect(shipped).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(shipped).toContain("[redacted:");
    expect(shipped).toContain("toolu_01AbCdEfGhJkLmNpQr");
    expect(shipped).toContain('"name":"Bash"');
    // The input records are not mutated.
    expect(JSON.stringify(records)).toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});
