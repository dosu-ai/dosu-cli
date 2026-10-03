import { describe, expect, it, vi } from "vitest";
import { branchFromReflog, parseReflog, recordedBranch } from "./branch";

describe("recordedBranch", () => {
  it("takes a recorded name, not a detached HEAD, an empty value, or a non-string", () => {
    expect(recordedBranch(" feat/x ")).toBe("feat/x");
    expect(recordedBranch("HEAD")).toBeNull();
    expect(recordedBranch("")).toBeNull();
    expect(recordedBranch(undefined)).toBeNull();
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

  it("takes the earliest later checkout even when the reflog is out of time order", () => {
    const skewed = parseReflog(
      [
        "HEAD@{250}\tcheckout: moving from feat/a to b",
        "HEAD@{300}\tcheckout: moving from c to d",
        "HEAD@{100}\tcommit: x",
      ].join("\n"),
    );
    expect(branchFromReflog(skewed, 150, current)).toBe("feat/a");
  });
});
