import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { driveCommand } from "../commands/drive";
import {
  fetchDriveStatus,
  joinDrive,
  readDriveEvidence,
  searchDrive,
  uploadPackage,
} from "./client";
import { runDeja, scanWithDeja } from "./deja";
import { discoverDrives } from "./discovery";
import { runDriveSetup, selectRepositories } from "./flows";
import { createDriveHost, type DriveHost } from "./host";
import { installDriveMcp } from "./mcp-config";
import { createDriveMcpServer } from "./mcp-server";
import { createRepositoryPackage, dejaSessionKey, namespacedSessionId } from "./package";
import { startPreview } from "./preview";
import { dedupeRepositories, matchSessionRepository, repositoryIdentity } from "./repositories";
import { loadDriveState, rememberRepositories, setActiveDrive } from "./state";
import type { DejaSession, DejaSyncRecord } from "./types";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.DOSU_DRIVE_HOME;
  delete process.env.DOSU_DRIVE_DEJA_BIN;
  delete process.env.DOSU_DRIVE_DEJA_ENTRY;
  delete process.env.DOSU_DRIVE_FAKE_LOG;
  delete process.env.DOSU_DRIVE_EXECUTABLE;
  delete process.env.DEJA_INDEX_COMMANDS;
  delete process.env.DEJA_INDEX_EDITS;
  delete process.env.DEJA_INDEX_PATHS;
  delete process.env.DEJA_INDEX_TOOL_OUTPUT;
  delete process.env.DEJA_NO_REDACT;
  delete process.env.DEJA_PROJECT_ROOTS;
  delete process.env.DEJA_SCAN_PROGRESS;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
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

  it("gate 3b: adds a repository through an action instead of a multiselect checkbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-repository-picker-"));
    cleanup.push(root);
    const current = join(root, "current");
    const recent = join(root, "recent");
    const added = join(root, "added");
    for (const repository of [current, recent, added]) {
      mkdirSync(repository, { recursive: true });
      execFileSync("git", ["init", "-q", repository]);
    }
    process.env.DOSU_DRIVE_HOME = join(root, "drive");
    rememberRepositories([recent]);
    const currentRoot = repositoryIdentity(current).root;
    const addedRoot = repositoryIdentity(added).root;

    const events: string[] = [];
    let pickerCount = 0;
    let pathCount = 0;
    const repositories = await selectRepositories(
      [],
      {
        pick: async (options) => {
          events.push("pick");
          const action = options.options.at(-1);
          expect(action).toMatchObject({
            kind: "action",
            label: "Add another repository…",
          });
          expect(options.options.slice(0, -1).every((option) => option.kind === "repo")).toBe(true);
          pickerCount++;
          if (pickerCount === 1) {
            return { result: "__add_repositories__", selected: [currentRoot] };
          }
          if (pickerCount === 2) {
            expect(
              options.options.filter(
                (option) => option.kind === "repo" && option.value === currentRoot,
              ),
            ).toHaveLength(1);
            expect(options.initialValues).toEqual([currentRoot]);
            return { result: "__add_repositories__", selected: [currentRoot] };
          }
          expect(options.options).toContainEqual(
            expect.objectContaining({
              kind: "repo",
              value: addedRoot,
              label: expect.stringContaining("Added repo"),
            }),
          );
          expect(options.initialValues).toEqual([currentRoot, addedRoot]);
          return { result: [currentRoot, addedRoot], selected: [currentRoot, addedRoot] };
        },
        text: async () => {
          events.push("text");
          pathCount++;
          return pathCount === 1 ? current : added;
        },
        isCancel: () => false,
        cancel: () => undefined,
      },
      current,
    );

    expect(events).toEqual(["pick", "text", "pick", "text", "pick"]);
    expect(repositories.map((repository) => repository.root)).toEqual([currentRoot, addedRoot]);
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
    const keepKey = dejaSessionKey("claude", "keep");
    const excludeKey = dejaSessionKey("codex", "exclude");
    let safetyChecks = 0;
    let markSafetyCheckStarted: () => void = () => undefined;
    const safetyCheckStarted = new Promise<void>((resolve) => {
      markSafetyCheckStarted = resolve;
    });
    let releaseSafetyCheck: () => void = () => undefined;
    const blockedSafetyCheck = new Promise<void>((resolve) => {
      releaseSafetyCheck = resolve;
    });
    let blockNextSafetyCheck = true;
    expect(keepKey).toMatch(/^[A-Za-z0-9_-]+$/);
    const preview = await startPreview(
      [
        {
          key: keepKey,
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
          key: excludeKey,
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
      ],
      {
        onSafetyCheck: async (sessions) => {
          safetyChecks++;
          if (blockNextSafetyCheck) {
            blockNextSafetyCheck = false;
            markSafetyCheckStarted();
            await blockedSafetyCheck;
          }
          return sessions;
        },
      },
    );
    try {
      expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const initial = (await fetch(`${preview.url.replace(/\/preview$/, "")}/api/preview`).then(
        (r) => r.json(),
      )) as { safetyChecked: boolean; totals: { selected: number } };
      expect(initial).toMatchObject({ safetyChecked: false, totals: { selected: 2 } });
      expect(safetyChecks).toBe(0);
      const base = preview.url.replace(/\/preview$/, "");
      const page = await fetch(preview.url).then((response) => response.text());
      expect(page).toContain("Check &amp; Remove Secrets");
      expect(page).toContain("Nothing will be uploaded yet.");
      expect(page).toContain("position:fixed");
      await fetch(`${base}/api/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [keepKey] }),
      });
      expect((await fetch(`${base}/api/approve`, { method: "POST" })).status).toBe(409);
      const staleSafetyCheck = fetch(`${base}/api/safety-check`, { method: "POST" });
      await safetyCheckStarted;
      await fetch(`${base}/api/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [excludeKey] }),
      });
      releaseSafetyCheck();
      expect((await staleSafetyCheck).status).toBe(409);
      const staleState = (await fetch(`${base}/api/preview`).then((response) =>
        response.json(),
      )) as { safetyChecked: boolean; totals: { selected: number } };
      expect(staleState).toMatchObject({ safetyChecked: false, totals: { selected: 1 } });
      expect((await fetch(`${base}/api/approve`, { method: "POST" })).status).toBe(409);
      await fetch(`${base}/api/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: [keepKey] }),
      });
      const checked = (await fetch(`${base}/api/safety-check`, { method: "POST" }).then(
        (response) => response.json(),
      )) as { safetyChecked: boolean; totals: { redactions: number } };
      expect(checked).toMatchObject({ safetyChecked: true, totals: { redactions: 1 } });
      expect(safetyChecks).toBe(2);
      await fetch(`${base}/api/approve`, { method: "POST" });
      expect(await preview.waitForDecision()).toEqual([keepKey]);
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
if (args[0] === "version") console.log("deja 0.17.3-dosu.1");
else if (args[0] === "index") { process.stderr.write('plain diagnostic\\n@dosu-scan not-json\\n@dosu-scan {"path":42}\\n@dosu-scan {"path":"/work/repo-a/.codex/session.jsonl"}\\n'); appendFileSync(process.env.DOSU_DRIVE_FAKE_LOG, JSON.stringify({ config: { commands: process.env.DEJA_INDEX_COMMANDS, edits: process.env.DEJA_INDEX_EDITS, paths: process.env.DEJA_INDEX_PATHS, toolOutput: process.env.DEJA_INDEX_TOOL_OUTPUT, noRedact: process.env.DEJA_NO_REDACT, projectRoots: process.env.DEJA_PROJECT_ROOTS, scanProgress: process.env.DEJA_SCAN_PROGRESS } }) + "\\n"); mkdirSync(process.env.DEJA_INDEX_DIR, { recursive: true }); }
else if (args[0] === "doctor") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "last") console.log(JSON.stringify({ schema_version: 2, sessions: [{ id: "s1", harness: "codex", project: "repo-a", path: ${JSON.stringify(source)}, started: "2026-08-20T06:00:00Z", updated: "2026-08-20T07:00:00Z" }] }));
else if (args[0] === "sync" && args[1] === "export") { mkdirSync(args[2], { recursive: true }); writeFileSync(args[2] + "/deja-sync.jsonl", JSON.stringify({ harness: "codex", session_id: "s1", project: "repo-a", role: "user", text: "fixture", time: "2026-08-20T07:00:00Z" }) + "\\n"); }
else process.exit(2);\n`,
    );
    process.env.DOSU_DRIVE_HOME = driveHome;
    process.env.DOSU_DRIVE_DEJA_ENTRY = fake;
    process.env.DOSU_DRIVE_FAKE_LOG = log;
    process.env.DEJA_INDEX_COMMANDS = "0";
    process.env.DEJA_INDEX_EDITS = "0";
    process.env.DEJA_INDEX_PATHS = "0";
    process.env.DEJA_INDEX_TOOL_OUTPUT = "0";
    process.env.DEJA_NO_REDACT = "1";

    const scanned: string[] = [];
    const workspace = await scanWithDeja(["/work/repo-a", "/work/repo-b"], {
      onScanPath: (path) => scanned.push(path),
    });
    expect(workspace.version).toBe("deja 0.17.3-dosu.1");
    expect(workspace.sessions.map((session) => session.id)).toEqual(["s1"]);
    expect(scanned).toEqual(["/work/repo-a/.codex/session.jsonl"]);
    expect(readFileSync(log, "utf8")).toContain('["sync","export"');
    expect(readFileSync(log, "utf8")).toContain('"--full"');
    expect(readFileSync(log, "utf8")).not.toContain('["doctor"');
    expect(readFileSync(log, "utf8")).toContain(
      '"config":{"commands":"1","edits":"1","paths":"1","toolOutput":"1","noRedact":"0","projectRoots":"/work/repo-a:/work/repo-b","scanProgress":"1"}',
    );
    await workspace.cleanup();

    expect(existsSync(workspace.root)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe('{"sentinel":"unchanged"}\n');

    const direct = await runDeja(["index"], {
      ...process.env,
      DEJA_INDEX_DIR: join(root, "direct-index"),
    });
    expect(direct.stderr).toBe("plain diagnostic\n");
    expect(
      (
        await runDeja(["version"], {
          ...process.env,
          DOSU_DRIVE_DEJA_ENTRY: undefined,
        })
      ).stdout.trim(),
    ).toBe("deja 0.17.3-dosu.1");
    await expect(runDeja(["unsupported"], process.env)).rejects.toThrow(
      "deja-vu unsupported failed",
    );
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
      fixture.host = await createDriveHost({
        name: "Ignored on restart",
        port: 0,
        bonjour: false,
      });
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
      fixture.host = await createDriveHost({
        name: "Ignored on restart",
        port: 0,
        bonjour: false,
      });
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

  it("gate 9: completes repository setup through upload and central indexing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-setup-"));
    cleanup.push(root);
    const repository = join(root, "repo-a");
    const source = join(root, "source-session.jsonl");
    const fake = join(root, "fake-setup-deja.mjs");
    mkdirSync(repository, { recursive: true });
    execFileSync("git", ["init", "-q", repository]);
    writeFileSync(source, '{"sentinel":"unchanged"}\n');
    writeFileSync(
      fake,
      `import { mkdirSync, writeFileSync } from "node:fs"; const args = process.argv.slice(2);
if (args[0] === "version") console.log("deja 0.17.3-dosu.1");
else if (args[0] === "index") mkdirSync(process.env.DEJA_INDEX_DIR, { recursive: true });
else if (args[0] === "doctor") console.log(JSON.stringify({ ok: true }));
else if (args[0] === "stats") console.log(JSON.stringify({ sessions: 1 }));
else if (args[0] === "last") console.log(JSON.stringify({ schema_version: 2, sessions: [{ id: "setup-session", harness: "codex", project: "repo-a", path: ${JSON.stringify(source)}, touched: [${JSON.stringify(join(repository, "src/retry.ts"))}], started: "2026-08-20T06:00:00Z", updated: "2026-08-20T07:00:00Z" }] }));
else if (args[0] === "sync" && args[1] === "export") { mkdirSync(args[2], { recursive: true }); writeFileSync(args[2] + "/deja-sync.jsonl", JSON.stringify({ harness: "codex", session_id: "setup-session", project: "repo-a", role: "user", text: "setup sentinel [redacted:github_token]", time: "2026-08-20T07:00:00Z" }) + "\\n"); }
else if (args[0] === "sync" && args[1] === "import") console.log("deja: imported 1 record");
else process.exit(2);\n`,
    );
    process.env.DOSU_DRIVE_HOME = join(root, "drive");
    process.env.DOSU_DRIVE_DEJA_ENTRY = fake;
    const host = await createDriveHost({ name: "Setup Drive", port: 0, bonjour: false });
    try {
      setActiveDrive(await joinDrive(host.url, "Alice", "setup-mac"));
      let openedPreview = "";
      await runDriveSetup({
        repositories: [repository],
        yes: false,
        open: true,
        openURL: async (url) => {
          openedPreview = url;
          const base = url.replace(/\/preview$/, "");
          const preview = (await fetch(`${base}/api/preview`).then((response) =>
            response.json(),
          )) as { totals: { selected: number } };
          expect(preview.totals.selected).toBe(1);
          await fetch(`${base}/api/safety-check`, { method: "POST" });
          await fetch(`${base}/api/approve`, { method: "POST" });
        },
      });
      expect(openedPreview).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview$/);
      expect(await fetchDriveStatus({ url: host.url })).toMatchObject({
        ready: true,
        packages: 1,
        sessions: 1,
      });
      expect(readFileSync(source, "utf8")).toBe('{"sentinel":"unchanged"}\n');
    } finally {
      await host.close();
    }
  });

  it("gate 10: preserves existing Codex MCPs and serves both Drive tools", async () => {
    const fixture = await indexedHostFixture();
    cleanup.push(fixture.root);
    const codexHome = join(fixture.root, "codex-home");
    const configPath = join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true });
    const existing = 'model = "gpt-5"\n\n[mcp_servers.dosu]\nurl = "https://dosu.example/mcp"\n';
    writeFileSync(configPath, existing);
    process.env.CODEX_HOME = codexHome;
    process.env.DOSU_DRIVE_EXECUTABLE = "/opt/dosu-alpha/bin/dosu";
    setActiveDrive(fixture.connection);
    try {
      installDriveMcp("codex");
      installDriveMcp("codex");
      const configured = readFileSync(configPath, "utf8");
      expect(configured.startsWith(existing)).toBe(true);
      expect(configured).toContain("[mcp_servers.dosu-drive]");
      expect(configured.match(/\[mcp_servers\.dosu-drive]/g)).toHaveLength(1);
      expect(configured).toContain('command = "/opt/dosu-alpha/bin/dosu"');

      const server = createDriveMcpServer(() => fixture.connection);
      const client = new Client({ name: "drive-acceptance", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "search_drive",
          "read_drive_evidence",
        ]);
        const search = await client.callTool({
          name: "search_drive",
          arguments: { query: "retry sentinel" },
        });
        const searchPayload = toolText(search);
        const first = searchPayload.results?.[0];
        expect(first).toMatchObject({ contributor: "Alice", repository: "repo-a" });
        if (!first) throw new Error("search_drive returned no results");
        const evidence = await client.callTool({
          name: "read_drive_evidence",
          arguments: { result_id: first.resultId },
        });
        expect(toolText(evidence).records ?? []).toHaveLength(2);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      await fixture.host.close();
    }
  });

  it.runIf(process.platform === "darwin")(
    "gate 11: advertises and discovers the Host through real macOS Bonjour",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dosu-drive-bonjour-"));
      cleanup.push(root);
      process.env.DOSU_DRIVE_HOME = join(root, "drive");
      const host = await createDriveHost({ name: "Bonjour Acceptance Drive", port: 0 });
      try {
        const drives = await discoverDrives(2500);
        expect(drives).toContainEqual(
          expect.objectContaining({ id: host.id, name: "Bonjour Acceptance Drive" }),
        );
        const discovered = drives.find((drive) => drive.id === host.id);
        if (!discovered) throw new Error("Bonjour did not return the hosted Drive");
        expect(await fetchDriveStatus({ url: discovered.url })).toMatchObject({ id: host.id });
      } finally {
        await host.close();
      }
    },
    10_000,
  );

  it("gate 13: fails closed on malformed state and invalid repository/package input", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-fail-closed-"));
    cleanup.push(root);
    const driveHome = join(root, "drive");
    mkdirSync(driveHome, { recursive: true });
    process.env.DOSU_DRIVE_HOME = driveHome;
    writeFileSync(join(driveHome, "state.json"), "not-json");
    expect(loadDriveState()).toEqual({ schemaVersion: 1, recentRepositories: [] });
    writeFileSync(join(driveHome, "state.json"), '{"schemaVersion":999}');
    expect(loadDriveState()).toEqual({ schemaVersion: 1, recentRepositories: [] });
    expect(() => repositoryIdentity(root)).toThrow("is not inside a Git repository");
    await expect(
      createRepositoryPackage({
        exportDirectory: join(root, "missing-export"),
        outputDirectory: join(root, "outgoing"),
        driveId: "drive-1",
        contributor: { id: "alice", name: "Alice" },
        repository: { root: "/work/repo-a", name: "repo-a" },
        sessions: [],
      }),
    ).rejects.toThrow("No approved sessions");
  });

  it("gate 14: keeps implementation-only helpers out of the shipped module surface", async () => {
    const [deja, paths, state] = await Promise.all([
      import("./deja"),
      import("./paths"),
      import("./state"),
    ]);
    expect(deja).not.toHaveProperty("DEJA_PACKAGE");
    expect(paths).not.toHaveProperty("hostedDrivesDir");
    expect(state).not.toHaveProperty("emptyDriveState");
    expect(state).not.toHaveProperty("saveDriveState");
  });

  it("gate 15: exposes the exact automation and demo options used by the packaged E2E", () => {
    const drive = driveCommand();
    const options = (name: string) =>
      drive.commands
        .find((command) => command.name() === name)
        ?.options.map((option) => option.long)
        .filter(Boolean);
    expect(options("host")).toEqual(["--name", "--port", "--no-bonjour"]);
    expect(options("join")).toEqual(["--name", "--no-setup"]);
    expect(options("setup")).toEqual(["--repo", "--yes", "--no-open"]);
    expect(options("search")).toEqual(["--repo"]);
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
  const host = await createDriveHost({ name: "Caspian's Drive", port: 0, bonjour: false });
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

interface ToolTextPayload {
  results?: Array<{ resultId: string; contributor: string; repository: string }>;
  records?: unknown[];
}

function toolText(result: unknown): ToolTextPayload {
  const content =
    result && typeof result === "object" && "content" in result && Array.isArray(result.content)
      ? result.content[0]
      : undefined;
  if (!content || typeof content !== "object" || !("text" in content)) {
    throw new Error("MCP tool returned no text content");
  }
  return JSON.parse(String(content.text)) as ToolTextPayload;
}
