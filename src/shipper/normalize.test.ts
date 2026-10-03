import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("returns null for opencode sessions (sqlite rows are not the adapter's export shape)", async () => {
    expect(
      await normalizeSessionRecords(session({ harness: "opencode", path: join(dir, "db") })),
    ).toBeNull();
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
