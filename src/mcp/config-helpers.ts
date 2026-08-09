/**
 * Shared JSON config helpers for MCP provider configuration.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  applyEdits,
  getNodeValue,
  type Node as JSONCNode,
  modify,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
// Static default import (not `createRequire`) so `bun build --compile`
// statically detects the dependency and bundles it into the binary.
// Otherwise the compiled `dosu` looks for `write-file-atomic` on the
// caller's CWD `node_modules` at runtime and fails outside this repo.
// @ts-expect-error — write-file-atomic ships no types; shape is documented inline.
import writeFileAtomicRaw from "write-file-atomic";
import { getBackendURL } from "../config/constants";
import { removeJsonObjectPropertyRaw } from "../migration/planners";

type WriteFileAtomicOptions = {
  mode: number;
  chown: false;
};

const writeFileAtomic = writeFileAtomicRaw as {
  sync(path: string, data: string, options: WriteFileAtomicOptions): void;
};

// biome-ignore lint/suspicious/noExplicitAny: JSON config values are inherently untyped
type JsonConfig = Record<string, any>;

/**
 * Returns the MCP endpoint URL with deployment ID encoded in the path.
 */
export function mcpURL(deploymentID: string): string {
  return `${getBackendURL()}/v1/mcp/deployments/${deploymentID}`;
}

/**
 * Returns the base MCP endpoint URL without a deployment ID (for OSS mode).
 */
export function mcpBaseURL(): string {
  return `${getBackendURL()}/v1/mcp`;
}

/**
 * Returns the standard MCP headers with API key auth.
 */
export function mcpHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) {
    throw new Error("API key is required. Run 'dosu setup' to create one.");
  }
  return { "X-Dosu-API-Key": apiKey };
}

/**
 * Exact-pinned so npx never floats to a fresh release on user machines —
 * mcp-remote is a third-party package on the agent hot path, and a floating
 * tag would bypass the supply-chain delay this repo applies to its own
 * dependencies (bunfig minimumReleaseAge). Bump deliberately.
 */
export const MCP_REMOTE_VERSION = "0.1.38";

export interface McpRemoteServer {
  args: string[];
  env: Record<string, string>;
}

/**
 * Builds the `npx mcp-remote` invocation that proxies the remote HTTP MCP
 * endpoint as a local stdio server. Hosts that only render MCP Apps for
 * stdio servers (Codex desktop, Claude Desktop chat) need this form — a
 * remote-HTTP entry serves tools fine but never shows the Session Knowledge
 * card.
 *
 * Header values are passed as `${VAR}` placeholders that mcp-remote expands
 * from its environment, so the API key lives in the config entry's `env`
 * block instead of argv (argv is visible to every local process via `ps`).
 */
export function mcpRemoteServer(url: string, apiKey: string | undefined): McpRemoteServer {
  const env: Record<string, string> = {};
  const headerArgs = Object.entries(mcpHeaders(apiKey)).flatMap(([key, value]) => {
    const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    env[envKey] = value;
    return ["--header", `${key}:\${${envKey}}`];
  });
  return {
    args: [
      "-y",
      `mcp-remote@${MCP_REMOTE_VERSION}`,
      url,
      ...headerArgs,
      "--transport",
      "http-only",
    ],
    env,
  };
}

/**
 * Reads and unmarshals a JSON config file. Returns an empty object if the file doesn't exist.
 * For .jsonc files, comments are stripped before parsing.
 */
export function loadJSONConfig(path: string): JsonConfig {
  if (!existsSync(path)) return {};
  let data = readFileSync(path, "utf-8").trim();
  if (!data) return {};
  if (path.endsWith(".jsonc")) {
    data = stripJSONComments(data);
  }
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Strips // and block comments from JSONC content, preserving strings.
 */
export function stripJSONComments(data: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < data.length) {
    // String literal — copy verbatim, handling escapes
    if (data[i] === '"') {
      result.push(data[i]);
      i++;
      while (i < data.length && data[i] !== '"') {
        if (data[i] === "\\") {
          result.push(data[i]);
          i++;
          if (i < data.length) {
            result.push(data[i]);
            i++;
          }
          continue;
        }
        result.push(data[i]);
        i++;
      }
      if (i < data.length) {
        result.push(data[i]);
        i++;
      }
      continue;
    }

    // Line comment
    if (i + 1 < data.length && data[i] === "/" && data[i + 1] === "/") {
      i += 2;
      while (i < data.length && data[i] !== "\n") i++;
      continue;
    }

    // Block comment
    if (i + 1 < data.length && data[i] === "/" && data[i + 1] === "*") {
      i += 2;
      while (i + 1 < data.length && !(data[i] === "*" && data[i + 1] === "/")) i++;
      if (i + 1 < data.length) i += 2;
      continue;
    }

    result.push(data[i]);
    i++;
  }

  return result.join("");
}

/**
 * Writes a JSON config file, creating parent directories as needed.
 */
export function saveJSONConfig(path: string, cfg: JsonConfig): void {
  writeSecureFile(path, JSON.stringify(cfg, null, 2));
}

/** Writes a secret-bearing config file atomically with owner-only permissions. */
export function writeSecureFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileAtomic.sync(path, content, { mode: 0o600, chown: false });
}

type ProjectFileSnapshot =
  | { kind: "absent" }
  | { kind: "file"; content: string; dev: number; ino: number; mode: number };

function projectFileSnapshot(path: string): ProjectFileSnapshot {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Refusing to modify non-regular project file at ${path}`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Project file changed while it was read: ${path}`);
    }
    const content = readFileSync(fd, "utf8");
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error(`Project file changed while it was read: ${path}`);
    }
    return {
      kind: "file",
      content,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode & 0o777,
    };
  } finally {
    closeSync(fd);
  }
}

function sameProjectFileSnapshot(left: ProjectFileSnapshot, right: ProjectFileSnapshot): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === "absent" ||
    (right.kind === "file" &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.content === right.content)
  );
}

function fsyncProjectParent(path: string): void {
  try {
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  }
}

export interface ProjectFileMutationHooks {
  /** Fault-injection seam for filesystems that cannot publish with hard links. */
  probeHardLink?: (existingPath: string, newPath: string) => void;
  /** Fault-injection seam for race regression tests. */
  beforeCapture?: () => void;
  /** Fault-injection seam after journaling and immediately before capture rename. */
  beforeCaptureRename?: () => void;
  /** Simulates process death after the public path was durably captured. */
  crashAfterCapture?: boolean;
  /** Fault-injection seam for race regression tests. */
  beforePublish?: () => void;
}

/** Exact file states observed by the atomic writer around one successful mutation. */
export interface ProjectFileMutationReceipt {
  path: string;
  beforeContent: string | null;
  beforeMode: number | null;
  afterContent: string;
  afterMode: number;
}

interface CapturedProjectFile {
  path: string;
  root: string;
  journalPath: string;
  journalContent: string;
}

interface ProjectCaptureJournal {
  schema: 1;
  target: string;
  captured: {
    dev: string;
    ino: string;
    mode: number;
    bytes: number;
    sha256: string;
  };
}

const CAPTURE_JOURNAL = "journal.json";

function unlinkOwnedProbe(path: string, dev: number, ino: number): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino) {
      unlinkSync(path);
    }
  } catch {
    // The random probe path either never existed or no longer belongs to us.
  }
}

/**
 * Existing project files are captured before a no-replace publish. Both safe
 * publish and safe restore therefore require same-directory hard links. Probe
 * that capability before moving the user's public path; unsupported filesystems
 * fail with the original file still exactly where it was.
 */
function assertProjectHardLinksAvailable(
  path: string,
  probeHardLink: ProjectFileMutationHooks["probeHardLink"] = linkSync,
): void {
  const nonce = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const sourcePath = `${path}.dosu-hardlink-probe-${nonce}`;
  const linkedPath = `${sourcePath}.link`;
  let fd: number | undefined;
  let sourceIdentity: { dev: number; ino: number } | undefined;
  try {
    fd = openSync(sourcePath, "wx", 0o600);
    const source = fstatSync(fd);
    if (!source.isFile()) throw new Error("probe source is not a regular file");
    sourceIdentity = { dev: source.dev, ino: source.ino };
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    probeHardLink(sourcePath, linkedPath);
    const linked = lstatSync(linkedPath);
    if (
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      linked.dev !== source.dev ||
      linked.ino !== source.ino
    ) {
      throw new Error("probe link did not preserve file identity");
    }
  } catch {
    throw new Error(
      `Project filesystem does not support the hard links required for a safe update; ${path} was left unchanged`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Continue to identity-checked cleanup below.
      }
    }
    if (sourceIdentity) {
      unlinkOwnedProbe(linkedPath, sourceIdentity.dev, sourceIdentity.ino);
      unlinkOwnedProbe(sourcePath, sourceIdentity.dev, sourceIdentity.ino);
      fsyncProjectParent(path);
    }
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function captureRootPrefix(path: string): string {
  return `${basename(path)}.dosu-capture-`;
}

function pathEntryExists(path: string): boolean {
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

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCaptureJournal(content: string, path: string): ProjectCaptureJournal {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Invalid project-file recovery journal at ${path}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactObjectKeys(value as Record<string, unknown>, ["schema", "target", "captured"])
  ) {
    throw new Error(`Invalid project-file recovery journal at ${path}`);
  }
  const journal = value as Record<string, unknown>;
  const captured = journal.captured;
  if (
    journal.schema !== 1 ||
    typeof journal.target !== "string" ||
    typeof captured !== "object" ||
    captured === null ||
    Array.isArray(captured) ||
    !exactObjectKeys(captured as Record<string, unknown>, ["dev", "ino", "mode", "bytes", "sha256"])
  ) {
    throw new Error(`Invalid project-file recovery journal at ${path}`);
  }
  const metadata = captured as Record<string, unknown>;
  if (
    typeof metadata.dev !== "string" ||
    typeof metadata.ino !== "string" ||
    typeof metadata.mode !== "number" ||
    !Number.isInteger(metadata.mode) ||
    typeof metadata.bytes !== "number" ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes < 0 ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    throw new Error(`Invalid project-file recovery journal at ${path}`);
  }
  return value as ProjectCaptureJournal;
}

function removeEmptyProjectStagingRoot(root: string): void {
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(root).length !== 0) return;
    rmdirSync(root);
    fsyncProjectParent(root);
  } catch {
    // A non-empty root can contain the only recoverable copy of a concurrently
    // replaced project file. Never remove it recursively.
  }
}

function cleanupUnexpectedCaptureMetadata(captured: CapturedProjectFile): void {
  const journal = projectFileSnapshot(captured.journalPath);
  if (journal.kind !== "file" || journal.content !== captured.journalContent) {
    throw new Error(`Project-file recovery journal changed at ${captured.journalPath}`);
  }
  unlinkSync(captured.journalPath);
  removeEmptyProjectStagingRoot(captured.root);
}

/**
 * The public entry can change after its regular-file journal is written but
 * before rename(2). Restore that unexpected object with a no-clobber primitive
 * instead of hiding it in Dosu's stage. A directory uses an atomically-created
 * empty placeholder so POSIX rename cannot overwrite a concurrent writer;
 * platforms that cannot replace the placeholder keep the original stage.
 */
function restoreUnexpectedCapturedEntry(captured: CapturedProjectFile, path: string): boolean {
  try {
    const root = lstatSync(captured.root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0) return false;
    const entries = readdirSync(captured.root).sort();
    if (entries.length !== 2 || entries[0] !== "captured" || entries[1] !== CAPTURE_JOURNAL) {
      return false;
    }
    const journal = projectFileSnapshot(captured.journalPath);
    if (journal.kind !== "file" || journal.content !== captured.journalContent) return false;

    const source = lstatSync(captured.path);
    if (source.isSymbolicLink()) {
      const target = readlinkSync(captured.path);
      symlinkSync(target, path);
      if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) return false;
      unlinkSync(captured.path);
      cleanupUnexpectedCaptureMetadata(captured);
      fsyncProjectParent(path);
      return true;
    }
    if (source.isFile()) {
      linkSync(captured.path, path);
      const restored = lstatSync(path);
      if (restored.dev !== source.dev || restored.ino !== source.ino) return false;
      unlinkSync(captured.path);
      cleanupUnexpectedCaptureMetadata(captured);
      fsyncProjectParent(path);
      return true;
    }
    if (!source.isDirectory()) return false;

    mkdirSync(path, { mode: source.mode & 0o777 });
    const placeholder = lstatSync(path);
    try {
      renameSync(captured.path, path);
      const restored = lstatSync(path);
      if (!restored.isDirectory() || restored.dev !== source.dev || restored.ino !== source.ino) {
        return false;
      }
      cleanupUnexpectedCaptureMetadata(captured);
      fsyncProjectParent(path);
      return true;
    } catch {
      try {
        const current = lstatSync(path);
        if (
          current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === placeholder.dev &&
          current.ino === placeholder.ino &&
          readdirSync(path).length === 0
        ) {
          rmdirSync(path);
        }
      } catch {
        // Preserve a concurrently changed placeholder and the captured source.
      }
      return false;
    }
  } catch {
    return false;
  }
}

function captureProjectFile(
  path: string,
  hooks?: Pick<ProjectFileMutationHooks, "beforeCaptureRename">,
): CapturedProjectFile {
  const parent = dirname(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const root = `${path}.dosu-capture-${process.pid}-${randomBytes(12).toString("hex")}`;
    let rootCreated = false;
    let journalCreated = false;
    let renamed = false;
    const journalPath = join(root, CAPTURE_JOURNAL);
    let journalContent = "";
    try {
      mkdirSync(root, { mode: 0o700 });
      rootCreated = true;
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
        throw new Error(`Unsafe project-file staging root at ${root}`);
      }
      fsyncProjectParent(root);
      const actual = projectFileSnapshot(path);
      if (actual.kind !== "file") {
        throw new Error(`Project file disappeared before capture: ${path}`);
      }
      journalContent = `${JSON.stringify({
        schema: 1,
        target: resolve(path),
        captured: {
          dev: String(actual.dev),
          ino: String(actual.ino),
          mode: actual.mode,
          bytes: Buffer.byteLength(actual.content, "utf8"),
          sha256: contentHash(actual.content),
        },
      } satisfies ProjectCaptureJournal)}\n`;
      const journalFD = openSync(journalPath, "wx", 0o600);
      journalCreated = true;
      try {
        writeFileSync(journalFD, journalContent, "utf8");
        fchmodSync(journalFD, 0o600);
        fsyncSync(journalFD);
      } finally {
        closeSync(journalFD);
      }
      fsyncProjectParent(journalPath);
      const captured = join(root, "captured");
      hooks?.beforeCaptureRename?.();
      renameSync(path, captured);
      renamed = true;
      fsyncProjectParent(path);
      fsyncProjectParent(captured);
      const result = { path: captured, root, journalPath, journalContent };
      try {
        return verifyCapturedProjectFile(root, path);
      } catch {
        if (restoreUnexpectedCapturedEntry(result, path)) {
          throw new Error(
            `Project file changed during capture; its concurrent replacement was restored at ${path}`,
          );
        }
        throw new Error(
          `Project file changed during capture; the captured replacement was retained at ${captured}`,
        );
      }
    } catch (error: unknown) {
      if (rootCreated && !renamed) {
        if (journalCreated) {
          try {
            const journal = projectFileSnapshot(journalPath);
            if (journal.kind === "file" && journal.content === journalContent) {
              unlinkSync(journalPath);
            }
          } catch {
            // Preserve anything that is no longer the exact journal we wrote.
          }
        }
        removeEmptyProjectStagingRoot(root);
      }
      if (
        !rootCreated &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not allocate project-file staging beside ${parent}`);
}

function verifyCapturedProjectFile(root: string, path: string): CapturedProjectFile {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe project-file recovery stage at ${root}`);
  }
  const entries = readdirSync(root).sort();
  if (entries.length !== 2 || entries[0] !== "captured" || entries[1] !== CAPTURE_JOURNAL) {
    throw new Error(`Ambiguous project-file recovery stage at ${root}`);
  }
  const journalPath = join(root, CAPTURE_JOURNAL);
  const journalSnapshot = projectFileSnapshot(journalPath);
  if (journalSnapshot.kind !== "file" || (journalSnapshot.mode & 0o077) !== 0) {
    throw new Error(`Unsafe project-file recovery journal at ${journalPath}`);
  }
  const journal = parseCaptureJournal(journalSnapshot.content, journalPath);
  if (journal.target !== resolve(path)) {
    throw new Error(`Project-file recovery journal targets something else at ${journalPath}`);
  }
  const capturedPath = join(root, "captured");
  const captured = projectFileSnapshot(capturedPath);
  if (
    captured.kind !== "file" ||
    String(captured.dev) !== journal.captured.dev ||
    String(captured.ino) !== journal.captured.ino ||
    captured.mode !== journal.captured.mode ||
    Buffer.byteLength(captured.content, "utf8") !== journal.captured.bytes ||
    contentHash(captured.content) !== journal.captured.sha256
  ) {
    throw new Error(`Captured project file does not match its recovery journal at ${root}`);
  }
  return {
    path: capturedPath,
    root,
    journalPath,
    journalContent: journalSnapshot.content,
  };
}

function cleanupVerifiedCapture(captured: CapturedProjectFile, path: string): void {
  const verified = verifyCapturedProjectFile(captured.root, path);
  unlinkSync(verified.path);
  const journal = projectFileSnapshot(verified.journalPath);
  if (journal.kind !== "file" || journal.content !== verified.journalContent) {
    throw new Error(`Project-file recovery journal changed at ${verified.journalPath}`);
  }
  unlinkSync(verified.journalPath);
  removeEmptyProjectStagingRoot(verified.root);
}

function restoreCapturedProjectFile(captured: CapturedProjectFile, path: string): boolean {
  try {
    const verified = verifyCapturedProjectFile(captured.root, path);
    // link(2) is an atomic no-replace publish for regular files. If another
    // process recreated the project path, preserve both it and the captured
    // preimage instead of overwriting either one.
    linkSync(verified.path, path);
    const source = lstatSync(verified.path);
    const restored = lstatSync(path);
    if (source.dev !== restored.dev || source.ino !== restored.ino) return false;
    cleanupVerifiedCapture(verified, path);
    fsyncProjectParent(path);
    return true;
  } catch {
    return false;
  }
}

function recoverPendingProjectCapture(path: string): void {
  const parent = dirname(path);
  let pending: string[];
  try {
    const prefix = captureRootPrefix(path);
    pending = readdirSync(parent)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => join(parent, entry));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (pending.length === 0) return;
  if (pathEntryExists(path)) {
    throw new Error(`Project file has a pending recovery stage and an existing target: ${path}`);
  }
  if (pending.length !== 1) {
    throw new Error(`Project file has ambiguous pending recovery stages: ${path}`);
  }
  const captured = verifyCapturedProjectFile(pending[0], path);
  if (!restoreCapturedProjectFile(captured, path)) {
    throw new Error(`Could not safely restore pending project file: ${path}`);
  }
}

/**
 * Atomically writes non-secret project metadata without following a target or
 * predictable temporary-file symlink. `expectedContent` is a caller-supplied
 * compare-and-swap guard; `null` means the destination must still be absent.
 */
export function writeProjectFile(
  path: string,
  content: string,
  expectedContent?: string | null,
  hooks?: ProjectFileMutationHooks,
): ProjectFileMutationReceipt {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to write through non-regular project directory at ${dir}`);
  }
  recoverPendingProjectCapture(path);
  const initial = projectFileSnapshot(path);
  if (
    (expectedContent === null && initial.kind !== "absent") ||
    (typeof expectedContent === "string" &&
      (initial.kind !== "file" || initial.content !== expectedContent))
  ) {
    throw new Error(`Project file changed before it could be written: ${path}`);
  }
  if (initial.kind === "file") {
    assertProjectHardLinksAvailable(path, hooks?.probeHardLink);
  }
  const mode = initial.kind === "file" ? initial.mode : 0o644;
  const temporary = `${path}.dosu-${process.pid}-${randomBytes(12).toString("hex")}.tmp`;
  let temporaryExists = false;
  let captured: CapturedProjectFile | null = null;
  let preserveCapturedForCrashRecovery = false;
  try {
    const fd = openSync(temporary, "wx", mode);
    temporaryExists = true;
    try {
      writeFileSync(fd, content, "utf8");
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (initial.kind === "file") {
      hooks?.beforeCapture?.();
      captured = captureProjectFile(path, hooks);
      if (hooks?.crashAfterCapture) {
        preserveCapturedForCrashRecovery = true;
        throw new Error(`Simulated crash after project-file capture: ${path}`);
      }
      if (!sameProjectFileSnapshot(initial, projectFileSnapshot(captured.path))) {
        const recoveryPath = captured.path;
        const restored = restoreCapturedProjectFile(captured, path);
        if (restored) captured = null;
        const recovery = restored ? "" : `; captured content retained at ${recoveryPath}`;
        throw new Error(`Project file changed before it could be written: ${path}${recovery}`);
      }
    } else if (projectFileSnapshot(path).kind !== "absent") {
      throw new Error(`Project file changed before it could be written: ${path}`);
    }

    hooks?.beforePublish?.();
    // Publish with no-replace semantics. A concurrent writer wins and is never
    // overwritten; the captured preimage remains available for recovery.
    linkSync(temporary, path);
    const published = projectFileSnapshot(path);
    if (published.kind !== "file" || published.content !== content) {
      throw new Error(`Project file changed while it was published: ${path}`);
    }
    unlinkSync(temporary);
    temporaryExists = false;
    if (captured) {
      cleanupVerifiedCapture(captured, path);
      captured = null;
    }
    fsyncProjectParent(path);
  } catch (error) {
    if (captured && !preserveCapturedForCrashRecovery) {
      const restored = restoreCapturedProjectFile(captured, path);
      if (restored) captured = null;
    }
    throw error;
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch {
        // A never-published temporary file contains only non-secret metadata.
      }
    }
  }
  return {
    path,
    beforeContent: initial.kind === "file" ? initial.content : null,
    beforeMode: initial.kind === "file" ? initial.mode : null,
    afterContent: content,
    afterMode: mode,
  };
}

/**
 * Remove one exact regular project file with the same atomic-capture rule used
 * for replacement. A concurrent replacement is restored or retained in the
 * staging directory; it is never unlinked through the public project path.
 */
export function removeProjectFile(
  path: string,
  expectedContent: string,
  hooks?: Pick<
    ProjectFileMutationHooks,
    "probeHardLink" | "beforeCapture" | "beforeCaptureRename" | "crashAfterCapture"
  >,
): void {
  recoverPendingProjectCapture(path);
  const initial = projectFileSnapshot(path);
  if (initial.kind !== "file" || initial.content !== expectedContent) {
    throw new Error(`Project file changed before it could be removed: ${path}`);
  }
  assertProjectHardLinksAvailable(path, hooks?.probeHardLink);

  let captured: CapturedProjectFile | null = null;
  let preserveCapturedForCrashRecovery = false;
  try {
    hooks?.beforeCapture?.();
    captured = captureProjectFile(path, hooks);
    if (hooks?.crashAfterCapture) {
      preserveCapturedForCrashRecovery = true;
      throw new Error(`Simulated crash after project-file capture: ${path}`);
    }
    if (!sameProjectFileSnapshot(initial, projectFileSnapshot(captured.path))) {
      const recoveryPath = captured.path;
      const restored = restoreCapturedProjectFile(captured, path);
      if (restored) captured = null;
      const recovery = restored ? "" : `; captured content retained at ${recoveryPath}`;
      throw new Error(`Project file changed before it could be removed: ${path}${recovery}`);
    }
    cleanupVerifiedCapture(captured, path);
    captured = null;
    fsyncProjectParent(path);
  } catch (error) {
    if (captured && !preserveCapturedForCrashRecovery) {
      const restored = restoreCapturedProjectFile(captured, path);
      if (restored) captured = null;
    }
    throw error;
  }
}

/**
 * Checks if "dosu" exists under the given top-level key in a JSON config file.
 */
export function isJSONKeyConfigured(configPath: string, topLevelKey: string): boolean {
  const cfg = loadJSONConfig(configPath);
  const section = cfg[topLevelKey];
  if (typeof section !== "object" || section === null) return false;
  return "dosu" in section;
}

function propertyValueNode(object: JSONCNode, key: string): JSONCNode | undefined {
  if (object.type !== "object") return undefined;
  const matches = (object.children ?? []).filter(
    (property) => property.children?.[0]?.value === key,
  );
  if (matches.length > 1) {
    throw new Error(`Duplicate JSON property "${key}"; refusing to modify the config`);
  }
  return matches[0]?.children?.[1];
}

function parseJSONTreeStrict(path: string, content: string): JSONCNode {
  const errors: ParseError[] = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length > 0 || tree.type !== "object") {
    throw new Error(`Invalid JSON/JSONC in ${path}; refusing to modify the config`);
  }
  assertUniqueProperties(tree, path);
  return tree;
}

function assertUniqueProperties(node: JSONCNode, path: string): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key === "string") {
        if (keys.has(key)) {
          throw new Error(`Duplicate JSON property "${key}"; refusing to modify ${path}`);
        }
        keys.add(key);
      }
      for (const child of property.children ?? []) assertUniqueProperties(child, path);
    }
    return;
  }
  for (const child of node.children ?? []) assertUniqueProperties(child, path);
}

function projectEntry(path: string, topLevelKey: string): unknown {
  if (!existsSync(path)) return undefined;
  assertRegularProjectFile(path);
  const content = readFileSync(path, "utf8");
  const tree = parseJSONTreeStrict(path, content);
  const section = propertyValueNode(tree, topLevelKey);
  if (!section) return undefined;
  if (section.type !== "object") {
    throw new Error(`JSON property "${topLevelKey}" is not an object; refusing to modify ${path}`);
  }
  const node = propertyValueNode(section, "dosu");
  return node ? getNodeValue(node) : undefined;
}

/** Project config symlinks can escape the repository; never replace or follow them silently. */
export function assertRegularProjectFile(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to modify symbolic link at ${path}`);
  }
}

function formattingFor(content: string) {
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const indent = content.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : Math.max(1, indent.length),
    eol: lineEnding,
  };
}

/** Upsert one verified Dosu project entry while preserving JSONC comments and sibling formatting. */
export function installProjectJSONServer(
  path: string,
  topLevelKey: string,
  server: Record<string, unknown>,
  isOwned: (entry: unknown) => boolean,
  validateExisting?: (entry: unknown) => void,
): ProjectFileMutationReceipt {
  assertRegularProjectFile(path);
  if (!existsSync(path)) {
    return writeProjectFile(
      path,
      JSON.stringify({ [topLevelKey]: { dosu: server } }, null, 2),
      null,
    );
  }

  const content = readFileSync(path, "utf8");
  const tree = parseJSONTreeStrict(path, content);
  const section = propertyValueNode(tree, topLevelKey);
  if (section && section.type !== "object") {
    throw new Error(`JSON property "${topLevelKey}" is not an object; refusing to modify ${path}`);
  }
  const currentNode = section ? propertyValueNode(section, "dosu") : undefined;
  const current = currentNode ? getNodeValue(currentNode) : undefined;
  if (current !== undefined && !isOwned(current)) {
    throw new Error(`Found a non-Dosu server named "dosu" in ${path}; refusing to overwrite it`);
  }
  if (current !== undefined) validateExisting?.(current);

  const edits = modify(content, [topLevelKey, "dosu"], server, {
    formattingOptions: formattingFor(content),
  });
  return writeProjectFile(path, applyEdits(content, edits), content);
}

export function isProjectJSONServerConfigured(
  path: string,
  topLevelKey: string,
  isOwned: (entry: unknown) => boolean,
): boolean {
  try {
    const entry = projectEntry(path, topLevelKey);
    return entry !== undefined && isOwned(entry);
  } catch {
    return false;
  }
}

/** Remove only a verified Dosu project entry and preserve the containing config file. */
export function removeProjectJSONServer(
  path: string,
  topLevelKey: string,
  isOwned: (entry: unknown) => boolean,
): ProjectFileMutationReceipt | undefined {
  if (!existsSync(path)) return;
  assertRegularProjectFile(path);
  const content = readFileSync(path, "utf8");
  const tree = parseJSONTreeStrict(path, content);
  const section = propertyValueNode(tree, topLevelKey);
  if (!section) return;
  if (section.type !== "object") {
    throw new Error(`JSON property "${topLevelKey}" is not an object; refusing to modify ${path}`);
  }
  const currentNode = propertyValueNode(section, "dosu");
  if (!currentNode) return;
  if (!isOwned(getNodeValue(currentNode))) {
    throw new Error(`Found a non-Dosu server named "dosu" in ${path}; refusing to remove it`);
  }
  const next = removeJsonObjectPropertyRaw(content, section, "dosu");
  if (next === null) {
    throw new Error(`Could not safely remove "dosu" from ${path}; refusing to modify it`);
  }
  return writeProjectFile(path, next, content);
}

/**
 * Writes the dosu MCP server entry into a JSON config file.
 */
export function installJSONServer(configPath: string, topKey: string, server: JsonConfig): void {
  const jsonCfg = loadJSONConfig(configPath);
  let section = jsonCfg[topKey];
  if (typeof section !== "object" || section === null) {
    section = {};
  }
  section.dosu = server;
  jsonCfg[topKey] = section;
  saveJSONConfig(configPath, jsonCfg);
}

/**
 * Removes the dosu entry from a JSON config file.
 */
export function removeJSONServer(configPath: string, topKey: string): void {
  let jsonCfg: JsonConfig;
  try {
    jsonCfg = loadJSONConfig(configPath);
  } catch {
    return; // file doesn't exist or can't be read = nothing to remove
  }
  const section = jsonCfg[topKey];
  if (typeof section === "object" && section !== null) {
    delete section.dosu;
  }
  saveJSONConfig(configPath, jsonCfg);
}
