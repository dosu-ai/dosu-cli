import { describe, expect, it } from "vitest";
import { renderSessionSummary, scanStatus } from "./presentation";
import type { DejaSession, RepositoryIdentity } from "./types";

describe("Drive setup presentation", () => {
  it("keeps a changing scan path on one terminal-width line", () => {
    const status = scanStatus(
      "/Users/alice/.codex/sessions/2026/08/20/rollout-a-very-long-session-name.jsonl",
      58,
      "/Users/alice",
    );
    expect(status).toMatch(/^Scanning… ~\//);
    expect(status).toMatch(/session-name\.jsonl$/);
    expect([...status]).toHaveLength(54);
  });

  it("renders short home and external paths without truncation", () => {
    expect(scanStatus("/Users/alice", 80, "/Users/alice")).toBe("Scanning… ~");
    expect(scanStatus("/tmp/session.jsonl", 80, "/Users/alice")).toBe(
      "Scanning… /tmp/session.jsonl",
    );
    expect(scanStatus("/tmp/default-columns.jsonl")).toContain("default-columns.jsonl");
  });

  it("groups harness counts under each repository and prints one total", () => {
    const repoA: RepositoryIdentity = { root: "/work/repo-a", name: "repo-a" };
    const repoB: RepositoryIdentity = { root: "/work/repo-b", name: "repo-b" };
    const byRepository = new Map<string, DejaSession[]>([
      [repoA.root, [session("codex", "a"), session("codex", "b"), session("cursor", "c")]],
      [repoB.root, [session("claude-code", "d")]],
    ]);

    expect(renderSessionSummary([repoA, repoB], byRepository)).toBe(
      [
        "├─ /work/repo-a",
        "│  ├─ Codex          2 sessions",
        "│  └─ Cursor         1 session",
        "├─ /work/repo-b",
        "│  └─ Claude Code    1 session",
        "└─ Total             4 sessions",
      ].join("\n"),
    );
  });

  it("shows an empty selected repository without inventing sessions", () => {
    const repository: RepositoryIdentity = { root: "/work/empty", name: "empty" };

    expect(renderSessionSummary([repository], new Map())).toBe(
      ["├─ /work/empty", "│  └─ No sessions", "└─ Total             0 sessions"].join("\n"),
    );
  });
});

function session(harness: string, id: string): DejaSession {
  return {
    harness,
    id,
    project: "repo",
    started: "2026-08-20T06:00:00Z",
    updated: "2026-08-20T07:00:00Z",
  };
}
