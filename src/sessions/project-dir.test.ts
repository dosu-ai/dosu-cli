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
