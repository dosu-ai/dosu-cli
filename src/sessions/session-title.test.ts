import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionTurn } from "./read";
import type { AgentSession } from "./scan";
import { createSessionTitleResolver, reconstructSession } from "./session-title";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-session-title-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function session(harness: AgentSession["harness"] = "claude"): AgentSession {
  return {
    id: "s1",
    harness,
    path: "/logs/s1.jsonl",
    updated: "2026-01-01T00:00:00.000Z",
  };
}

describe("createSessionTitleResolver", () => {
  it("prefers the claude summary line over the first user message", () => {
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => `${JSON.stringify({ type: "summary", summary: "Fix the auth race" })}\n`,
      readTurns: () => [{ role: "user", text: "hello" }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session())).toBe("Fix the auth race");
  });

  it("falls back to the first user message, collapsed and clipped", () => {
    const long = `why   does\n the sync ${"x".repeat(100)}`;
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () =>
        [
          { role: "assistant", text: "hi" },
          { role: "user", text: long },
        ] as SessionTurn[],
      mtime: () => "m1",
    });
    const name = resolver.resolve(session("cursor"));
    expect(name).toMatch(/^why does the sync x+…$/);
    expect(name?.length).toBeLessThanOrEqual(80);
  });

  it("unwraps cursor's tagged user query instead of showing the timestamp", () => {
    const wrapped =
      "<timestamp>Monday, Sep 14, 2026, 4:16 PM (UTC-7)</timestamp>\n" +
      "<user_query>\nhelp me test this pr\n</user_query>";
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () => [{ role: "user", text: wrapped }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session("cursor"))).toBe("help me test this pr");
  });

  it("strips leading metadata tags when no user_query wrapper exists", () => {
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () =>
        [
          { role: "user", text: "<timestamp>Sep 15</timestamp> fix the flaky test" },
        ] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session("cursor"))).toBe("fix the flaky test");
  });

  it("names a scheduled-task session after the task instead of its injected prompt", () => {
    const wrapped =
      '<scheduled-task name="dosu-cli-adoption-report" run="42">\n' +
      "You are in the Dosu monorepo. Produce the daily report…\n" +
      "</scheduled-task>";
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () => [{ role: "user", text: wrapped }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session())).toBe("dosu-cli-adoption-report");
  });

  it("caches by harness/id key and answers cache-only lookups", () => {
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () => [{ role: "user", text: "name me" }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.cached("claude/s1")).toBeNull();
    resolver.resolve(session());
    resolver.flush();
    expect(resolver.cached("claude/s1")).toBe("name me");
    const fresh = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () => [] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(fresh.cached("claude/s1")).toBe("name me");
  });

  it("skips non-summary, malformed, and mistyped head lines before falling back", () => {
    const head = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      '{"type":"summary","summary":"truncated mid-wr',
      JSON.stringify({ type: "other", summary: "not a summary record" }),
      JSON.stringify({ type: "summary", summary: 7 }),
    ].join("\n");
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => head,
      readTurns: () => [{ role: "user", text: "fallback prompt" }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session())).toBe("fallback prompt");
  });

  it("falls back to the first user message when the claude summary is blank", () => {
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => `${JSON.stringify({ type: "summary", summary: " \n\t " })}\n`,
      readTurns: () => [{ role: "user", text: "typed prompt" }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session())).toBe("typed prompt");
  });

  it("returns null when the first user message is only metadata tags", () => {
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () =>
        [{ role: "user", text: "<timestamp>Sep 15</timestamp>\n  \n" }] as SessionTurn[],
      mtime: () => "m1",
    });
    expect(resolver.resolve(session("cursor"))).toBeNull();
  });

  it("retries a failed resolution once the session file's mtime moves", () => {
    let turns: SessionTurn[] = [];
    let stamp = "m1";
    const resolver = createSessionTitleResolver(tempDir, {
      readHead: () => "",
      readTurns: () => turns,
      mtime: () => stamp,
    });
    expect(resolver.resolve(session())).toBeNull();
    turns = [{ role: "user", text: "arrived late" }];
    // Same mtime: the cached failure stands.
    expect(resolver.resolve(session())).toBeNull();
    stamp = "m2";
    expect(resolver.resolve(session())).toBe("arrived late");
  });

  it("flush is a no-op when nothing new was resolved", () => {
    const resolver = createSessionTitleResolver(tempDir);
    resolver.flush();
    expect(existsSync(join(tempDir, "session-titles.json"))).toBe(false);
  });

  it("creates the config directory on flush when it does not exist yet", () => {
    const configDir = join(tempDir, "nested", "cfg");
    const resolver = createSessionTitleResolver(configDir, {
      readHead: () => "",
      readTurns: () => [{ role: "user", text: "persist me" }] as SessionTurn[],
      mtime: () => "m1",
    });
    resolver.resolve(session());
    resolver.flush();
    const written = JSON.parse(readFileSync(join(configDir, "session-titles.json"), "utf-8"));
    expect(written).toEqual({
      schema_version: 3,
      entries: { "claude/s1": { title: "persist me", mtime: "m1" } },
    });
  });

  it.each([
    ["an older schema version", { schema_version: 1, entries: { "claude/s1": { title: "old" } } }],
    ["entries that are not an object", { schema_version: 3, entries: "nope" }],
  ])("discards a cache file with %s", (_label, contents) => {
    writeFileSync(join(tempDir, "session-titles.json"), JSON.stringify(contents));
    const resolver = createSessionTitleResolver(tempDir);
    expect(resolver.cached("claude/s1")).toBeNull();
  });

  it("discards a cache file that is not valid JSON", () => {
    writeFileSync(join(tempDir, "session-titles.json"), "{not json");
    const resolver = createSessionTitleResolver(tempDir);
    expect(resolver.cached("claude/s1")).toBeNull();
  });
});

describe("default file boundaries", () => {
  it("resolves a real claude file through the default reader and mtime", () => {
    const path = join(tempDir, "real.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "summary", summary: "Real file title" })}\n`);
    const resolver = createSessionTitleResolver(tempDir);
    expect(resolver.resolve({ id: "real", harness: "claude", path, updated: "" })).toBe(
      "Real file title",
    );
  });

  it("returns null (and keeps retrying) for a missing session file", () => {
    const resolver = createSessionTitleResolver(tempDir);
    const gone = {
      id: "gone",
      harness: "claude" as const,
      path: join(tempDir, "gone.jsonl"),
      updated: "",
    };
    expect(resolver.resolve(gone)).toBeNull();
    expect(resolver.resolve(gone)).toBeNull();
    expect(resolver.cached("claude/gone")).toBeNull();
  });
});

describe("reconstructSession", () => {
  it("rebuilds claude and cursor paths from slug + id when the file exists", () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p.endsWith("abc.jsonl");
    };
    const claude = reconstructSession("claude", "abc", "Users-u-dosu", "/home/u", exists);
    expect(claude?.path).toBe("/home/u/.claude/projects/Users-u-dosu/abc.jsonl");
    const cursor = reconstructSession("cursor", "abc", "Users-u-dosu", "/home/u", exists);
    expect(cursor?.path).toContain(".cursor/projects/Users-u-dosu/agent-transcripts");
  });

  it("returns null for harnesses whose layout does not encode the slug", () => {
    expect(reconstructSession("codex", "abc", "slug", "/home/u", () => true)).toBeNull();
    expect(reconstructSession("opencode", "abc", "slug")).toBeNull();
    expect(reconstructSession("claude", "abc", undefined, "/home/u", () => true)).toBeNull();
  });

  it("returns null when no candidate path exists", () => {
    expect(reconstructSession("claude", "abc", "slug", "/home/u", () => false)).toBeNull();
    expect(reconstructSession("cursor", "abc", "slug", "/home/u", () => false)).toBeNull();
  });

  it("falls back to the flattened cursor layout when the nested transcript is absent", () => {
    const flat = "/home/u/.cursor/projects/slug/agent-transcripts/abc.jsonl";
    const found = reconstructSession("cursor", "abc", "slug", "/home/u", (p) => p === flat);
    expect(found).toEqual({
      id: "abc",
      harness: "cursor",
      path: flat,
      project: "slug",
      updated: "",
    });
  });
});
