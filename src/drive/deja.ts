import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { driveHome } from "./paths";
import type { DejaSession } from "./types";

const DEJA_VERSION = "deja 0.17.3-dosu.1";
const SCAN_PROGRESS_PREFIX = "@dosu-scan ";

export interface DejaWorkspace {
  root: string;
  indexDirectory: string;
  exportDirectory: string;
  version: string;
  sessions: DejaSession[];
  cleanup(): Promise<void>;
}

interface DejaScanOptions {
  onScanPath?: (path: string) => void;
}

interface RunDejaOptions extends DejaScanOptions {}

export async function scanWithDeja(
  projectRoots: readonly string[] = [],
  options: DejaScanOptions = {},
): Promise<DejaWorkspace> {
  const temporaryParent = join(driveHome(), "tmp");
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(temporaryParent, "setup-"));
  const indexDirectory = join(root, "index");
  const exportDirectory = join(root, "export");
  const environment = {
    ...process.env,
    DEJA_INDEX_DIR: indexDirectory,
    DEJA_INDEX_COMMANDS: "1",
    DEJA_INDEX_EDITS: "1",
    DEJA_INDEX_PATHS: "1",
    DEJA_INDEX_TOOL_OUTPUT: "1",
    DEJA_NO_REDACT: "0",
    DEJA_PROJECT_ROOTS: projectRoots.join(delimiter),
    DEJA_SCAN_PROGRESS: "1",
  };
  const cleanup = () => cleanupWorkspace(root, temporaryParent);

  try {
    const version = (await runDeja(["version"], environment, options)).stdout.trim();
    if (version !== DEJA_VERSION) {
      throw new Error(`Expected ${DEJA_VERSION}, received ${version || "no version"}`);
    }
    await runDeja(["index"], environment, options);
    const recent = parseRecent(
      (await runDeja(["last", "100000", "--json"], environment, options)).stdout,
    );
    await runDeja(["sync", "export", exportDirectory, "--full"], environment, options);
    return {
      root,
      indexDirectory,
      exportDirectory,
      version,
      sessions: recent,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function runDeja(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: RunDejaOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const entry = environment.DOSU_DRIVE_DEJA_ENTRY ?? process.env.DOSU_DRIVE_DEJA_ENTRY;
  const binary = environment.DOSU_DRIVE_DEJA_BIN ?? process.env.DOSU_DRIVE_DEJA_BIN;
  const command = entry ? process.execPath : (binary ?? bundledDejaPath());
  const commandArgs = entry ? [entry, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let progressBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      progressBuffer += chunk.toString("utf8");
      progressBuffer = consumeScanProgress(progressBuffer, options.onScanPath);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      consumeScanProgress(`${progressBuffer}\n`, options.onScanPath);
      const errors = stripScanProgress(Buffer.concat(stderr).toString("utf8"));
      if (code === 0) resolve({ stdout: output, stderr: errors });
      else
        reject(
          new Error(`deja-vu ${args[0] ?? "command"} failed: ${errors.trim() || output.trim()}`),
        );
    });
  });
}

function bundledDejaPath(): string {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
    throw new Error("Dosu Drive's bundled deja-vu runtime currently supports macOS only");
  }
  const filename = `deja-darwin-${process.arch}`;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "runtime", filename),
    join(moduleDirectory, "..", "..", "bin", "runtime", filename),
    ...(process.argv[1] ? [join(dirname(process.argv[1]), "runtime", filename)] : []),
  ];
  const runtime = candidates.find(existsSync);
  if (!runtime) {
    throw new Error(`Dosu Drive is missing its bundled deja-vu runtime (${filename})`);
  }
  return runtime;
}

function consumeScanProgress(buffer: string, onScanPath?: (path: string) => void): string {
  const lines = buffer.split("\n");
  const pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith(SCAN_PROGRESS_PREFIX)) continue;
    try {
      const event = JSON.parse(line.slice(SCAN_PROGRESS_PREFIX.length)) as { path?: unknown };
      if (typeof event.path === "string") onScanPath?.(event.path);
    } catch {
      // A malformed private progress event is cosmetic; the DV command still
      // determines success or failure through its exit status.
    }
  }
  return pending;
}

function stripScanProgress(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.startsWith(SCAN_PROGRESS_PREFIX))
    .join("\n");
}

async function cleanupWorkspace(root: string, parent: string): Promise<void> {
  const rel = relative(parent, root);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Refusing to clean an invalid Drive temporary path");
  }
  await rm(root, { recursive: true, force: true });
}

function parseRecent(output: string): DejaSession[] {
  const value = parseJSON(output);
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("deja-vu returned an invalid session listing");
  }
  return value.sessions.map(parseSession);
}

function parseSession(value: unknown): DejaSession {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.harness !== "string" ||
    typeof value.project !== "string" ||
    typeof value.started !== "string" ||
    typeof value.updated !== "string"
  ) {
    throw new Error("deja-vu returned incomplete session metadata");
  }
  return {
    id: value.id,
    harness: value.harness,
    project: value.project,
    started: value.started,
    updated: value.updated,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(Array.isArray(value.touched)
      ? { touched: value.touched.filter((item): item is string => typeof item === "string") }
      : {}),
  };
}

function parseJSON(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("deja-vu returned invalid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
