import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { driveCommand } from "../commands/drive";
import { createRepositoryPackage, namespacedSessionId } from "./package";
import { dedupeRepositories, matchSessionRepository, repositoryIdentity } from "./repositories";
import { loadDriveState, rememberRepositories, setActiveDrive } from "./state";
import type { DejaSession, DejaSyncRecord } from "./types";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.DOSU_DRIVE_HOME;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Dosu Drive acceptance gates", () => {
  it("gate 1: exposes the complete Drive command surface", () => {
    const command = driveCommand();
    expect(command.commands.map((item) => item.name())).toEqual([
      "host",
      "join",
      "setup",
      "search",
      "status",
      "stop",
      "destroy",
      "mcp",
    ]);
    expect(
      command.commands.find((item) => item.name() === "mcp")?.commands.map((item) => item.name()),
    ).toEqual(["add", "status", "remove", "serve"]);
  });

  it("gate 2: persists Drive state without modifying repository or session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-acceptance-"));
    cleanup.push(root);
    const driveHome = join(root, "state");
    const source = join(root, "source-session.jsonl");
    mkdirSync(driveHome, { recursive: true });
    writeFileSync(source, '{"message":"untouched"}\n');
    process.env.DOSU_DRIVE_HOME = driveHome;

    setActiveDrive({
      id: "drive-1",
      name: "Demo Drive",
      url: "http://127.0.0.1:47821/",
      protocolVersion: 1,
      local: true,
    });
    rememberRepositories(["/tmp/repo-a", "/tmp/repo-b", "/tmp/repo-a"]);

    expect(loadDriveState()).toMatchObject({
      active: { id: "drive-1", url: "http://127.0.0.1:47821" },
      recentRepositories: ["/tmp/repo-a", "/tmp/repo-b"],
    });
    expect(readFileSync(source, "utf8")).toBe('{"message":"untouched"}\n');
    expect(existsSync(source)).toBe(true);
  });

  it("gate 3: associates sessions with multiple repositories without substring matching", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-repositories-"));
    cleanup.push(root);
    const repoA = join(root, "team-a", "service");
    const repoB = join(root, "team-b", "service");
    for (const repo of [repoA, repoB]) {
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", repo]);
    }
    const repositories = dedupeRepositories([
      repositoryIdentity(repoA),
      repositoryIdentity(repoB),
      repositoryIdentity(repoA),
    ]);
    const sessionA = dejaSession("codex", "a", "service", [join(repoA, "src/a.ts")]);
    const ambiguous = dejaSession("cursor", "b", "service", []);

    expect(repositories).toHaveLength(2);
    expect(matchSessionRepository(sessionA, repositories)?.root).toBe(
      repositoryIdentity(repoA).root,
    );
    expect(matchSessionRepository(ambiguous, repositories)).toBeUndefined();
  });

  it("gate 4: packages only the immutable exact allowlist and namespaces sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-package-"));
    cleanup.push(root);
    const exportDirectory = join(root, "export");
    const outputDirectory = join(root, "packages");
    mkdirSync(exportDirectory, { recursive: true });
    const records: DejaSyncRecord[] = [
      syncRecord("claude", "approved-a", "user", "fixed retries [redacted:github_token]"),
      syncRecord("claude", "approved-a", "tool", "tests passed"),
      syncRecord("codex", "approved-b", "command", "$ bun test"),
      syncRecord("claude", "rejected", "user", "must not leave this Mac"),
      syncRecord("codex", "other-repo", "user", "unrelated repository"),
    ];
    writeFileSync(
      join(exportDirectory, "deja-sync-fixture.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const result = await createRepositoryPackage({
      exportDirectory,
      outputDirectory,
      driveId: "drive-1",
      contributor: { id: "alice", name: "Alice" },
      repository: { root: "/work/repo-a", name: "repo-a" },
      sessions: [
        dejaSession("claude", "approved-a", "repo-a", []),
        dejaSession("codex", "approved-b", "repo-a", []),
      ],
      now: new Date("2026-08-20T07:00:00Z"),
    });
    const lines = readFileSync(result.path, "utf8").trim().split("\n");
    const packaged = lines.slice(1).map((line) => JSON.parse(line) as DejaSyncRecord);

    expect(result.manifest.recordCount).toBe(3);
    expect(result.manifest.redactions).toEqual({ total: 1, byKind: { github_token: 1 } });
    expect(new Set(packaged.map((record) => record.session_id))).toEqual(
      new Set([
        namespacedSessionId("alice", "claude", "approved-a"),
        namespacedSessionId("alice", "codex", "approved-b"),
      ]),
    );
    expect(packaged.map((record) => record.text).join("\n")).not.toContain("must not leave");
    expect(packaged.map((record) => record.text).join("\n")).not.toContain("unrelated");
  });
});

function dejaSession(harness: string, id: string, project: string, touched: string[]): DejaSession {
  return {
    harness,
    id,
    project,
    touched,
    started: "2026-08-20T06:00:00Z",
    updated: "2026-08-20T07:00:00Z",
  };
}

function syncRecord(
  harness: string,
  sessionId: string,
  role: string,
  text: string,
): DejaSyncRecord {
  return {
    harness,
    session_id: sessionId,
    project: "fixture",
    role,
    text,
    time: "2026-08-20T07:00:00Z",
  };
}
