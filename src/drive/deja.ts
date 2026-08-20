import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { driveHome } from "./paths";
import type { DejaSession } from "./types";

export const DEJA_PACKAGE = "@vshulcz/deja-vu@0.17.3";

export interface DejaWorkspace {
  root: string;
  indexDirectory: string;
  exportDirectory: string;
  version: string;
  doctor: unknown;
  sessions: DejaSession[];
  cleanup(): Promise<void>;
}

export async function scanWithDeja(): Promise<DejaWorkspace> {
  const temporaryParent = join(driveHome(), "tmp");
  await mkdir(temporaryParent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(temporaryParent, "setup-"));
  const indexDirectory = join(root, "index");
  const exportDirectory = join(root, "export");
  const environment = { ...process.env, DEJA_INDEX_DIR: indexDirectory };
  const cleanup = () => cleanupWorkspace(root, temporaryParent);

  try {
    const version = (await runDeja(["version"], environment)).stdout.trim();
    if (version !== "deja 0.17.3") {
      throw new Error(`Expected deja-vu 0.17.3, received ${version || "no version"}`);
    }
    await runDeja(["index"], environment);
    const doctor = parseJSON(
      (await runDeja(["doctor", "--offline", "--deep", "--json"], environment)).stdout,
    );
    const recent = parseRecent((await runDeja(["last", "100000", "--json"], environment)).stdout);
    await runDeja(["sync", "export", exportDirectory, "--full"], environment);
    return {
      root,
      indexDirectory,
      exportDirectory,
      version,
      doctor,
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
): Promise<{ stdout: string; stderr: string }> {
  const entry = process.env.DOSU_DRIVE_DEJA_ENTRY;
  const command = entry ? process.execPath : "npx";
  const commandArgs = entry ? [entry, ...args] : ["-y", "--package", DEJA_PACKAGE, "deja", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: output, stderr: errors });
      else
        reject(
          new Error(`deja-vu ${args[0] ?? "command"} failed: ${errors.trim() || output.trim()}`),
        );
    });
  });
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
