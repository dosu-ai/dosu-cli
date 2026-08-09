import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { getConfigDir } from "../config/config";
import {
  acquireTargetOperationLock,
  releaseTargetOperationLock,
  type TargetOperationLock,
} from "./orchestrator";

const VERSION = 1;
const DIRECTORY_NAME = "global-mcp-intent-v1";

export interface GlobalMcpIntentInput {
  provider: string;
  targetPath: string;
  /** Test override. Production intent lives under Dosu's private config directory. */
  intentRoot?: string;
}

export interface PendingGlobalMcpIntent {
  provider: string;
  targetPath: string;
  intentRoot: string;
  markerPath: string;
  nonce: string;
  operationLock: TargetOperationLock;
}

export type GlobalMcpIntentInspection =
  | { status: "absent" }
  | {
      status: "preserve";
      reason:
        | "explicit_global_intent"
        | "global_intent_pending"
        | "global_intent_invalid"
        | "global_intent_unsafe"
        | "global_intent_content_changed";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function duplicateJsonKey(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const key = keyNode ? getNodeValue(keyNode) : undefined;
      if (typeof key !== "string") continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(duplicateJsonKey);
}

function parseStrictObject(content: string): Record<string, unknown> | null {
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, { allowTrailingComma: false, disallowComments: true });
  if (root?.type !== "object" || errors.length > 0 || duplicateJsonKey(root)) return null;
  const value: unknown = getNodeValue(root);
  return isRecord(value) ? value : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalInput(input: GlobalMcpIntentInput): {
  provider: string;
  targetPath: string;
  intentRoot: string;
} {
  if (!/^[a-z0-9-]+$/.test(input.provider)) throw new Error("Invalid global MCP provider ID");
  if (!isAbsolute(input.targetPath)) throw new Error("Global MCP target path must be absolute");
  const intentRoot = input.intentRoot ?? join(getConfigDir(), "migrations", DIRECTORY_NAME);
  if (!isAbsolute(intentRoot)) throw new Error("Global MCP intent root must be absolute");
  return {
    provider: input.provider,
    targetPath: resolve(input.targetPath),
    intentRoot: resolve(intentRoot),
  };
}

export function globalMcpIntentMarkerPath(input: GlobalMcpIntentInput): string {
  const canonical = canonicalInput(input);
  const pathHash = targetPathHash(canonical.targetPath);
  return join(canonical.intentRoot, `${canonical.provider}-${pathHash}.json`);
}

function targetPathHash(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 24);
}

function contentHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fsyncParent(path: string): void {
  try {
    const fd = openSync(dirname(path), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some supported platforms do not expose directory fsync.
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.candidate-${process.pid}-${randomBytes(6).toString("hex")}`;
  let exists = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    exists = true;
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncParent(path);
    exists = false;
  } finally {
    if (exists) {
      try {
        unlinkSync(temporary);
      } catch {
        // A never-published candidate is not authoritative.
      }
    }
  }
}

function prepareRoot(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Unsafe global MCP intent root");
    }
  } catch (error: unknown) {
    const code = isRecord(error) && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Unsafe global MCP intent root");
  }
  chmodSync(path, 0o700);
}

function assertReplaceableMarker(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Unsafe global MCP intent marker");
    }
  } catch (error: unknown) {
    const code = isRecord(error) && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

/** Persist a fail-closed pending marker before any global provider file is changed. */
export function prepareGlobalMcpIntent(input: GlobalMcpIntentInput): PendingGlobalMcpIntent {
  const canonical = canonicalInput(input);
  prepareRoot(canonical.intentRoot);
  mkdirSync(dirname(canonical.targetPath), { recursive: true, mode: 0o700 });
  const targetParent = lstatSync(dirname(canonical.targetPath));
  if (!targetParent.isDirectory() || targetParent.isSymbolicLink()) {
    throw new Error("Unsafe global MCP target directory");
  }
  const operationLock = acquireTargetOperationLock(canonical.targetPath, canonical.intentRoot);
  try {
    const markerPath = globalMcpIntentMarkerPath(canonical);
    assertReplaceableMarker(markerPath);
    const nonce = randomBytes(16).toString("hex");
    atomicWrite(
      markerPath,
      `${JSON.stringify({
        version: VERSION,
        state: "pending",
        provider: canonical.provider,
        targetPath: canonical.targetPath,
        nonce,
      })}\n`,
    );
    return { ...canonical, markerPath, nonce, operationLock };
  } catch (error) {
    releaseTargetOperationLock(operationLock);
    throw error;
  }
}

/** Bind the marker to the exact complete config contents produced by install. */
export function finalizeGlobalMcpIntent(pending: PendingGlobalMcpIntent): void {
  try {
    const markerStat = lstatSync(pending.markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error("Global MCP intent marker is not a regular file");
    }
    const marker = parseStrictObject(readFileSync(pending.markerPath, "utf8"));
    if (
      !marker ||
      !exactKeys(marker, ["version", "state", "provider", "targetPath", "nonce"]) ||
      marker.version !== VERSION ||
      marker.state !== "pending" ||
      marker.provider !== pending.provider ||
      marker.targetPath !== pending.targetPath ||
      marker.nonce !== pending.nonce
    ) {
      throw new Error("Global MCP intent marker changed during install");
    }
    const targetStat = lstatSync(pending.targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("Global MCP install target is not a regular file");
    }
    const installedHash = contentHash(pending.targetPath);
    atomicWrite(
      pending.markerPath,
      `${JSON.stringify({
        version: VERSION,
        state: "installed",
        provider: pending.provider,
        targetPath: pending.targetPath,
        contentHash: installedHash,
      })}\n`,
    );
  } finally {
    releaseTargetOperationLock(pending.operationLock);
  }
}

/** Keep the pending marker as fail-closed evidence, but release the operation lock after failure. */
export function releaseGlobalMcpIntent(pending: PendingGlobalMcpIntent): void {
  releaseTargetOperationLock(pending.operationLock);
}

/** Read-only migration guard. Every non-absent unknown state preserves config. */
export function inspectGlobalMcpIntent(input: GlobalMcpIntentInput): GlobalMcpIntentInspection {
  let canonical: ReturnType<typeof canonicalInput>;
  try {
    canonical = canonicalInput(input);
  } catch {
    return { status: "preserve", reason: "global_intent_unsafe" };
  }

  try {
    const rootStat = lstatSync(canonical.intentRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { status: "preserve", reason: "global_intent_unsafe" };
    }
  } catch (error: unknown) {
    const code = isRecord(error) && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { status: "absent" }
      : { status: "preserve", reason: "global_intent_unsafe" };
  }

  const exactMarkerPath = globalMcpIntentMarkerPath(canonical);
  let candidatePaths: string[];
  try {
    const hash = targetPathHash(canonical.targetPath);
    const pattern = new RegExp(`^.+-${hash}\\.json$`);
    candidatePaths = readdirSync(canonical.intentRoot)
      .filter((name) => pattern.test(name))
      .map((name) => join(canonical.intentRoot, name))
      .sort((left, right) => {
        if (left === exactMarkerPath) return -1;
        if (right === exactMarkerPath) return 1;
        return left.localeCompare(right);
      });
  } catch {
    return { status: "preserve", reason: "global_intent_unsafe" };
  }
  if (candidatePaths.length === 0) return { status: "absent" };
  const markerPath = candidatePaths[0];
  let markerContent: string;
  try {
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return { status: "preserve", reason: "global_intent_unsafe" };
    }
    markerContent = readFileSync(markerPath, "utf8");
  } catch {
    return { status: "preserve", reason: "global_intent_unsafe" };
  }

  const marker = parseStrictObject(markerContent);
  if (!marker) return { status: "preserve", reason: "global_intent_invalid" };
  if (
    exactKeys(marker, ["version", "state", "provider", "targetPath", "nonce"]) &&
    marker.version === VERSION &&
    marker.state === "pending" &&
    typeof marker.provider === "string" &&
    /^[a-z0-9-]+$/.test(marker.provider) &&
    marker.targetPath === canonical.targetPath &&
    typeof marker.nonce === "string" &&
    /^[a-f0-9]{32}$/.test(marker.nonce) &&
    markerPath ===
      globalMcpIntentMarkerPath({
        provider: marker.provider,
        targetPath: canonical.targetPath,
        intentRoot: canonical.intentRoot,
      })
  ) {
    return { status: "preserve", reason: "global_intent_pending" };
  }
  if (
    !exactKeys(marker, ["version", "state", "provider", "targetPath", "contentHash"]) ||
    marker.version !== VERSION ||
    marker.state !== "installed" ||
    typeof marker.provider !== "string" ||
    !/^[a-z0-9-]+$/.test(marker.provider) ||
    marker.targetPath !== canonical.targetPath ||
    typeof marker.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.contentHash) ||
    markerPath !==
      globalMcpIntentMarkerPath({
        provider: marker.provider,
        targetPath: canonical.targetPath,
        intentRoot: canonical.intentRoot,
      })
  ) {
    return { status: "preserve", reason: "global_intent_invalid" };
  }

  try {
    const targetStat = lstatSync(canonical.targetPath);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      return { status: "preserve", reason: "global_intent_content_changed" };
    }
    return contentHash(canonical.targetPath) === marker.contentHash
      ? { status: "preserve", reason: "explicit_global_intent" }
      : { status: "preserve", reason: "global_intent_content_changed" };
  } catch {
    return { status: "preserve", reason: "global_intent_content_changed" };
  }
}
