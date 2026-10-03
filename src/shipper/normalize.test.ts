import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import type { AgentSession } from "../sessions/scan";
import { normalizeSessionRecords, redactRecords } from "./normalize";

let dir: string;

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz012345";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-ship-normalize-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
