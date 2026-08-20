import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { scanWithDeja } from "./deja";
import { createRepositoryPackage } from "./package";
import { matchSessionRepository, repositoryIdentity } from "./repositories";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.runIf(process.env.DOSU_DRIVE_REAL_DV === "1")(
  "gate 12: real deja-vu 0.17.3 preserves, redacts, and exactly filters native fixtures",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-real-dv-"));
    roots.push(root);
    const repoA = createRepository(join(root, "repo-a"));
    const repoB = createRepository(join(root, "repo-b"));
    const repoC = createRepository(join(root, "repo-c"));
    const claudeRoot = join(root, "sources", "claude");
    const codexRoot = join(root, "sources", "codex");
    const token = `ghp_${"a".repeat(30)}`;
    const sourceFiles = [
      writeClaude(
        claudeRoot,
        repoA.root,
        "claude-keep",
        `Keep this retry decision; token ${token}`,
        join(repoA.root, "src/retry.ts"),
      ),
      writeClaude(
        claudeRoot,
        repoA.root,
        "claude-drop",
        "MANUALLY_EXCLUDED_SENTINEL",
        join(repoA.root, "src/drop.ts"),
      ),
      writeCodex(codexRoot, repoB.root, "codex-keep", "CODEX_KEEP_SENTINEL"),
      writeCodex(codexRoot, repoC.root, "codex-other", "UNSELECTED_REPO_SENTINEL"),
    ];
    for (const path of sourceFiles) chmodSync(path, 0o444);
    const before = new Map(sourceFiles.map((path) => [path, sourceFingerprint(path)]));

    const overrides = isolatedDejaEnvironment(root, claudeRoot, codexRoot);
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    let workspace: Awaited<ReturnType<typeof scanWithDeja>> | undefined;
    try {
      workspace = await scanWithDeja();
      expect(workspace.version).toBe("deja 0.17.3");
      const selectedRepositories = [repoA, repoB];
      const associated = workspace.sessions.filter((session) =>
        matchSessionRepository(session, selectedRepositories),
      );
      const approvedA = associated.filter(
        (session) => session.harness === "claude" && session.id === "claude-keep",
      );
      const approvedB = associated.filter(
        (session) => session.harness === "codex" && session.id === "codex-keep",
      );
      expect(approvedA).toHaveLength(1);
      expect(approvedB).toHaveLength(1);

      const packageA = await createRepositoryPackage({
        exportDirectory: workspace.exportDirectory,
        outputDirectory: join(workspace.root, "packages-a"),
        driveId: "real-dv-drive",
        contributor: { id: "alice", name: "Alice" },
        repository: repoA,
        sessions: approvedA,
      });
      const packageB = await createRepositoryPackage({
        exportDirectory: workspace.exportDirectory,
        outputDirectory: join(workspace.root, "packages-b"),
        driveId: "real-dv-drive",
        contributor: { id: "alice", name: "Alice" },
        repository: repoB,
        sessions: approvedB,
      });
      const packaged = `${readFileSync(packageA.path, "utf8")}\n${readFileSync(packageB.path, "utf8")}`;
      expect(packaged).not.toContain(token);
      expect(packaged).toContain("[redacted:github-token]");
      expect(packaged).toContain("CODEX_KEEP_SENTINEL");
      expect(packaged).toContain("$ bun test");
      expect(packaged).not.toContain("MANUALLY_EXCLUDED_SENTINEL");
      expect(packaged).not.toContain("UNSELECTED_REPO_SENTINEL");
    } finally {
      await workspace?.cleanup();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const path of sourceFiles) expect(sourceFingerprint(path)).toEqual(before.get(path));
  },
  60_000,
);

function createRepository(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
  return repositoryIdentity(path);
}

function writeClaude(
  root: string,
  repository: string,
  sessionId: string,
  sentinel: string,
  filePath: string,
): string {
  const directory = join(root, repository.split(sep).join("-"));
  const path = join(directory, `${sessionId}.jsonl`);
  mkdirSync(directory, { recursive: true });
  const messages = [
    {
      type: "user",
      sessionId,
      timestamp: "2026-08-20T06:00:00Z",
      message: { role: "user", content: sentinel },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-08-20T06:01:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Implemented the selected retry fix" },
          { type: "tool_use", name: "Bash", input: { command: "bun test" } },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: filePath, old_string: "retry=1", new_string: "retry=3" },
          },
        ],
      },
    },
  ];
  writeFileSync(path, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  return path;
}

function writeCodex(root: string, repository: string, sessionId: string, sentinel: string): string {
  const directory = join(root, "sessions", "2026", "08", "20");
  const path = join(directory, `rollout-${sessionId}.jsonl`);
  mkdirSync(directory, { recursive: true });
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-08-20T06:00:00Z",
      payload: { id: sessionId, session_id: sessionId, cwd: repository },
    },
    {
      type: "response_item",
      timestamp: "2026-08-20T06:01:00Z",
      payload: { type: "message", role: "user", content: sentinel },
    },
    {
      type: "response_item",
      timestamp: "2026-08-20T06:02:00Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun test" }),
        call_id: "call-1",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-20T06:03:00Z",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "Process exited with code 0\nFinal output:\npassed",
      },
    },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

function isolatedDejaEnvironment(root: string, claudeRoot: string, codexRoot: string) {
  const source = (name: string) => join(root, "sources", name);
  return {
    DOSU_DRIVE_HOME: join(root, "drive"),
    DOSU_DRIVE_DEJA_ENTRY: "",
    DEJA_CLAUDE_ROOT: claudeRoot,
    DEJA_CODEX_ROOT: codexRoot,
    DEJA_CURSOR_ROOT: source("cursor"),
    DEJA_CURSOR_CLI_ROOT: source("cursor-cli"),
    DEJA_GEMINI_ROOT: source("gemini"),
    DEJA_AIDER_ROOTS: source("aider"),
    DEJA_ANTIGRAVITY_ROOT: source("antigravity"),
    DEJA_GROK_ROOT: source("grok"),
    DEJA_GROK_DB: source("grok.db"),
    DEJA_QWEN_ROOT: source("qwen"),
    DEJA_CLINE_ROOT: source("cline"),
    DEJA_CLINE_ROOTS: source("cline"),
    DEJA_COPILOT_ROOT: source("copilot"),
    DEJA_GOOSE_ROOT: source("goose"),
    DEJA_GOOSE_DB: source("goose.db"),
    DEJA_HERMES_HOME: source("hermes"),
    DEJA_HERMES_DB: source("hermes.db"),
    DEJA_HERMES_PROFILES_ROOT: source("hermes-profiles"),
    DEJA_KIMI_ROOT: source("kimi"),
    DEJA_OPENCLAW_ROOT: source("openclaw"),
    DEJA_OPENCODE_DB: source("opencode.db"),
    DEJA_PI_ROOT: source("pi"),
    DEJA_ROO_CLI_ROOT: source("roo-cli"),
    DEJA_ROO_ROOTS: source("roo"),
    DEJA_ZED_ROOT: source("zed"),
    DEJA_ZED_DB: source("zed.db"),
    DEJA_NOTES_FILE: source("notes.jsonl"),
    DEJA_INDEX_COMMANDS: "1",
    DEJA_INDEX_EDITS: "1",
    DEJA_INDEX_PATHS: "1",
    DEJA_INDEX_TOOL_OUTPUT: "1",
    DEJA_NO_REDACT: "0",
    NO_COLOR: "1",
  };
}

function sourceFingerprint(path: string) {
  const stat = statSync(path, { bigint: true });
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size.toString(),
    mode: Number(stat.mode & 0o777n),
    mtimeNs: stat.mtimeNs.toString(),
  };
}
