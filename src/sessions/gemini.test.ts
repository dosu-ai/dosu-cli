import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  geminiChatsDirOf,
  geminiContentText,
  geminiDocumentOf,
  geminiParentIdOfPath,
  geminiProjectDirOf,
  geminiProjectRootFileOf,
  geminiSessionIdOfPath,
  geminiTempDir,
  geminiTranscript,
  isGeminiTranscriptName,
  readGeminiSessionId,
} from "./gemini";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-gemini-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const META = {
  sessionId: "2f1e4c9a-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
  projectHash: "abc123",
  startTime: "2026-10-13T12:00:00.000Z",
  lastUpdated: "2026-10-13T12:00:00.000Z",
};

function user(id: string, text: string) {
  return { id, timestamp: "2026-10-13T12:00:01.000Z", type: "user", content: [{ text }] };
}

function gemini(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    timestamp: "2026-10-13T12:00:02.000Z",
    type: "gemini",
    content: [{ text }],
    model: "gemini-2.5-pro",
    ...extra,
  };
}

function log(...records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("layout", () => {
  it("keeps sessions under <home>/.gemini/tmp, relocated by GEMINI_CLI_HOME", () => {
    expect(geminiTempDir("/home/me", {})).toBe("/home/me/.gemini/tmp");
    expect(geminiTempDir("/home/me", { GEMINI_CLI_HOME: "/srv/gemini" })).toBe(
      "/srv/gemini/.gemini/tmp",
    );
    expect(geminiTempDir("/home/me", { GEMINI_CLI_HOME: "" })).toBe("/home/me/.gemini/tmp");
  });

  it("names transcripts by the current log or the legacy document, never the leftovers", () => {
    expect(isGeminiTranscriptName("session-2026-10-13T12-00-2f1e4c9a.jsonl")).toBe(true);
    expect(isGeminiTranscriptName("session-2026-10-13T12-00-2f1e4c9a.json")).toBe(true);
    expect(isGeminiTranscriptName("session-x.jsonl.tmp-123")).toBe(false);
    expect(isGeminiTranscriptName("session-x.jsonl.unreadable-1760000000")).toBe(false);
  });

  it("keys a session by its file stem, for either extension", () => {
    expect(geminiSessionIdOfPath("/t/p/chats/session-2026-10-13T12-00-2f1e4c9a.jsonl")).toBe(
      "session-2026-10-13T12-00-2f1e4c9a",
    );
    expect(geminiSessionIdOfPath("/t/p/chats/session-2026-10-13T12-00-2f1e4c9a.json")).toBe(
      "session-2026-10-13T12-00-2f1e4c9a",
    );
  });

  it("finds the chats dir of a session's and a subagent's transcript, and the parent id", () => {
    const chats = "/home/me/.gemini/tmp/proj/chats";
    expect(geminiChatsDirOf(`${chats}/session-1.jsonl`)).toBe(chats);
    expect(geminiChatsDirOf(`${chats}/parent-id/child-id.jsonl`)).toBe(chats);
    expect(geminiChatsDirOf("/home/me/.claude/projects/x/session-1.jsonl")).toBeNull();
    expect(geminiParentIdOfPath(`${chats}/session-1.jsonl`)).toBeUndefined();
    expect(geminiParentIdOfPath(`${chats}/parent-id/child-id.jsonl`)).toBe("parent-id");
    expect(geminiParentIdOfPath("/elsewhere/a/b.jsonl")).toBeUndefined();
  });

  it("reads the project directory from the slug dir's root marker", () => {
    const project = join(home, ".gemini", "tmp", "proj");
    const path = join(project, "chats", "session-1.jsonl");
    mkdirSync(join(project, "chats"), { recursive: true });
    expect(geminiProjectRootFileOf(path)).toBe(join(project, ".project_root"));
    expect(geminiProjectRootFileOf("/elsewhere/session-1.jsonl")).toBeNull();
    expect(geminiProjectDirOf("/elsewhere/session-1.jsonl")).toBeNull();
    // A project dir from before 0.63 has no marker.
    expect(geminiProjectDirOf(path)).toBeNull();
    writeFileSync(join(project, ".project_root"), "/Users/me/proj\n");
    expect(geminiProjectDirOf(path)).toBe("/Users/me/proj");
    writeFileSync(join(project, ".project_root"), "relative");
    expect(geminiProjectDirOf(path)).toBeNull();
  });

  it("reads the session id off the metadata line", () => {
    const path = join(home, "session-1.jsonl");
    writeFileSync(path, log(META, user("m1", "hi")));
    expect(readGeminiSessionId(path)).toBe(META.sessionId);
    writeFileSync(path, JSON.stringify({ ...META, messages: [] }));
    expect(readGeminiSessionId(path)).toBe(META.sessionId);
    writeFileSync(path, log(user("m1", "hi")));
    expect(readGeminiSessionId(path)).toBeNull();
    expect(readGeminiSessionId(join(home, "missing.jsonl"))).toBeNull();
  });
});

describe("geminiDocumentOf", () => {
  it("folds the log into the document: metadata line, then messages in order", () => {
    const doc = geminiDocumentOf(log(META, user("m1", "hi"), gemini("m2", "hello")));
    expect(doc).toEqual({ ...META, messages: [user("m1", "hi"), gemini("m2", "hello")] });
  });

  it("replaces a message re-appended under its id, in its original place", () => {
    const call = { id: "c1", name: "read_file", args: { path: "a" }, status: "executing" };
    const done = { ...call, status: "success", result: [{ functionResponse: {} }] };
    const doc = geminiDocumentOf(
      log(
        META,
        user("m1", "hi"),
        gemini("m2", "", { toolCalls: [call] }),
        user("m3", "next"),
        gemini("m2", "", { toolCalls: [done] }),
      ),
    );
    expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(doc?.messages[1].toolCalls).toEqual([done]);
  });

  it("applies $set metadata updates, and a messages checkpoint replaces the history", () => {
    const doc = geminiDocumentOf(
      log(
        META,
        user("m1", "hi"),
        { $set: { sessionId: "resumed-id", summary: "Hi" } },
        { $set: { messages: [user("m9", "compressed")] } },
        gemini("m10", "after"),
      ),
    );
    expect(doc).toMatchObject({ sessionId: "resumed-id", summary: "Hi", projectHash: "abc123" });
    expect(doc?.messages.map((m) => m.id)).toEqual(["m9", "m10"]);
  });

  it("drops the rewound message and every later one; an unknown target clears all", () => {
    const base = [META, user("m1", "a"), gemini("m2", "b"), user("m3", "c")];
    expect(
      geminiDocumentOf(log(...base, { $rewindTo: "m2" }, user("m4", "d")))?.messages.map(
        (m) => m.id,
      ),
    ).toEqual(["m1", "m4"]);
    expect(
      geminiDocumentOf(log(...base, { $rewindTo: "nope" }))?.messages.map((m) => m.id),
    ).toEqual([]);
  });

  it("applies $patch edits: a single update, a batch, removals, and reordering", () => {
    const call = { id: "c1", name: "glob", args: {}, status: "executing" };
    const doc = geminiDocumentOf(
      log(
        META,
        user("m1", "a"),
        gemini("m2", "b", { toolCalls: [call, 7] }),
        user("m3", "c"),
        user("m4", "d"),
        { $patch: { id: "m2", toolCalls: [{ id: "c1", status: "success" }, { id: "zz" }, 1] } },
        { $patch: { updates: [{ id: "m1", content: [{ text: "A" }] }, { id: "gone" }, "x"] } },
        { $patch: { removeIds: ["m3", 5] } },
        { $patch: { orderIds: ["m4", "m1", "missing", 3] } },
      ),
    );
    expect(doc?.messages.map((m) => m.id)).toEqual(["m2", "m4", "m1"]);
    expect(doc?.messages[0].toolCalls).toEqual([{ ...call, status: "success" }, 7]);
    expect(doc?.messages[2].content).toEqual([{ text: "A" }]);
  });

  it("ignores a tool-call patch on a message that recorded no calls, as Gemini CLI does", () => {
    const doc = geminiDocumentOf(
      log(META, gemini("m2", "b"), { $patch: { id: "m2", toolCalls: [{ id: "c1" }] } }),
    );
    expect(doc?.messages[0].toolCalls).toBeUndefined();
  });

  it("skips lines it cannot parse and records it cannot place", () => {
    const doc = geminiDocumentOf(
      `${log(META, user("m1", "a"))}{"half": tru\n[1,2]\n"str"\n${log({ note: "none" })}`,
    );
    expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("reads the legacy whole-session document, on one line or pretty-printed", () => {
    const legacy = { ...META, messages: [user("m1", "a"), { bogus: true }, gemini("m2", "b")] };
    expect(geminiDocumentOf(JSON.stringify(legacy))).toEqual({
      ...META,
      messages: [user("m1", "a"), gemini("m2", "b")],
    });
    expect(geminiDocumentOf(JSON.stringify(legacy, null, 2))).toEqual(legacy);
  });

  it("is null for an empty file, a document with no messages, or no JSON at all", () => {
    expect(geminiDocumentOf("")).toBeNull();
    expect(geminiDocumentOf("  \n")).toBeNull();
    expect(geminiDocumentOf(JSON.stringify({ ...META }, null, 2))).toBeNull();
    expect(geminiDocumentOf(JSON.stringify([1, 2], null, 2))).toBeNull();
    expect(geminiDocumentOf("not json\nat all")).toBeNull();
  });
});

describe("geminiTranscript", () => {
  it("serializes the folded document for the adapter", () => {
    const path = join(home, "session-1.jsonl");
    writeFileSync(path, log(META, user("m1", "hi")));
    expect(JSON.parse(geminiTranscript(path) ?? "")).toEqual({
      ...META,
      messages: [user("m1", "hi")],
    });
  });

  it("is empty for an empty file, null when unreadable or not a transcript", () => {
    const path = join(home, "session-1.jsonl");
    writeFileSync(path, "\n");
    expect(geminiTranscript(path)).toBe("");
    writeFileSync(path, "garbage\n");
    expect(geminiTranscript(path)).toBeNull();
    expect(geminiTranscript(join(home, "missing.jsonl"))).toBeNull();
  });
});

describe("geminiContentText", () => {
  it("takes a string, a part, or parts, text parts only", () => {
    expect(geminiContentText("plain")).toBe("plain");
    expect(geminiContentText({ text: "one" })).toBe("one");
    expect(geminiContentText([{ text: "a" }, { inlineData: {} }, "x", { text: "b" }])).toBe("a\nb");
    expect(geminiContentText(undefined)).toBe("");
  });
});
