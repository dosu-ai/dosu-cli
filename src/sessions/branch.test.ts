import { describe, expect, it, vi } from "vitest";
import {
  branchFromClaudeTranscript,
  branchFromCodexTranscript,
  branchFromReflog,
  parseReflog,
} from "./branch";

const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");

describe("branchFromClaudeTranscript", () => {
  it("takes the last recorded branch, skipping detached HEAD and empty values", () => {
    const text = lines(
      { type: "user", gitBranch: "main" },
      { type: "assistant", gitBranch: "feat/new" },
      { type: "user", gitBranch: "HEAD" },
      { type: "user", gitBranch: "" },
    );
    expect(branchFromClaudeTranscript(text)).toBe("feat/new");
  });

  it("unescapes branch names and ignores malformed escapes", () => {
    expect(branchFromClaudeTranscript(lines({ gitBranch: 'we"ird' }))).toBe('we"ird');
    expect(branchFromClaudeTranscript('{"gitBranch":"main"}\n{"gitBranch":"bad\\q"}')).toBe("main");
  });

  it("is null when no line names a real branch", () => {
    expect(
      branchFromClaudeTranscript(lines({ gitBranch: "HEAD" }, { type: "summary" })),
    ).toBeNull();
    expect(branchFromClaudeTranscript("")).toBeNull();
  });
});

describe("branchFromCodexTranscript", () => {
  it("reads session_meta.payload.git.branch", () => {
    const text = lines(
      { type: "session_meta", payload: { cwd: "/r", git: { branch: "feat/x", commit_hash: "a" } } },
      { type: "response_item", payload: { git: { branch: "not-this" } } },
    );
    expect(branchFromCodexTranscript(text)).toBe("feat/x");
  });

  it("is null outside a repo, on a detached HEAD, or without a meta line", () => {
    expect(branchFromCodexTranscript(lines({ type: "session_meta", payload: { git: null } }))).toBe(
      null,
    );
    expect(
      branchFromCodexTranscript(
        lines({ type: "session_meta", payload: { git: { branch: "HEAD" } } }),
      ),
    ).toBeNull();
    expect(branchFromCodexTranscript(lines({ type: "response_item" }))).toBeNull();
    expect(branchFromCodexTranscript('{"type":"session_meta", "payload": {')).toBeNull();
    expect(branchFromCodexTranscript(lines({ note: "session_meta" }))).toBeNull();
  });
});

describe("parseReflog", () => {
  it("parses unix-dated entries and skips anything else", () => {
    expect(
      parseReflog("HEAD@{200}\tcheckout: moving from a to b\nnoise\nHEAD@{100}\tcommit: x\n"),
    ).toEqual([
      { at: 200, subject: "checkout: moving from a to b" },
      { at: 100, subject: "commit: x" },
    ]);
  });
});

describe("branchFromReflog", () => {
  // Newest first, as git prints it.
  const reflog = parseReflog(
    [
      "HEAD@{500}\tcommit: later work",
      "HEAD@{400}\tcheckout: moving from feat/b to main",
      "HEAD@{300}\tcommit: on b",
      "HEAD@{200}\tcheckout: moving from feat/a to feat/b",
      "HEAD@{100}\tcommit: initial",
    ].join("\n"),
  );
  const current = vi.fn(() => "current");

  it("uses the target of the last checkout before the session ended", () => {
    expect(branchFromReflog(reflog, 350, current)).toBe("feat/b");
    expect(branchFromReflog(reflog, 400, current)).toBe("main");
    expect(branchFromReflog(reflog, 900, current)).toBe("main");
  });

  it("uses the source of the first checkout after it when none precedes it", () => {
    expect(branchFromReflog(reflog, 150, current)).toBe("feat/a");
  });

  it("uses the current branch only when the reflog has no checkout at all", () => {
    const commits = parseReflog("HEAD@{300}\tcommit: b\nHEAD@{100}\tcommit: a");
    expect(branchFromReflog(commits, 200, current)).toBe("current");
    expect(current).toHaveBeenCalledTimes(1);
    expect(branchFromReflog(reflog, 350, current)).toBe("feat/b");
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("is unknown before the oldest entry, with an empty reflog, or on a detached checkout", () => {
    expect(branchFromReflog(reflog, 50, current)).toBeNull();
    expect(branchFromReflog([], 350, current)).toBeNull();
    const detached = parseReflog(
      "HEAD@{300}\tcheckout: moving from main to 0f085d1\nHEAD@{100}\tcheckout: moving from x to main",
    );
    expect(branchFromReflog(detached, 400, current)).toBeNull();
  });

  it("breaks timestamp ties toward the later (newer-listed) checkout", () => {
    const sameSecond = parseReflog(
      [
        "HEAD@{300}\tcheckout: moving from b to c",
        "HEAD@{300}\tcheckout: moving from a to b",
        "HEAD@{100}\tcommit: x",
      ].join("\n"),
    );
    expect(branchFromReflog(sameSecond, 300, current)).toBe("c");
    expect(branchFromReflog(sameSecond, 200, current)).toBe("a");
  });
});
