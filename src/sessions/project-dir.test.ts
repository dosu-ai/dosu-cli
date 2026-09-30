import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectDirResolver, cwdFromJsonlHead, unmungeSlug } from "./project-dir";
import type { AgentSession } from "./scan";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-projdir-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function session(overrides: Partial<AgentSession> & { harness: AgentSession["harness"] }) {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    path: join(tempDir, "missing.jsonl"),
    updated: "2026-08-25T11:00:00Z",
    ...overrides,
  } as AgentSession;
}

describe("cwdFromJsonlHead", () => {
  it("finds a top-level cwd (Claude) past unrelated lines", () => {
    const text = [
      JSON.stringify({ type: "last-prompt", sessionId: "x" }),
      JSON.stringify({ type: "summary" }),
      JSON.stringify({ type: "user", cwd: "/Users/james/dev/app" }),
    ].join("\n");
    expect(cwdFromJsonlHead(text)).toBe("/Users/james/dev/app");
  });

  it("finds a Codex session_meta payload cwd", () => {
    const text = JSON.stringify({
      type: "session_meta",
      payload: { id: "x", cwd: "/repo/api" },
    });
    expect(cwdFromJsonlHead(text)).toBe("/repo/api");
  });

  it("ignores truncated lines and non-path cwd values", () => {
    const text = `${JSON.stringify({ cwd: "relative/path" })}\n{"cwd": "/tru`;
    expect(cwdFromJsonlHead(text)).toBeNull();
  });
});

describe("unmungeSlug", () => {
  // A filesystem where directory names themselves contain hyphens.
  const real = new Set([
    "/Users",
    "/Users/james",
    "/Users/james/Documents",
    "/Users/james/Documents/dosu-global",
    "/Users/james/Documents/dosu-global/dosu-cli",
  ]);
  const exists = (p: string) => real.has(p);

  it("resolves hyphenated directory names against the filesystem", () => {
    expect(unmungeSlug("Users-james-Documents-dosu-global-dosu-cli", exists)).toBe(
      "/Users/james/Documents/dosu-global/dosu-cli",
    );
  });

  it("accepts Claude's leading-dash form", () => {
    expect(unmungeSlug("-Users-james-Documents-dosu-global-dosu-cli", exists)).toBe(
      "/Users/james/Documents/dosu-global/dosu-cli",
    );
  });

  it("returns null when nothing on disk matches", () => {
    expect(unmungeSlug("Users-nobody-gone", exists)).toBeNull();
    expect(unmungeSlug("", exists)).toBeNull();
  });
});

describe("resolveRepo", () => {
  it("looks up each directory once and persists the repo per session", () => {
    const repoOfDir = vi.fn(() => "github.com/dosu-ai/dosu-cli");
    const resolver = createProjectDirResolver(tempDir, { repoOfDir });
    const a = session({ harness: "opencode", project: "/work/dosu-cli", id: "a" });
    const b = session({ harness: "opencode", project: "/work/dosu-cli", id: "b" });
    expect(resolver.resolveRepo(a)).toBe("github.com/dosu-ai/dosu-cli");
    expect(resolver.resolveRepo(b)).toBe("github.com/dosu-ai/dosu-cli");
    expect(resolver.resolveRepo(a)).toBe("github.com/dosu-ai/dosu-cli");
    expect(repoOfDir).toHaveBeenCalledTimes(1);
    resolver.flush();

    // The checkout may be gone by now; the cached repo still answers.
    const gone = vi.fn(() => null);
    const second = createProjectDirResolver(tempDir, { repoOfDir: gone });
    expect(second.resolveRepo(a)).toBe("github.com/dosu-ai/dosu-cli");
    expect(gone).not.toHaveBeenCalled();
  });

  it("is null without a directory, and retries a non-repo once the session file changes", () => {
    const repoOfDir = vi.fn<(dir: string) => string | null>(() => null);
    let mtime = "t1";
    const resolver = createProjectDirResolver(tempDir, { repoOfDir, mtime: () => mtime });
    expect(resolver.resolveRepo(session({ harness: "opencode" }))).toBeNull();
    expect(repoOfDir).not.toHaveBeenCalled();

    const s = session({ harness: "opencode", project: "/work/scratch", id: "s" });
    expect(resolver.resolveRepo(s)).toBeNull();
    resolver.flush();

    const later = createProjectDirResolver(tempDir, { repoOfDir, mtime: () => mtime });
    expect(later.resolveRepo(s)).toBeNull();
    expect(repoOfDir).toHaveBeenCalledTimes(1);

    mtime = "t2";
    repoOfDir.mockReturnValue("github.com/acme/scratch");
    const changed = createProjectDirResolver(tempDir, { repoOfDir, mtime: () => mtime });
    expect(changed.resolveRepo(s)).toBe("github.com/acme/scratch");
  });
});

describe("resolveBranch", () => {
  const noGit = {
    reflogOfDir: vi.fn(() => null),
    currentBranch: vi.fn(() => null),
    captured: vi.fn(() => null),
  };

  it("reads Claude and Codex branches from their transcripts before anything else", () => {
    const captured = vi.fn(() => ({ branch: "hook", at: "" }));
    const resolver = createProjectDirResolver(tempDir, {
      ...noGit,
      captured,
      readTranscript: (path) =>
        path === "/c.jsonl"
          ? JSON.stringify({ gitBranch: "feat/claude" })
          : JSON.stringify({ type: "session_meta", payload: { git: { branch: "feat/codex" } } }),
    });
    expect(resolver.resolveBranch(session({ harness: "claude", path: "/c.jsonl" }))).toBe(
      "feat/claude",
    );
    expect(resolver.resolveBranch(session({ harness: "codex", path: "/x.jsonl" }))).toBe(
      "feat/codex",
    );
    expect(captured).not.toHaveBeenCalled();
  });

  it("uses a hook-captured branch and directory for Cursor", () => {
    const captured = vi.fn((key: string) =>
      key === "cursor/c1" ? { dir: "/work/app", branch: "feat/cursor", at: "" } : null,
    );
    const resolver = createProjectDirResolver(tempDir, { ...noGit, captured });
    const s = session({ harness: "cursor", id: "c1", project: "gone-slug" });
    expect(resolver.resolve(s)).toBe("/work/app");
    expect(resolver.resolveBranch(s)).toBe("feat/cursor");
  });

  it("falls back to the reflog at the session's end, reading each directory's reflog once", () => {
    const end = Date.parse("2026-08-25T11:00:00Z") / 1000;
    const reflogOfDir = vi.fn(() =>
      [
        `HEAD@{${end + 60}}\tcheckout: moving from feat/r to main`,
        `HEAD@{${end - 60}}\tcheckout: moving from main to feat/r`,
      ].join("\n"),
    );
    const resolver = createProjectDirResolver(tempDir, {
      ...noGit,
      reflogOfDir,
      readTranscript: () => JSON.stringify({ gitBranch: "HEAD" }),
    });
    const a = session({ harness: "opencode", project: "/work/r" });
    const b = session({ harness: "claude", project: "-work-r", path: "/nope" });
    expect(resolver.resolveBranch(a)).toBe("feat/r");
    expect(resolver.resolveBranch({ ...a, id: "a2" })).toBe("feat/r");
    expect(reflogOfDir).toHaveBeenCalledTimes(1);
    // No cwd for b, so no reflog to consult.
    expect(resolver.resolveBranch(b)).toBeNull();
  });

  it("asks for the current branch once per directory when the reflog has no checkout", () => {
    const currentBranch = vi.fn(() => "trunk");
    const resolver = createProjectDirResolver(tempDir, {
      ...noGit,
      currentBranch,
      reflogOfDir: () => "HEAD@{1}\tcommit (initial): x",
    });
    const s = session({ harness: "opencode", project: "/work/t" });
    expect(resolver.resolveBranch(s)).toBe("trunk");
    expect(resolver.resolveBranch({ ...s, id: "t2" })).toBe("trunk");
    expect(currentBranch).toHaveBeenCalledTimes(1);
  });

  it("is null without a transcript, capture, directory, or parseable end time", () => {
    const resolver = createProjectDirResolver(tempDir, { ...noGit, readTranscript: () => null });
    expect(resolver.resolveBranch(session({ harness: "claude" }))).toBeNull();
    expect(
      resolver.resolveBranch(session({ harness: "opencode", project: "/w", updated: "bogus" })),
    ).toBeNull();
    expect(resolver.resolveBranch(session({ harness: "opencode", project: "/w" }))).toBeNull();
  });

  it("reads real transcripts and capture files by default", () => {
    const log = join(tempDir, "real.jsonl");
    writeFileSync(log, `${JSON.stringify({ gitBranch: "feat/real" })}\n`);
    const resolver = createProjectDirResolver(tempDir, { reflogOfDir: () => null });
    expect(resolver.resolveBranch(session({ harness: "claude", path: log }))).toBe("feat/real");

    mkdirSync(join(tempDir, "session-captures", "cursor"), { recursive: true });
    writeFileSync(
      join(tempDir, "session-captures", "cursor", "cur.json"),
      JSON.stringify({ branch: "feat/hooked", at: "" }),
    );
    expect(resolver.resolveBranch(session({ harness: "cursor", id: "cur" }))).toBe("feat/hooked");
  });
});

describe("createProjectDirResolver", () => {
  it("passes opencode directories through without any I/O", () => {
    const readHead = vi.fn();
    const resolver = createProjectDirResolver(tempDir, { readHead });
    const dir = resolver.resolve(session({ harness: "opencode", project: "/real/dir" }));
    expect(dir).toBe("/real/dir");
    expect(readHead).not.toHaveBeenCalled();
  });

  it("reads cwd from claude/codex heads and caches across instances", () => {
    const log = join(tempDir, "log.jsonl");
    writeFileSync(log, `${JSON.stringify({ type: "user", cwd: "/repo/app" })}\n`);
    const s = session({ harness: "claude", path: log, id: "fixed" });

    const first = createProjectDirResolver(tempDir);
    expect(first.resolve(s)).toBe("/repo/app");
    first.flush();

    // A fresh resolver hits the persisted cache instead of re-reading.
    const readHead = vi.fn();
    const second = createProjectDirResolver(tempDir, { readHead });
    expect(second.resolve(s)).toBe("/repo/app");
    expect(readHead).not.toHaveBeenCalled();
  });

  it("falls back to un-munging the claude project dir when the head has no cwd", () => {
    const log = join(tempDir, "log.jsonl");
    writeFileSync(log, `${JSON.stringify({ type: "summary" })}\n`);
    const target = join(tempDir, "work", "app");
    mkdirSync(target, { recursive: true });
    const slug = `-${target.slice(1).replaceAll("/", "-")}`;

    const resolver = createProjectDirResolver(tempDir);
    expect(resolver.resolve(session({ harness: "claude", path: log, project: slug }))).toBe(target);
  });

  it("resolves cursor slugs and buckets unresolvable sessions as null", () => {
    const target = join(tempDir, "proj");
    mkdirSync(target, { recursive: true });
    const slug = target.slice(1).replaceAll("/", "-");
    const resolver = createProjectDirResolver(tempDir);
    expect(resolver.resolve(session({ harness: "cursor", project: slug }))).toBe(target);
    expect(resolver.resolve(session({ harness: "cursor", project: "gone-away" }))).toBeNull();
    expect(resolver.resolve(session({ harness: "cursor" }))).toBeNull();
  });

  it("retries a failed resolution once the session file changes", () => {
    const log = join(tempDir, "young.jsonl");
    writeFileSync(log, `${JSON.stringify({ type: "queued" })}\n`);
    utimesSync(log, new Date("2026-01-01"), new Date("2026-01-01"));
    const s = session({ harness: "codex", path: log, id: "young" });

    const resolver = createProjectDirResolver(tempDir);
    expect(resolver.resolve(s)).toBeNull();
    resolver.flush();

    // The log grows its meta line later (mtime moves): the cache retries.
    writeFileSync(log, `${JSON.stringify({ payload: { cwd: "/repo/late" } })}\n`);
    const again = createProjectDirResolver(tempDir);
    expect(again.resolve(s)).toBe("/repo/late");
    // And an unchanged failure stays cached (no retry when mtime is stable).
    const readHead = vi.fn(() => null);
    utimesSync(log, new Date("2026-01-02"), new Date("2026-01-02"));
    const failing = createProjectDirResolver(tempDir, { readHead });
    expect(failing.resolve(s)).toBeNull();
    expect(readHead).toHaveBeenCalledTimes(1);
    failing.flush();
    const cachedFail = createProjectDirResolver(tempDir, { readHead });
    expect(cachedFail.resolve(s)).toBeNull();
    expect(readHead).toHaveBeenCalledTimes(1);
  });

  it("returns null for unreadable logs and unknown harnesses", () => {
    const resolver = createProjectDirResolver(tempDir);
    // Claude log gone and no project dir to fall back on.
    expect(resolver.resolve(session({ harness: "claude" }))).toBeNull();
    // Codex "log" that opens but can't be read as a file.
    expect(resolver.resolve(session({ harness: "codex", path: tempDir }))).toBeNull();
    expect(resolver.resolve(session({ harness: "future" as never }))).toBeNull();
  });

  it("ignores a corrupt or foreign-schema cache file", () => {
    const cache = join(tempDir, "project-dirs.json");
    writeFileSync(cache, "{not json");
    const first = createProjectDirResolver(tempDir);
    expect(first.resolve(session({ harness: "opencode", project: "/x" }))).toBe("/x");
    writeFileSync(cache, JSON.stringify({ schema_version: 99, entries: {} }));
    const second = createProjectDirResolver(tempDir);
    expect(second.resolve(session({ harness: "opencode", project: "/y" }))).toBe("/y");
  });

  it("swallows persistence failures (cache is only an optimization)", () => {
    // A config "dir" that is actually a file: the write must fail silently.
    const bogusDir = join(tempDir, "not-a-dir");
    writeFileSync(bogusDir, "occupied");
    const resolver = createProjectDirResolver(bogusDir);
    expect(resolver.resolve(session({ harness: "opencode", project: "/z" }))).toBe("/z");
    expect(() => resolver.flush()).not.toThrow();
  });

  it("flush is a no-op when nothing was resolved", () => {
    const resolver = createProjectDirResolver(tempDir);
    resolver.flush(); // must not throw or write
    expect(createProjectDirResolver(tempDir)).toBeDefined();
  });
});

describe("cached", () => {
  it("returns previously resolved directories by harness/id key without a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-projdir-"));
    const resolver = createProjectDirResolver(dir, {
      exists: () => true,
      readHead: () => JSON.stringify({ cwd: "/repos/dosu" }),
      mtime: () => "m1",
    });
    expect(resolver.cached("claude/s1")).toBeNull();
    resolver.resolve({
      id: "s1",
      harness: "claude",
      path: "/logs/s1.jsonl",
      updated: "2026-01-01T00:00:00.000Z",
    });
    expect(resolver.cached("claude/s1")).toBe("/repos/dosu");
    rmSync(dir, { recursive: true, force: true });
  });
});
