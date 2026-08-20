#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANTED_TOKEN = `ghp_${"z".repeat(30)}`;
const transcript: string[] = [];

async function main(): Promise<void> {
  const outputDirectory = resolve(process.argv[2] ?? join(REPOSITORY_ROOT, "ship", "drive-e2e"));
  mkdirSync(outputDirectory, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), "dosu-drive-package-e2e-"));
  let host: CapturedProcess | undefined;
  let restart: CapturedProcess | undefined;
  let packedPath = "";
  try {
    await run("bun", ["run", "build:npm"], { cwd: REPOSITORY_ROOT }, "build npm bundle");
    const packed = parseNpmPackOutput(
      await run("npm", ["pack", "--json"], { cwd: REPOSITORY_ROOT }, "npm pack"),
    );
    packedPath = join(REPOSITORY_ROOT, packed[0].filename);
    const deliveredTarball = join(outputDirectory, basename(packedPath));
    copyFileSync(packedPath, deliveredTarball);
    const tarballSha256 = sha256(deliveredTarball);

    const installPrefix = join(root, "install");
    const npmCache = join(root, "npm-cache");
    await run(
      "npm",
      ["install", "--global", "--prefix", installPrefix, "--cache", npmCache, packedPath],
      { cwd: root },
      "isolated npm install",
    );
    const cli = join(installPrefix, "bin", "dosu");
    const emptyCwd = join(root, "empty-cwd");
    mkdirSync(emptyCwd, { recursive: true });
    const baseEnvironment = cleanEnvironment({
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      NPM_CONFIG_CACHE: npmCache,
    });
    const version = await run(
      cli,
      ["--version"],
      { cwd: emptyCwd, env: baseEnvironment },
      "installed version",
    );
    assert(version.includes("v0.48.2"), "installed CLI version failed");
    const help = await run(
      cli,
      ["drive", "--help"],
      { cwd: emptyCwd, env: baseEnvironment },
      "installed Drive help",
    );
    for (const command of ["host", "join", "setup", "search", "status", "stop", "destroy", "mcp"]) {
      assert(help.includes(command), `Drive help is missing ${command}`);
    }

    const fixtures = createFixtures(root);
    const sourceBefore = new Map(fixtures.sourceFiles.map((path) => [path, fingerprint(path)]));
    const hostDriveHome = join(root, "host-drive");
    const participantDriveHome = join(root, "participant-drive");
    const hostEnvironment = cleanEnvironment({
      ...baseEnvironment,
      DOSU_DRIVE_HOME: hostDriveHome,
    });
    const participantEnvironment = cleanEnvironment({
      ...baseEnvironment,
      ...isolatedSourceEnvironment(root, participantDriveHome, fixtures),
    });
    const port = await freePort();
    host = startCaptured(
      cli,
      ["drive", "host", "--name", "Package E2E Drive", "--port", String(port)],
      { cwd: emptyCwd, env: hostEnvironment },
      "host terminal",
    );
    const hostUrl = await waitForActiveURL(hostDriveHome, host, 15_000);
    const initialStatus = await getJSON<DriveStatus>(`${hostUrl}/api/status`);
    assert(initialStatus.packages === 0, "fresh Host unexpectedly contained Packages");

    await run(
      cli,
      ["drive", "join", hostUrl, "--no-setup", "--name", "Alice"],
      { cwd: emptyCwd, env: participantEnvironment },
      "participant join",
    );
    const setup = startCaptured(
      cli,
      ["drive", "setup", "--repo", fixtures.repoA, fixtures.repoB, "--no-open"],
      { cwd: emptyCwd, env: participantEnvironment },
      "participant setup",
    );
    const previewURL = await waitForPreviewURL(setup, 30_000);
    const previewBase = previewURL.replace(/\/preview$/, "");
    const beforeApproval = await getJSON<DriveStatus>(`${hostUrl}/api/status`);
    assert(beforeApproval.packages === 0, "Host changed before preview approval");
    const preview = await getJSON<PreviewPayload>(`${previewBase}/api/preview`);
    assert(preview.totals.selected === 3, "preview did not contain the three matched sessions");
    assert(preview.totals.redactions >= 1, "preview did not report DV redaction");
    const selectedKeys = preview.sessions
      .filter((session) => session.nativeId !== "claude-drop")
      .map((session) => session.key);
    await postJSON(`${previewBase}/api/select`, { keys: selectedKeys });
    writeFileSync(
      join(outputDirectory, "preview.html"),
      await fetch(previewURL).then((response) => response.text()),
    );
    writeFileSync(join(outputDirectory, "preview.json"), `${JSON.stringify(preview, null, 2)}\n`);
    await fetch(`${previewBase}/api/approve`, { method: "POST" });
    await setup.wait(60_000);

    const readyStatus = await getJSON<DriveStatus>(`${hostUrl}/api/status`);
    assert(readyStatus.ready, "Host index did not become ready");
    assert(readyStatus.packages === 2, "multi-repository setup did not upload two Packages");
    assert(readyStatus.sessions === 2, "preview exclusion did not produce exactly two sessions");
    const searchOutput = await run(
      cli,
      ["drive", "search", "quadratic walrus retry"],
      { cwd: emptyCwd, env: participantEnvironment },
      "CLI search with contributor offline",
    );
    assert(searchOutput.includes("Alice"), "CLI search lost contributor attribution");
    assert(searchOutput.includes("quadratic walrus retry"), "CLI search missed fixture evidence");
    const dashboardHTML = await fetch(hostUrl).then((response) => response.text());
    assert(dashboardHTML.includes("Package E2E Drive"), "Dashboard did not load");
    writeFileSync(join(outputDirectory, "dashboard.html"), dashboardHTML);

    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const codexConfig = join(codexHome, "config.toml");
    writeFileSync(codexConfig, '[mcp_servers.dosu]\nurl = "https://dosu.example/mcp"\n');
    const mcpEnvironment = cleanEnvironment({ ...participantEnvironment, CODEX_HOME: codexHome });
    await run(
      cli,
      ["drive", "mcp", "add", "codex"],
      { cwd: emptyCwd, env: mcpEnvironment },
      "Codex MCP setup",
    );
    const configured = readFileSync(codexConfig, "utf8");
    assert(configured.includes("[mcp_servers.dosu]"), "existing Dosu MCP was replaced");
    assert(
      configured.includes("[mcp_servers.dosu-drive]"),
      "Drive MCP was not configured separately",
    );
    writeFileSync(join(outputDirectory, "codex-config.toml"), configured);
    const invocation = parseDriveInvocation(configured);
    const mcpClient = new Client({ name: "package-e2e", version: "1.0.0" });
    const mcpTransport = new StdioClientTransport({
      command: invocation.command,
      args: invocation.args,
      env: cleanEnvironment({ ...mcpEnvironment, ...invocation.env }),
      cwd: emptyCwd,
      stderr: "pipe",
    });
    let mcpStderr = "";
    mcpTransport.stderr?.on("data", (chunk) => {
      mcpStderr += String(chunk);
    });
    await mcpClient.connect(mcpTransport);
    let mcpTools: string[] = [];
    try {
      mcpTools = (await mcpClient.listTools()).tools.map((tool) => tool.name);
      assert(
        JSON.stringify(mcpTools) === JSON.stringify(["search_drive", "read_drive_evidence"]),
        "packaged MCP exposed the wrong tools",
      );
      const searched = parseToolText(
        await mcpClient.callTool({
          name: "search_drive",
          arguments: { query: "quadratic walrus retry" },
        }),
      );
      const resultId = searched.results?.[0]?.resultId;
      assert(typeof resultId === "string", "packaged MCP search returned no result ID");
      const evidence = parseToolText(
        await mcpClient.callTool({
          name: "read_drive_evidence",
          arguments: { result_id: resultId },
        }),
      );
      assert((evidence.records?.length ?? 0) > 0, "packaged MCP evidence was empty");
    } finally {
      await mcpClient.close();
      transcript.push(`\n## MCP stderr\n${scrub(mcpStderr)}`);
    }

    await run(cli, ["drive", "stop"], { cwd: emptyCwd, env: participantEnvironment }, "Host stop");
    await host.wait(10_000);
    host = undefined;
    restart = startCaptured(
      cli,
      ["drive", "host", "--name", "Ignored on restart", "--port", String(port), "--no-bonjour"],
      { cwd: emptyCwd, env: hostEnvironment },
      "Host restart",
    );
    await waitForActiveURL(hostDriveHome, restart, 15_000);
    const restartedStatus = await getJSON<DriveStatus>(`${hostUrl}/api/status`);
    assert(restartedStatus.ready && restartedStatus.sessions === 2, "Host restart lost its index");
    const restartedSearch = await run(
      cli,
      ["drive", "search", "quadratic walrus retry"],
      { cwd: emptyCwd, env: participantEnvironment },
      "search after Host restart",
    );
    assert(restartedSearch.includes("Alice"), "search after restart lost evidence");
    await run(
      cli,
      ["drive", "stop"],
      { cwd: emptyCwd, env: participantEnvironment },
      "final Host stop",
    );
    await restart.wait(10_000);
    restart = undefined;

    for (const path of fixtures.sourceFiles) {
      assert(
        JSON.stringify(fingerprint(path)) === JSON.stringify(sourceBefore.get(path)),
        `source changed: ${path}`,
      );
    }
    assert(
      !treeContains(hostDriveHome, PLANTED_TOKEN),
      "planted token reached central Drive state",
    );
    assert(
      treeContains(hostDriveHome, "[redacted:github-token]"),
      "central Drive lost redaction marker",
    );
    const temporaryParent = join(participantDriveHome, "tmp");
    assert(
      !existsSync(temporaryParent) ||
        !readdirSync(temporaryParent).some((name) => name.startsWith("setup-")),
      "participant temporary DV workspace was not removed",
    );

    const evidence = {
      passed: true,
      cli,
      version: version.trim(),
      tarball: deliveredTarball,
      tarballBytes: statSync(deliveredTarball).size,
      tarballSha256,
      initialStatus,
      beforeApproval,
      readyStatus,
      restartedStatus,
      previewSelected: preview.totals.selected,
      approvedSessions: selectedKeys.length,
      mcpTools,
      sourceFilesUnchanged: true,
      plantedCredentialAbsentFromCentralState: true,
    };
    writeFileSync(join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    writeFileSync(join(outputDirectory, "transcript.txt"), `${transcript.join("\n")}\n`);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    writeFileSync(join(outputDirectory, "transcript.txt"), `${transcript.join("\n")}\n`);
    writeFileSync(
      join(outputDirectory, "failure.txt"),
      `${scrub(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
    );
    throw error;
  } finally {
    host?.kill();
    restart?.kill();
    if (packedPath && existsSync(packedPath)) unlinkSync(packedPath);
    await rm(root, { recursive: true, force: true });
  }
}

interface DriveStatus {
  id: string;
  ready: boolean;
  packages: number;
  sessions: number;
  records: number;
}

interface PreviewPayload {
  sessions: Array<{ key: string; nativeId: string }>;
  totals: { selected: number; redactions: number };
}

interface ToolPayload {
  results?: Array<{ resultId: string }>;
  records?: unknown[];
}

interface FixtureSet {
  repoA: string;
  repoB: string;
  repoC: string;
  claudeRoot: string;
  codexRoot: string;
  sourceFiles: string[];
}

interface CapturedProcess {
  child: ChildProcessWithoutNullStreams;
  text(): string;
  stdout(): string;
  wait(timeoutMs: number): Promise<void>;
  kill(): void;
}

function createFixtures(root: string): FixtureSet {
  const repoA = createRepository(join(root, "repos", "repo-a"));
  const repoB = createRepository(join(root, "repos", "repo-b"));
  const repoC = createRepository(join(root, "repos", "repo-c"));
  const claudeRoot = join(root, "sources", "claude");
  const codexRoot = join(root, "sources", "codex");
  const sourceFiles = [
    writeClaude(claudeRoot, repoA, "claude-keep", `quadratic walrus retry ${PLANTED_TOKEN}`),
    writeClaude(claudeRoot, repoA, "claude-drop", "MANUALLY EXCLUDED SESSION"),
    writeCodex(codexRoot, repoB, "codex-keep", "quadratic walrus retry from codex"),
    writeCodex(codexRoot, repoC, "codex-other", "UNSELECTED REPOSITORY SESSION"),
  ];
  for (const path of sourceFiles) chmodSync(path, 0o444);
  return { repoA, repoB, repoC, claudeRoot, codexRoot, sourceFiles };
}

function createRepository(path: string): string {
  mkdirSync(path, { recursive: true });
  runSync("git", ["init", "-q", path]);
  return realpathSync(path);
}

function writeClaude(root: string, repository: string, sessionId: string, text: string): string {
  const directory = join(root, repository.split(sep).join("-"));
  const path = join(directory, `${sessionId}.jsonl`);
  mkdirSync(directory, { recursive: true });
  const records = [
    {
      type: "user",
      sessionId,
      timestamp: "2026-08-20T06:00:00Z",
      message: { role: "user", content: text },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-08-20T06:01:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Implemented the retry decision" },
          { type: "tool_use", name: "Bash", input: { command: "bun test" } },
          {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: join(repository, "src/retry.ts"),
              old_string: "retry=1",
              new_string: "retry=3",
            },
          },
        ],
      },
    },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

function writeCodex(root: string, repository: string, sessionId: string, text: string): string {
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
      payload: { type: "message", role: "user", content: text },
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
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

function isolatedSourceEnvironment(
  root: string,
  driveHome: string,
  fixtures: FixtureSet,
): Record<string, string> {
  const source = (name: string) => join(root, "sources", name);
  return {
    DOSU_DRIVE_HOME: driveHome,
    DEJA_CLAUDE_ROOT: fixtures.claudeRoot,
    DEJA_CODEX_ROOT: fixtures.codexRoot,
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
  };
}

function startCaptured(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
  label: string,
): CapturedProcess {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    child,
    text: () => stripAnsi(`${stdout}${stderr}`),
    stdout: () => stripAnsi(stdout),
    wait: async (timeoutMs) => {
      const result = await withTimeout(completed, timeoutMs, `${label} did not exit`);
      transcript.push(`\n## ${label}\n${scrub(stripAnsi(`${stdout}${stderr}`))}`);
      if (result.code !== 0) throw new Error(`${label} exited ${result.code ?? result.signal}`);
    },
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
  label: string,
): Promise<string> {
  const process = startCaptured(
    command,
    args,
    { cwd: options.cwd, env: options.env ?? cleanEnvironment(globalThis.process.env) },
    label,
  );
  await process.wait(120_000);
  return process.stdout();
}

function runSync(command: string, args: string[]): void {
  const result = Bun.spawnSync([command, ...args], { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.toString()}`);
}

async function waitForActiveURL(
  driveHome: string,
  process: CapturedProcess,
  timeoutMs: number,
): Promise<string> {
  const statePath = join(driveHome, "state.json");
  return waitFor(
    async () => {
      if (process.child.exitCode !== null) throw new Error(`Host exited early:\n${process.text()}`);
      if (!existsSync(statePath)) return undefined;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { active?: { url?: unknown } };
        if (typeof state.active?.url !== "string") return undefined;
        const response = await fetch(`${state.active.url}/api/status`).catch(() => undefined);
        return response?.ok ? state.active.url : undefined;
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    "Host did not become ready",
  );
}

async function waitForPreviewURL(process: CapturedProcess, timeoutMs: number): Promise<string> {
  return waitFor(
    async () => {
      if (process.child.exitCode !== null)
        throw new Error(`Setup exited before preview:\n${process.text()}`);
      return process.text().match(/http:\/\/127\.0\.0\.1:\d+\/preview/)?.[0];
    },
    timeoutMs,
    "Setup did not expose a preview URL",
  );
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

async function postJSON(url: string, value: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
}

function parseDriveInvocation(content: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const start = content.indexOf("[mcp_servers.dosu-drive]");
  if (start < 0) throw new Error("Codex config has no dosu-drive section");
  const tail = content.slice(start);
  const commandRaw = tail.match(/^command = (.+)$/m)?.[1];
  const argsRaw = tail.match(/^args = (.+)$/m)?.[1];
  if (!commandRaw || !argsRaw) throw new Error("Codex dosu-drive invocation is incomplete");
  const env: Record<string, string> = {};
  const envStart = tail.indexOf("[mcp_servers.dosu-drive.env]");
  if (envStart >= 0) {
    const block = tail.slice(envStart).split(/\n\[/, 1)[0];
    for (const line of block.split("\n").slice(1)) {
      const match = line.match(/^([A-Z0-9_]+) = (.+)$/);
      if (match) env[match[1]] = JSON.parse(match[2]) as string;
    }
  }
  return {
    command: JSON.parse(commandRaw) as string,
    args: JSON.parse(argsRaw) as string[],
    env,
  };
}

function parseToolText(value: unknown): ToolPayload {
  if (
    !value ||
    typeof value !== "object" ||
    !("content" in value) ||
    !Array.isArray(value.content)
  ) {
    throw new Error("MCP tool returned no content");
  }
  const first = value.content[0];
  if (!first || typeof first !== "object" || !("text" in first)) {
    throw new Error("MCP tool returned no text");
  }
  return JSON.parse(String(first.text)) as ToolPayload;
}

function fingerprint(path: string) {
  const stat = statSync(path, { bigint: true });
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size.toString(),
    mode: Number(stat.mode & 0o777n),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function treeContains(root: string, text: string): boolean {
  const needle = Buffer.from(text);
  for (const path of walkFiles(root)) {
    if (readFileSync(path).includes(needle)) return true;
  }
  return false;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function cleanEnvironment(
  value: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseNpmPackOutput(output: string): Array<{ filename: string; size: number }> {
  const trimmed = output.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  const value = JSON.parse(jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed) as unknown;
  if (!Array.isArray(value) || typeof value[0]?.filename !== "string") {
    throw new Error("npm pack returned no tarball metadata");
  }
  return value as Array<{ filename: string; size: number }>;
}

function stripAnsi(value: string): string {
  const ansiEscape = String.fromCharCode(27);
  return value.replace(new RegExp(`${ansiEscape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function scrub(value: string): string {
  return value.replaceAll(PLANTED_TOKEN, "[REDACTED_TEST_TOKEN]");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
