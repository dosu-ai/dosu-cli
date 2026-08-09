import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";

const STORE_VERSION = 1 as const;

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export interface StoredProjectMcpCredential {
  endpoint: string;
  api_key: string;
}

interface ProjectMcpCredentialRecord {
  schema_version: typeof STORE_VERSION;
  user_id: string;
  target_key: string;
  credential: StoredProjectMcpCredential;
}

export interface ProjectMcpCredentialCleanupDependencies {
  platform?: NodeJS.Platform;
  getuid?: () => number;
}

export function getProjectMcpCredentialStorePath(): string {
  return join(getConfigDir(), "project-mcp-credentials.v1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function credentialFileName(userID: string, targetKey: string): string {
  return `${createHash("sha256").update(userID).update("\0").update(targetKey).digest("hex")}.json`;
}

function assertStoreDirectory(path: string): void {
  if (!entryExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Invalid project MCP credential store at ${path}`);
  }
}

function recordPath(storePath: string, userID: string, targetKey: string): string {
  assertStoreDirectory(storePath);
  return join(storePath, credentialFileName(userID, targetKey));
}

function parseRecord(path: string): ProjectMcpCredentialRecord | null {
  if (!entryExists(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Invalid project MCP credential record at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Invalid project MCP credential record at ${path}`);
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ["schema_version", "user_id", "target_key", "credential"]) ||
    parsed.schema_version !== STORE_VERSION ||
    typeof parsed.user_id !== "string" ||
    !parsed.user_id ||
    typeof parsed.target_key !== "string" ||
    !parsed.target_key ||
    !isRecord(parsed.credential) ||
    !exactKeys(parsed.credential, ["endpoint", "api_key"]) ||
    typeof parsed.credential.endpoint !== "string" ||
    !parsed.credential.endpoint ||
    typeof parsed.credential.api_key !== "string" ||
    !parsed.credential.api_key
  ) {
    throw new Error(`Invalid project MCP credential record at ${path}`);
  }
  return {
    schema_version: STORE_VERSION,
    user_id: parsed.user_id,
    target_key: parsed.target_key,
    credential: {
      endpoint: parsed.credential.endpoint,
      api_key: parsed.credential.api_key,
    },
  };
}

function assertOwnedCrashTemporary(
  path: string,
  expectedRecordName: string,
  deps: ProjectMcpCredentialCleanupDependencies,
): ProjectMcpCredentialRecord {
  const stat = lstatSync(path);
  const platform = deps.platform ?? process.platform;
  const permissions = stat.mode & 0o777;
  // libuv exposes Windows files as 0666 even when Node created them with
  // mode 0600. Windows therefore relies on the private, non-symlink store plus
  // the exact random filename, record hash, schema, and identity checks below.
  const hasExpectedPermissions =
    platform === "win32" ? permissions === 0o600 || permissions === 0o666 : permissions === 0o600;
  const getuid =
    deps.getuid ??
    (typeof process.getuid === "function" ? process.getuid.bind(process) : undefined);
  const hasExpectedOwner = platform === "win32" || (getuid !== undefined && stat.uid === getuid());
  if (!stat.isFile() || stat.isSymbolicLink() || !hasExpectedPermissions || !hasExpectedOwner) {
    throw new Error(`Invalid project MCP credential temporary at ${path}`);
  }
  const parsed = parseRecord(path);
  if (!parsed || expectedRecordName !== credentialFileName(parsed.user_id, parsed.target_key)) {
    throw new Error(`Invalid project MCP credential temporary at ${path}`);
  }
  return parsed;
}

export function saveProjectMcpCredential(input: {
  userID: string;
  targetKey: string;
  credential: StoredProjectMcpCredential;
  path?: string;
}): void {
  if (!input.userID || !input.targetKey)
    throw new Error("Project MCP credential identity is required");
  const storePath = input.path ?? getProjectMcpCredentialStorePath();
  assertStoreDirectory(storePath);
  if (!entryExists(storePath)) mkdirSync(storePath, { recursive: true, mode: 0o700 });
  chmodSync(storePath, 0o700);
  const path = recordPath(storePath, input.userID, input.targetKey);
  const existing = parseRecord(path);
  if (existing && (existing.user_id !== input.userID || existing.target_key !== input.targetKey)) {
    throw new Error("Project MCP credential record identity mismatch");
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const record: ProjectMcpCredentialRecord = {
    schema_version: STORE_VERSION,
    user_id: input.userID,
    target_key: input.targetKey,
    credential: input.credential,
  };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Continue to remove the exact random temporary created with O_EXCL.
      }
    }
    if (entryExists(temporary)) unlinkSync(temporary);
  }
}

export function readProjectMcpCredential(input: {
  userID: string;
  targetKey: string;
  path?: string;
}): StoredProjectMcpCredential | undefined {
  const storePath = input.path ?? getProjectMcpCredentialStorePath();
  const record = parseRecord(recordPath(storePath, input.userID, input.targetKey));
  if (!record) return undefined;
  if (record.user_id !== input.userID || record.target_key !== input.targetKey) {
    throw new Error("Project MCP credential record identity mismatch");
  }
  return record.credential;
}

export function clearProjectMcpCredentials(
  path: string = getProjectMcpCredentialStorePath(),
  deps: ProjectMcpCredentialCleanupDependencies = {},
): void {
  if (!entryExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Invalid project MCP credential store at ${path}`);
  }

  // Plan the whole cleanup before deleting anything. A dedicated directory is
  // not sufficient ownership proof: preserve it byte-for-byte if it contains
  // a foreign file, malformed record, symlink, or nested directory.
  const ownedRecords = readdirSync(path, { withFileTypes: true }).map((entry) => {
    const record = join(path, entry.name);
    if (!entry.isFile()) {
      throw new Error(`Unrecognized file in project MCP credential store: ${record}`);
    }
    if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      const parsed = parseRecord(record);
      if (!parsed || entry.name !== credentialFileName(parsed.user_id, parsed.target_key)) {
        throw new Error(`Invalid project MCP credential record at ${record}`);
      }
      return record;
    }
    const temporary = entry.name.match(
      /^([a-f0-9]{64}\.json)\.([1-9][0-9]*)\.([a-f0-9]{12})\.tmp$/,
    );
    if (!temporary) {
      throw new Error(`Unrecognized file in project MCP credential store: ${record}`);
    }
    assertOwnedCrashTemporary(record, temporary[1], deps);
    return record;
  });

  for (const record of ownedRecords) unlinkSync(record);
  rmdirSync(path);
}
