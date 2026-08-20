import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { driveCommand } from "../commands/drive";
import {
  fetchDriveStatus,
  joinDrive,
  readDriveEvidence,
  searchDrive,
  uploadPackage,
} from "./client";
import { scanWithDeja } from "./deja";
import { createDriveHost, type DriveHost } from "./host";
import { createRepositoryPackage, namespacedSessionId } from "./package";
import { startPreview } from "./preview";
import { dedupeRepositories, matchSessionRepository, repositoryIdentity } from "./repositories";
import { loadDriveState, rememberRepositories, setActiveDrive } from "./state";
import type { DejaSession, DejaSyncRecord } from "./types";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.DOSU_DRIVE_HOME;
  delete process.env.DOSU_DRIVE_DEJA_ENTRY;
  delete process.env.DOSU_DRIVE_FAKE_LOG;
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

  it("gate 5: keeps preview local and freezes the approved session selection", async () => {
    const preview = await startPreview([
      {
        key: "claude\0keep",
        repository: "repo-a",
        harness: "claude",
        nativeId: "keep",
        title: "Keep this session",
        started: "2026-08-20T06:00:00Z",
        updated: "2026-08-20T07:00:00Z",
        sample: "token [redacted:github_token]",
        records: 3,
        bytes: 120,
        redactions: 1,
      },
      {
        key: "codex\0exclude",
        repository: "repo-b",
        harness: "codex",
        nativeId: "exclude",
        title: "Exclude this session",
        started: "2026-08-20T06:00:00Z",
        updated: "2026-08-20T07:00:00Z",
        records: 2,
        bytes: 80,
        redactions: 0,
      },
    ]);
    try {
      expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const initial = (await fetch(`${preview.url.replace(/\/preview$/, "")}/api/preview`).then(
        (r) => r.json(),
      )) as { totals: { selected: number } };
      expect(initial.totals.selected).toBe(2);
      const base = preview.url.replace(/\/preview$/, "");
      await fetch(`${base}/api/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: ["claude\0keep"] }),
      });
      await fetch(`${base}/api/approve`, { method: "POST" });
      expect(await preview.waitForDecision()).toEqual(["claude\0keep"]);
    } finally {
      await preview.close();
    }
  });

  it("gate 6: runs pinned-style DV discovery and removes only its temporary workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-deja-"));
    cleanup.push(root);
    const driveHome = join(root, "drive");
    const fake = join(root, "fake-deja.mjs");
    const log = join(root, "calls.jsonl");
    const source = join(root, "source-session.jsonl");
    writeFileSync(source, '{"sentinel":"unchanged"}\n');
    writeFileSync(
      fake,
      `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2); appendFileSync(process.env.DOSU_DRIVE_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "version") console.log("deja 0.17.3");
else if (args[0] === "index") mkdirSync(process.env.DEJA_INDEX_DIR, { recursive: true });
else if (args[0] === "doctor") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "last") console.log(JSON.stringify({ schema_version: 2, sessions: [{ id: "s1", harness: "codex", project: "repo-a", path: ${JSON.stringify(source)}, started: "2026-08-20T06:00:00Z", updated: "2026-08-20T07:00:00Z" }] }));
else if (args[0] === "sync" && args[1] === "export") { mkdirSync(args[2], { recursive: true }); writeFileSync(args[2] + "/deja-sync.jsonl", JSON.stringify({ harness: "codex", session_id: "s1", project: "repo-a", role: "user", text: "fixture", time: "2026-08-20T07:00:00Z" }) + "\\n"); }
else process.exit(2);\n`,
    );
    process.env.DOSU_DRIVE_HOME = driveHome;
    process.env.DOSU_DRIVE_DEJA_ENTRY = fake;
    process.env.DOSU_DRIVE_FAKE_LOG = log;

    const workspace = await scanWithDeja();
    expect(workspace.version).toBe("deja 0.17.3");
    expect(workspace.sessions.map((session) => session.id)).toEqual(["s1"]);
    expect(readFileSync(log, "utf8")).toContain('["sync","export"');
    expect(readFileSync(log, "utf8")).toContain('"--full"');
    await workspace.cleanup();

    expect(existsSync(workspace.root)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe('{"sentinel":"unchanged"}\n');
  });

  it("gate 7: streams a verified Package into a persistent central DV index", async () => {
    const fixture = await indexedHostFixture();
    cleanup.push(fixture.root);
    try {
      const status = await fetchDriveStatus(fixture.connection);
      expect(status).toMatchObject({
        ready: true,
        contributors: 1,
        packages: 1,
        sessions: 1,
        records: 2,
      });
      const driveId = fixture.host.id;
      await fixture.host.close();
      fixture.host = await createDriveHost({ name: "Ignored on restart", port: 0 });
      const restarted = await fetchDriveStatus({ url: fixture.host.url });
      expect(restarted).toMatchObject({ id: driveId, ready: true, packages: 1, records: 2 });
    } finally {
      await fixture.host.close();
    }
  });

  it("gate 8: serves attributed search and evidence after the contributor is offline", async () => {
    const fixture = await indexedHostFixture();
    cleanup.push(fixture.root);
    try {
      await fixture.host.close();
      fixture.host = await createDriveHost({ name: "Ignored on restart", port: 0 });
      const connection = { url: fixture.host.url };
      const results = await searchDrive(connection, "retry sentinel");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        contributor: "Alice",
        repository: "repo-a",
        harness: "codex",
      });
      expect(results[0].snippet).toContain("[redacted:github_token]");
      const evidence = await readDriveEvidence(connection, results[0].resultId);
      expect(evidence.records.map((record) => record.role)).toEqual(["user", "command"]);
      expect(JSON.stringify(evidence)).not.toContain("ghp_fixture_secret");
    } finally {
      await fixture.host.close();
    }
  });
});

interface IndexedHostFixture {
  root: string;
  host: DriveHost;
  connection: Awaited<ReturnType<typeof joinDrive>>;
}

async function indexedHostFixture(): Promise<IndexedHostFixture> {
  const root = await mkdtemp(join(tmpdir(), "dosu-drive-host-"));
  const driveHome = join(root, "drive");
  const fake = join(root, "fake-host-deja.mjs");
  process.env.DOSU_DRIVE_HOME = driveHome;
  process.env.DOSU_DRIVE_DEJA_ENTRY = fake;
  writeFileSync(
    fake,
    `import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path"; const args = process.argv.slice(2); const index = process.env.DEJA_INDEX_DIR;
if (args[0] === "sync" && args[1] === "import") { mkdirSync(index, { recursive: true }); const file = readdirSync(args[2]).find(x => x.endsWith(".jsonl")); const records = readFileSync(join(args[2], file), "utf8").trim().split("\\n").map(line => JSON.parse(line)); writeFileSync(join(index, "records.json"), JSON.stringify(records)); console.log("deja: imported " + records.length + " records"); }
else if (args[0] === "doctor") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "stats") console.log(JSON.stringify({ sessions: 1 }));
else if (args[0] === "search") { const records = JSON.parse(readFileSync(join(index, "records.json"), "utf8")); const first = records[0]; console.log(JSON.stringify({ schema_version: 2, tier: "exact", total: 1, hits: [{ session: { id: "imported-fixture", orig_id: first.session_id, harness: first.harness, project: "imported:" + first.project, started: first.time, updated: first.time, touched: ["src/retry.ts"] }, count: 1, snippets: [first.text], score: 9, tier: "exact" }] })); }
else process.exit(2);\n`,
  );
  const host = await createDriveHost({ name: "Caspian's Drive", port: 0 });
  const connection = await joinDrive(host.url, "Alice", "alice-mac");
  const exportDirectory = join(root, "export");
  mkdirSync(exportDirectory, { recursive: true });
  writeFileSync(
    join(exportDirectory, "deja-sync.jsonl"),
    `${[
      syncRecord("codex", "same-native-id", "user", "retry sentinel [redacted:github_token]"),
      syncRecord("codex", "same-native-id", "command", "$ bun test"),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  const repositoryPackage = await createRepositoryPackage({
    exportDirectory,
    outputDirectory: join(root, "outgoing"),
    driveId: host.id,
    contributor: { id: connection.contributorId ?? "", name: "Alice" },
    repository: { root: "/work/repo-a", name: "repo-a", remote: "git@example/repo-a.git" },
    sessions: [dejaSession("codex", "same-native-id", "repo-a", ["src/retry.ts"])],
  });
  await uploadPackage(connection, repositoryPackage);
  return { root, host, connection };
}

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
