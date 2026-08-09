import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  type ContentPlan,
  hashContent,
  planLegacyCodexMcp,
  planLegacyJsonMcp,
  planLegacyRuleSection,
  planLegacyStandaloneRule,
} from "./planners";
import {
  assertProjectBundleProof,
  type ProjectBundleProof,
  projectBundleStatus,
} from "./project-bundle";
import type { LegacyTarget } from "./targets";

export type MigrationOutcome =
  | "pending"
  | "removed"
  | "not_found"
  | "preserved_ambiguous"
  | "concurrent_conflict"
  | "failed";

export interface MigrationReceipt {
  targetId: string;
  provider: LegacyTarget["provider"];
  path: string;
  outcome: MigrationOutcome;
  reason: string;
  beforeHash?: string;
  afterHash?: string;
  backupPath?: string;
  receiptPath?: string;
  targetPathHash?: string;
  plannedMutation?: ContentPlan["mutation"];
  plannedAfterHash?: string;
  capturePath?: string;
  sourceDev?: number;
  sourceIno?: number;
}

export type LegacyTargetInspection =
  | { disposition: "remove"; reason: string }
  | { disposition: "not_found"; reason: string }
  | { disposition: "ambiguous"; reason: string };

function pathHash(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 12);
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

function baseReceipt(
  target: LegacyTarget,
  outcome: MigrationOutcome,
  reason: string,
): MigrationReceipt {
  return { targetId: target.id, provider: target.provider, path: target.path, outcome, reason };
}

function planForTarget(target: LegacyTarget, content: string): ContentPlan {
  switch (target.kind) {
    case "json_mcp":
      return planLegacyJsonMcp({
        content,
        provider: target.provider,
        topKey: target.topKey,
      });
    case "codex_toml":
      return planLegacyCodexMcp(content);
    case "rule_file":
      return planLegacyStandaloneRule(content, target.ruleKind);
    case "rule_section":
      return planLegacyRuleSection(content);
  }
}

/** Strict read-only ownership inspection; it never creates receipts, locks, or backups. */
export function inspectLegacyTarget(target: LegacyTarget): LegacyTargetInspection {
  try {
    const stat = lstatSync(target.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { disposition: "ambiguous", reason: "non_regular_target" };
    }
    const plan = planForTarget(target, readFileSync(target.path, "utf8"));
    if (plan.disposition === "remove") {
      return { disposition: "remove", reason: plan.reason };
    }
    if (plan.disposition === "not_found") {
      return { disposition: "not_found", reason: plan.reason };
    }
    return { disposition: "ambiguous", reason: plan.reason };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { disposition: "not_found", reason: "target_absent" }
      : { disposition: "ambiguous", reason: "target_read_failed" };
  }
}

/** Read-only strict inspection used to decide whether runtime verification is necessary. */
export function legacyTargetsNeedCleanup(targets: readonly LegacyTarget[]): boolean {
  const seenPaths = new Set<string>();
  for (const target of targets) {
    const key = resolve(target.path);
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    if (inspectLegacyTarget(target).disposition === "remove") return true;
  }
  return false;
}

function prepareBackupRoot(backupRoot: string): void {
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const stat = lstatSync(backupRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Unsafe migration backup root");
  }
  chmodSync(backupRoot, 0o700);
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncParent(path: string): void {
  try {
    fsyncPath(dirname(path));
  } catch {
    // Directory fsync is unavailable on some supported platforms.
  }
}

function atomicWrite(path: string, content: string, mode: number): void {
  const temporary = `${path}.dosu-migration-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let created = false;
  try {
    const file = openSync(temporary, "wx", mode);
    created = true;
    try {
      writeFileSync(file, content, "utf8");
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    chmodSync(path, mode);
    fsyncParent(path);
    created = false;
  } finally {
    if (created) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best effort cleanup of a never-published temporary file.
      }
    }
  }
}

function writePersistedReceipt(path: string, receipt: MigrationReceipt): void {
  atomicWrite(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
}

function backupPathFor(target: LegacyTarget, expectedHash: string, backupRoot: string): string {
  return join(
    backupRoot,
    `${safeId(target.id)}-${pathHash(target.path)}-${expectedHash.slice(0, 12)}.bak`,
  );
}

function receiptPathFor(target: LegacyTarget, backupRoot: string): string {
  return join(backupRoot, `target-${pathHash(target.path)}.receipt.json`);
}

type BackupCopy = (source: string, destination: string, mode: number) => void;

export function ensureBackup(
  targetPath: string,
  backupPath: string,
  expectedHash: string,
  copy: BackupCopy = copyFileSync,
): void {
  if (existsSync(backupPath)) {
    secureBackup(backupPath, expectedHash, "Existing");
    return;
  }
  let created = false;
  try {
    copy(targetPath, backupPath, constants.COPYFILE_EXCL);
    created = true;
    secureBackup(backupPath, expectedHash, "New");
  } catch (error) {
    if (created) {
      try {
        unlinkSync(backupPath);
      } catch {
        // A corrupt backup is never trusted; a failed cleanup still aborts mutation.
      }
    }
    throw error;
  }
}

function secureBackup(path: string, expectedHash: string, label = "Migration"): void {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} migration backup is not a regular file`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} migration backup changed while it was verified`);
    }
    if (hashContent(readFileSync(fd, "utf8")) !== expectedHash) {
      throw new Error(`${label} migration backup does not match the planned content`);
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error(`${label} migration backup changed while it was verified`);
    }
  } finally {
    closeSync(fd);
  }
}

const STALE_LOCK_MINIMUM_AGE_MS = 5 * 60 * 1000;

type MigrationLockResult =
  | { ok: true; content: string; dev: number; ino: number }
  | { ok: false; reason: "target_locked" | "invalid_target_lock" };

interface MigrationTestHooks {
  afterStagePrepared?: (stage: { capturePath: string; nextPath?: string }) => void;
  beforeCapture?: (target: LegacyTarget) => void;
  afterCapture?: (stage: { capturePath: string; nextPath?: string }) => void;
  afterPublish?: (stage: { capturePath: string; nextPath?: string }) => void;
  beforeLockCapture?: (kind: "stale" | "release", path: string) => void;
  afterLockAcquired?: () => void;
  afterBackupCreated?: () => void;
  beforeFinalBundleCheck?: () => void;
  beforeFinalSourceCheck?: () => void;
  beforeFinalMutationAuthorization?: () => void;
}

type FinalMutationAuthorization = (target: LegacyTarget) => string | null;

function mutationAuthorizationFailure(
  authorize: FinalMutationAuthorization | undefined,
  target: LegacyTarget,
): string | null {
  try {
    return authorize?.(target) ?? null;
  } catch {
    return "mutation_authorization_failed";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function migrationLockContent(targetPath: string, backupRoot: string): string {
  return `${JSON.stringify({
    version: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    targetPath: resolve(targetPath),
    backupRoot: resolve(backupRoot),
    nonce: randomBytes(16).toString("hex"),
  })}\n`;
}

function publishMigrationLock(path: string, content: string): { dev: number; ino: number } {
  const candidate = `${path}.candidate-${process.pid}-${randomBytes(6).toString("hex")}`;
  let candidateExists = false;
  try {
    const fd = openSync(candidate, "wx", 0o600);
    candidateExists = true;
    let identity: { dev: number; ino: number };
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      const stat = fstatSync(fd);
      identity = { dev: stat.dev, ino: stat.ino };
    } finally {
      closeSync(fd);
    }
    // Publishing a fully-written inode avoids crash-created empty lock files.
    linkSync(candidate, path);
    fsyncParent(path);
    return identity;
  } finally {
    if (candidateExists) {
      try {
        unlinkSync(candidate);
      } catch {
        // The fixed path, when present, is the only authoritative lock.
      }
    }
  }
}

function processIsDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error: unknown) {
    return isRecord(error) && error.code === "ESRCH";
  }
}

function recognizedLock(
  parsed: unknown,
  targetPath: string,
  backupRoot: string,
): parsed is Record<string, unknown> {
  return (
    isRecord(parsed) &&
    exactKeys(parsed, ["version", "pid", "createdAt", "targetPath", "backupRoot", "nonce"]) &&
    parsed.version === 1 &&
    typeof parsed.pid === "number" &&
    Number.isSafeInteger(parsed.pid) &&
    parsed.pid > 0 &&
    validIsoTimestamp(parsed.createdAt) &&
    parsed.targetPath === resolve(targetPath) &&
    parsed.backupRoot === resolve(backupRoot) &&
    typeof parsed.nonce === "string" &&
    /^[a-f0-9]{32}$/.test(parsed.nonce)
  );
}

function staleMigrationLockContent(
  path: string,
  targetPath: string,
  backupRoot: string,
): { content: string; dev: number; ino: number } | null {
  try {
    const snapshot = readStableRegularFile(path);
    if (!snapshot.ok) return null;
    const content = snapshot.file.content;
    const parsed: unknown = JSON.parse(content);
    if (
      !recognizedLock(parsed, targetPath, backupRoot) ||
      Date.now() - new Date(parsed.createdAt as string).getTime() < STALE_LOCK_MINIMUM_AGE_MS ||
      !processIsDefinitelyGone(parsed.pid as number)
    ) {
      return null;
    }
    return { content, dev: snapshot.file.dev, ino: snapshot.file.ino };
  } catch {
    return null;
  }
}

function acquireMigrationLock(
  path: string,
  targetPath: string,
  backupRoot: string,
  testHooks?: MigrationTestHooks,
): MigrationLockResult {
  if (!recoverPublicCaptures(path)) {
    return { ok: false, reason: "invalid_target_lock" };
  }
  const content = migrationLockContent(targetPath, backupRoot);
  try {
    const identity = publishMigrationLock(path, content);
    return { ok: true, content, ...identity };
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "EEXIST") {
      return { ok: false, reason: "invalid_target_lock" };
    }
  }

  const stale = staleMigrationLockContent(path, targetPath, backupRoot);
  if (!stale) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, reason: "invalid_target_lock" };
      }
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      return {
        ok: false,
        reason: recognizedLock(parsed, targetPath, backupRoot)
          ? "target_locked"
          : "invalid_target_lock",
      };
    } catch {
      return { ok: false, reason: "invalid_target_lock" };
    }
  }

  try {
    if (
      !atomicCaptureAndRemovePublicFile(
        path,
        stale.content,
        { dev: stale.dev, ino: stale.ino },
        () => testHooks?.beforeLockCapture?.("stale", path),
      )
    ) {
      return { ok: false, reason: "target_locked" };
    }
    const identity = publishMigrationLock(path, content);
    return { ok: true, content, ...identity };
  } catch {
    return { ok: false, reason: "target_locked" };
  }
}

function releaseMigrationLock(
  path: string,
  expectedContent: string,
  expectedIdentity: { dev: number; ino: number },
  testHooks?: MigrationTestHooks,
): void {
  atomicCaptureAndRemovePublicFile(path, expectedContent, expectedIdentity, () =>
    testHooks?.beforeLockCapture?.("release", path),
  );
}

export interface TargetOperationLock {
  path: string;
  content: string;
  dev: number;
  ino: number;
}

/**
 * Acquire the same atomic exclusion used by migration before another command
 * starts a target-wide operation. Sharing this lock removes authorization
 * TOCTOU windows between explicit global installs and legacy cleanup.
 */
export function acquireTargetOperationLock(
  targetPath: string,
  authorityRoot: string,
): TargetOperationLock {
  const path = `${resolve(targetPath)}.dosu-migration.lock`;
  const acquired = acquireMigrationLock(path, targetPath, authorityRoot);
  if (!acquired.ok) throw new Error(`Global MCP target is locked (${acquired.reason})`);
  return { path, content: acquired.content, dev: acquired.dev, ino: acquired.ino };
}

/** Release only the exact lock inode/content acquired by this operation. */
export function releaseTargetOperationLock(lock: TargetOperationLock): void {
  releaseMigrationLock(lock.path, lock.content, { dev: lock.dev, ino: lock.ino });
}

function bundleFailure(bundle: ProjectBundleProof, target: LegacyTarget): string | null {
  const required = target.requiredProviders ?? [target.provider];
  for (const provider of required) {
    const status = projectBundleStatus(bundle, provider);
    if (status === "changed") return "project_bundle_changed";
    if (status === "unauthorized_provider") {
      return target.requiredProviders
        ? "shared_target_not_fully_authorized"
        : "project_bundle_not_authorized";
    }
  }
  return null;
}

type PriorReceiptRead =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; receipt: MigrationReceipt };

function readPriorReceipt(target: LegacyTarget, receiptPath: string): PriorReceiptRead {
  if (!existsSync(receiptPath)) return { status: "absent" };
  try {
    const stat = lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "invalid" };
    const parsed: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "invalid" };
    }
    const receipt = parsed as Record<string, unknown>;
    if (
      receipt.path !== target.path ||
      receipt.targetPathHash !== pathHash(target.path) ||
      typeof receipt.outcome !== "string" ||
      typeof receipt.reason !== "string"
    ) {
      return { status: "invalid" };
    }
    return { status: "valid", receipt: receipt as unknown as MigrationReceipt };
  } catch {
    return { status: "invalid" };
  }
}

function receiptWithJournalFields(
  target: LegacyTarget,
  outcome: MigrationOutcome,
  reason: string,
  beforeHash: string,
  backupPath: string,
  receiptPath: string,
  afterHash?: string,
  plannedMutation?: ContentPlan["mutation"],
  plannedAfterHash?: string,
  capture?: CaptureAuthority,
): MigrationReceipt {
  return {
    ...baseReceipt(target, outcome, reason),
    beforeHash,
    ...(afterHash ? { afterHash } : {}),
    backupPath,
    receiptPath,
    targetPathHash: pathHash(target.path),
    ...(plannedMutation ? { plannedMutation } : {}),
    ...(plannedAfterHash ? { plannedAfterHash } : {}),
    ...(capture
      ? {
          capturePath: capture.capturePath,
          sourceDev: capture.sourceDev,
          sourceIno: capture.sourceIno,
        }
      : {}),
  };
}

function persistTerminal(
  target: LegacyTarget,
  backupRoot: string,
  outcome: Exclude<MigrationOutcome, "pending">,
  reason: string,
  options: {
    beforeHash?: string;
    afterHash?: string;
    backupPath?: string;
    plannedMutation?: ContentPlan["mutation"];
    plannedAfterHash?: string;
  } = {},
): MigrationReceipt {
  try {
    prepareBackupRoot(backupRoot);
    const receiptPath = receiptPathFor(target, backupRoot);
    const receipt: MigrationReceipt = {
      ...baseReceipt(target, outcome, reason),
      ...(options.beforeHash ? { beforeHash: options.beforeHash } : {}),
      ...(options.afterHash ? { afterHash: options.afterHash } : {}),
      ...(options.backupPath ? { backupPath: options.backupPath } : {}),
      ...(options.plannedMutation ? { plannedMutation: options.plannedMutation } : {}),
      ...(options.plannedAfterHash ? { plannedAfterHash: options.plannedAfterHash } : {}),
      receiptPath,
      targetPathHash: pathHash(target.path),
    };
    writePersistedReceipt(receiptPath, receipt);
    return receipt;
  } catch {
    return baseReceipt(target, "failed", "receipt_write_failed");
  }
}

type TargetState = { kind: "absent" } | { kind: "file"; hash: string } | { kind: "unsafe" };

function targetState(path: string): TargetState {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "unsafe" };
    return { kind: "file", hash: hashContent(readFileSync(path, "utf8")) };
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unsafe" };
  }
}

type PriorReceiptDecision =
  | { action: "continue" }
  | { action: "return"; receipt: MigrationReceipt };

function decidePriorReceipt(target: LegacyTarget, backupRoot: string): PriorReceiptDecision {
  if (!recoverPublicCaptures(`${target.path}.dosu-migration.lock`)) {
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "pending_lock_capture_recovery"),
    };
  }
  const receiptPath = receiptPathFor(target, backupRoot);
  const prior = readPriorReceipt(target, receiptPath);
  if (prior.status === "absent") return { action: "continue" };
  if (prior.status === "invalid") {
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "invalid_migration_receipt"),
    };
  }

  const receipt = prior.receipt;
  const state = targetState(target.path);
  if (receipt.outcome !== "pending") {
    // A terminal pre-mutation failure is not a tombstone when the exact
    // planned preimage is present again. Retrying from that byte-for-byte
    // state is safe; any changed or unknown state remains preserved.
    const retryablePreMutationFailure =
      (receipt.outcome === "failed" || receipt.outcome === "concurrent_conflict") &&
      state.kind === "file" &&
      typeof receipt.beforeHash === "string" &&
      state.hash === receipt.beforeHash;
    if (retryablePreMutationFailure) return { action: "continue" };

    const unchangedAfterWrite =
      receipt.outcome === "removed" &&
      receipt.plannedMutation === "write" &&
      state.kind === "file" &&
      typeof receipt.afterHash === "string" &&
      state.hash === receipt.afterHash;
    const unchangedAfterDelete =
      receipt.outcome === "removed" &&
      receipt.plannedMutation === "delete" &&
      state.kind === "absent";
    const stillAbsent = receipt.outcome === "not_found" && state.kind === "absent";
    if (unchangedAfterWrite || unchangedAfterDelete || stillAbsent) {
      return {
        action: "return",
        receipt: baseReceipt(target, "not_found", "terminal_receipt_unchanged"),
      };
    }
    if (
      receipt.outcome === "preserved_ambiguous" &&
      state.kind === "file" &&
      receipt.beforeHash === state.hash
    ) {
      return {
        action: "return",
        receipt: baseReceipt(target, "preserved_ambiguous", receipt.reason),
      };
    }
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "already_migrated"),
    };
  }

  if (
    typeof receipt.beforeHash !== "string" ||
    (receipt.plannedMutation !== "write" && receipt.plannedMutation !== "delete") ||
    typeof receipt.backupPath !== "string"
  ) {
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "invalid_pending_receipt"),
    };
  }

  const capturedPendingDecision = decideCapturedPendingReceipt(target, backupRoot, receipt, state);
  if (capturedPendingDecision) return capturedPendingDecision;

  if (state.kind === "file" && state.hash === receipt.beforeHash) {
    return { action: "continue" };
  }

  const reachedAfter =
    (receipt.plannedMutation === "delete" && state.kind === "absent") ||
    (receipt.plannedMutation === "write" &&
      state.kind === "file" &&
      typeof receipt.plannedAfterHash === "string" &&
      state.hash === receipt.plannedAfterHash);
  if (reachedAfter) {
    try {
      const backupStat = lstatSync(receipt.backupPath);
      if (
        !backupStat.isFile() ||
        backupStat.isSymbolicLink() ||
        hashContent(readFileSync(receipt.backupPath, "utf8")) !== receipt.beforeHash
      ) {
        throw new Error("invalid backup");
      }
    } catch {
      return {
        action: "return",
        receipt: persistTerminal(
          target,
          backupRoot,
          "preserved_ambiguous",
          "pending_backup_invalid",
          { beforeHash: receipt.beforeHash },
        ),
      };
    }
    return {
      action: "return",
      receipt: persistTerminal(target, backupRoot, "removed", "recovered_pending_mutation", {
        beforeHash: receipt.beforeHash,
        afterHash: receipt.plannedAfterHash,
        backupPath: receipt.backupPath,
        plannedMutation: receipt.plannedMutation,
        plannedAfterHash: receipt.plannedAfterHash,
      }),
    };
  }

  return {
    action: "return",
    receipt: persistTerminal(
      target,
      backupRoot,
      "preserved_ambiguous",
      "pending_recovery_conflict",
      { beforeHash: receipt.beforeHash, backupPath: receipt.backupPath },
    ),
  };
}

type StableRegularFile = {
  mode: number;
  dev: number;
  ino: number;
  hash: string;
  content: string;
};

type StableRegularFileResult =
  | { ok: true; file: StableRegularFile }
  | { ok: false; reason: "non_regular_target" | "target_changed_or_missing" };

function readStableRegularFile(path: string): StableRegularFileResult {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { ok: false, reason: "non_regular_target" };
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const fd = openSync(path, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return { ok: false, reason: "target_changed_or_missing" };
      }
      const content = readFileSync(fd, "utf8");
      const hash = hashContent(content);
      const after = lstatSync(path);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        return { ok: false, reason: "target_changed_or_missing" };
      }
      return {
        ok: true,
        file: {
          mode: opened.mode & 0o777,
          dev: opened.dev,
          ino: opened.ino,
          hash,
          content,
        },
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, reason: "target_changed_or_missing" };
  }
}

function recheckSource(
  target: LegacyTarget,
  expectedHash: string,
): { ok: true; mode: number; dev: number; ino: number } | { ok: false; reason: string } {
  const snapshot = readStableRegularFile(target.path);
  if (!snapshot.ok) return snapshot;
  if (snapshot.file.hash !== expectedHash) {
    return { ok: false, reason: "content_hash_changed" };
  }
  return {
    ok: true,
    mode: snapshot.file.mode,
    dev: snapshot.file.dev,
    ino: snapshot.file.ino,
  };
}

interface CaptureAuthority {
  capturePath: string;
  sourceDev: number;
  sourceIno: number;
}

interface CaptureStage extends CaptureAuthority {
  directory: string;
  nextPath?: string;
}

function createCaptureStage(
  targetPath: string,
  source: { mode: number; dev: number; ino: number },
  nextContent?: string,
): CaptureStage {
  const directory = mkdtempSync(join(dirname(resolve(targetPath)), ".dosu-migration-capture-"));
  chmodSync(directory, 0o700);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Unsafe migration capture directory");
  }
  const capturePath = join(directory, "captured");
  let nextPath: string | undefined;
  try {
    if (nextContent !== undefined) {
      nextPath = join(directory, "next");
      const fd = openSync(nextPath, "wx", 0o600);
      try {
        writeFileSync(fd, nextContent, "utf8");
        fchmodSync(fd, source.mode);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    try {
      fsyncPath(directory);
    } catch {
      // Directory fsync is unavailable on some supported platforms.
    }
    return {
      directory,
      capturePath,
      sourceDev: source.dev,
      sourceIno: source.ino,
      ...(nextPath ? { nextPath } : {}),
    };
  } catch (error) {
    if (nextPath) {
      try {
        unlinkSync(nextPath);
      } catch {
        // Best effort cleanup before this private stage is journaled.
      }
    }
    try {
      rmdirSync(directory);
    } catch {
      // Best effort cleanup before this private stage is journaled.
    }
    throw error;
  }
}

function captureDirectoryFor(targetPath: string, capturePath: string): string | null {
  const resolvedCapture = resolve(capturePath);
  const directory = dirname(resolvedCapture);
  if (
    basename(resolvedCapture) !== "captured" ||
    dirname(directory) !== dirname(resolve(targetPath)) ||
    !basename(directory).startsWith(".dosu-migration-capture-")
  ) {
    return null;
  }
  return directory;
}

// This helper is deliberately restricted to files inside a random 0700
// capture directory. Public target and lock paths are always renamed into a
// private capture first and are never passed here directly.
function removeExactPrivateStageFile(
  path: string,
  expectedHash: string,
  expectedIdentity?: { dev: number; ino: number },
): boolean {
  try {
    const snapshot = readStableRegularFile(path);
    if (
      !snapshot.ok ||
      snapshot.file.hash !== expectedHash ||
      (expectedIdentity !== undefined &&
        (snapshot.file.dev !== expectedIdentity.dev || snapshot.file.ino !== expectedIdentity.ino))
    ) {
      return false;
    }
    unlinkSync(path);
    fsyncParent(path);
    return true;
  } catch {
    return false;
  }
}

function pathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error: unknown) {
    return isRecord(error) && error.code === "ENOENT";
  }
}

function removeStageDirectoryIfEmpty(targetPath: string, capturePath: string): boolean {
  const directory = captureDirectoryFor(targetPath, capturePath);
  if (!directory) return false;
  if (pathIsAbsent(directory)) return true;
  try {
    rmdirSync(directory);
    fsyncParent(directory);
    return true;
  } catch {
    return false;
  }
}

function cleanupStagedNext(
  targetPath: string,
  capturePath: string,
  plannedAfterHash: string | undefined,
): boolean {
  const directory = captureDirectoryFor(targetPath, capturePath);
  if (!directory) return false;
  const nextPath = join(directory, "next");
  if (pathIsAbsent(nextPath)) return true;
  return plannedAfterHash !== undefined && removeExactPrivateStageFile(nextPath, plannedAfterHash);
}

function exactCapturedSource(capture: CaptureAuthority, expectedHash: string): boolean {
  const snapshot = readStableRegularFile(capture.capturePath);
  return (
    snapshot.ok &&
    snapshot.file.hash === expectedHash &&
    snapshot.file.dev === capture.sourceDev &&
    snapshot.file.ino === capture.sourceIno
  );
}

function cleanupVerifiedCapture(
  targetPath: string,
  capture: CaptureAuthority,
  expectedHash: string,
  plannedAfterHash: string | undefined,
): boolean {
  if (
    !cleanupStagedNext(targetPath, capture.capturePath, plannedAfterHash) ||
    !removeExactPrivateStageFile(capture.capturePath, expectedHash, {
      dev: capture.sourceDev,
      ino: capture.sourceIno,
    })
  ) {
    return false;
  }
  return removeStageDirectoryIfEmpty(targetPath, capture.capturePath);
}

function restoreCapturedReplacement(
  targetPath: string,
  capturePath: string,
  plannedAfterHash: string | undefined,
): boolean {
  try {
    const capturedStat = lstatSync(capturePath);
    if (capturedStat.isSymbolicLink()) {
      const linkTarget = readlinkSync(capturePath);
      // symlinkSync is no-clobber: a concurrently recreated public path makes
      // restoration fail and leaves the private capture untouched.
      symlinkSync(linkTarget, targetPath);
      fsyncParent(targetPath);
      const restored = lstatSync(targetPath);
      if (!restored.isSymbolicLink() || readlinkSync(targetPath) !== linkTarget) return false;
      unlinkSync(capturePath);
      fsyncParent(capturePath);
      cleanupStagedNext(targetPath, capturePath, plannedAfterHash);
      removeStageDirectoryIfEmpty(targetPath, capturePath);
      return true;
    }
  } catch {
    return false;
  }

  const captured = readStableRegularFile(capturePath);
  if (!captured.ok) return false;
  try {
    linkSync(capturePath, targetPath);
    fsyncParent(targetPath);
  } catch {
    return false;
  }

  const restored = readStableRegularFile(targetPath);
  if (
    !restored.ok ||
    restored.file.dev !== captured.file.dev ||
    restored.file.ino !== captured.file.ino ||
    restored.file.hash !== captured.file.hash
  ) {
    return false;
  }

  // The user object is now back at its original path. Only unlink the private
  // duplicate after proving it is still the same inode we restored.
  if (
    !removeExactPrivateStageFile(capturePath, captured.file.hash, {
      dev: captured.file.dev,
      ino: captured.file.ino,
    })
  ) {
    return true;
  }
  cleanupStagedNext(targetPath, capturePath, plannedAfterHash);
  removeStageDirectoryIfEmpty(targetPath, capturePath);
  return true;
}

type CapturedPublicNode =
  | { kind: "regular"; dev: number; ino: number; hash: string }
  | { kind: "symlink"; dev: number; ino: number; linkTarget: string }
  | { kind: "directory"; dev: number; ino: number };

type PublicCaptureJournal = {
  version: 1;
  state: "prepared" | "captured";
  publicPath: string;
  capturePath: string;
  expectedHash: string;
  expectedDev: number;
  expectedIno: number;
  captured?: CapturedPublicNode;
};

interface PublicCaptureStage {
  directory: string;
  capturePath: string;
  journalPath: string;
  journalContent: string;
  journal: PublicCaptureJournal;
}

function publicCapturePrefix(publicPath: string): string {
  return `.dosu-public-capture-${pathHash(publicPath)}-`;
}

function capturedPublicNode(path: string): CapturedPublicNode | null {
  try {
    const before = lstatSync(path);
    if (before.isFile() && !before.isSymbolicLink()) {
      const snapshot = readStableRegularFile(path);
      return snapshot.ok
        ? {
            kind: "regular",
            dev: snapshot.file.dev,
            ino: snapshot.file.ino,
            hash: snapshot.file.hash,
          }
        : null;
    }
    if (before.isSymbolicLink()) {
      const linkTarget = readlinkSync(path);
      const after = lstatSync(path);
      return after.isSymbolicLink() && after.dev === before.dev && after.ino === before.ino
        ? { kind: "symlink", dev: before.dev, ino: before.ino, linkTarget }
        : null;
    }
    if (before.isDirectory()) {
      const after = lstatSync(path);
      return after.isDirectory() &&
        !after.isSymbolicLink() &&
        after.dev === before.dev &&
        after.ino === before.ino
        ? { kind: "directory", dev: before.dev, ino: before.ino }
        : null;
    }
    return null;
  } catch {
    return null;
  }
}

function sameCapturedPublicNode(left: CapturedPublicNode, right: CapturedPublicNode): boolean {
  if (left.kind !== right.kind || left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.kind === "regular" && right.kind === "regular") return left.hash === right.hash;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.linkTarget === right.linkTarget;
  }
  return left.kind === "directory" && right.kind === "directory";
}

function serializePublicCaptureJournal(journal: PublicCaptureJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

function writePublicCaptureJournal(
  stage: PublicCaptureStage,
  journal: PublicCaptureJournal,
): PublicCaptureStage {
  const content = serializePublicCaptureJournal(journal);
  atomicWrite(stage.journalPath, content, 0o600);
  return { ...stage, journal, journalContent: content };
}

function createPublicCaptureStage(
  publicPath: string,
  source: StableRegularFile,
): PublicCaptureStage {
  const canonicalPath = resolve(publicPath);
  const directory = mkdtempSync(join(dirname(canonicalPath), publicCapturePrefix(canonicalPath)));
  chmodSync(directory, 0o700);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Unsafe public capture directory");
  }
  const stage: PublicCaptureStage = {
    directory,
    capturePath: join(directory, "captured"),
    journalPath: join(directory, "journal.json"),
    journalContent: "",
    journal: {
      version: 1,
      state: "prepared",
      publicPath: canonicalPath,
      capturePath: join(directory, "captured"),
      expectedHash: source.hash,
      expectedDev: source.dev,
      expectedIno: source.ino,
    },
  };
  try {
    return writePublicCaptureJournal(stage, stage.journal);
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch {
      // A failed journal publication leaves no authority to mutate publicPath.
    }
    throw error;
  }
}

function validPublicCaptureJournal(
  value: unknown,
  publicPath: string,
  directory: string,
): value is PublicCaptureJournal {
  if (!isRecord(value)) return false;
  const preparedKeys = [
    "version",
    "state",
    "publicPath",
    "capturePath",
    "expectedHash",
    "expectedDev",
    "expectedIno",
  ];
  const capturedKeys = [...preparedKeys, "captured"];
  if (!exactKeys(value, value.state === "captured" ? capturedKeys : preparedKeys)) return false;
  if (
    value.version !== 1 ||
    (value.state !== "prepared" && value.state !== "captured") ||
    value.publicPath !== resolve(publicPath) ||
    value.capturePath !== join(directory, "captured") ||
    typeof value.expectedHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.expectedHash) ||
    typeof value.expectedDev !== "number" ||
    !Number.isSafeInteger(value.expectedDev) ||
    value.expectedDev < 0 ||
    typeof value.expectedIno !== "number" ||
    !Number.isSafeInteger(value.expectedIno) ||
    value.expectedIno < 0
  ) {
    return false;
  }
  if (value.state === "prepared") return true;
  if (!isRecord(value.captured)) return false;
  const captured = value.captured;
  const commonValid =
    typeof captured.kind === "string" &&
    typeof captured.dev === "number" &&
    Number.isSafeInteger(captured.dev) &&
    captured.dev >= 0 &&
    typeof captured.ino === "number" &&
    Number.isSafeInteger(captured.ino) &&
    captured.ino >= 0;
  if (!commonValid) return false;
  if (captured.kind === "regular") {
    return (
      exactKeys(captured, ["kind", "dev", "ino", "hash"]) &&
      typeof captured.hash === "string" &&
      /^[a-f0-9]{64}$/.test(captured.hash)
    );
  }
  if (captured.kind === "symlink") {
    return (
      exactKeys(captured, ["kind", "dev", "ino", "linkTarget"]) &&
      typeof captured.linkTarget === "string"
    );
  }
  return captured.kind === "directory" && exactKeys(captured, ["kind", "dev", "ino"]);
}

function readPublicCaptureStage(publicPath: string, directory: string): PublicCaptureStage | null {
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const journalPath = join(directory, "journal.json");
    const snapshot = readStableRegularFile(journalPath);
    if (!snapshot.ok) return null;
    const parsed: unknown = JSON.parse(snapshot.file.content);
    if (!validPublicCaptureJournal(parsed, publicPath, directory)) return null;
    return {
      directory,
      capturePath: join(directory, "captured"),
      journalPath,
      journalContent: snapshot.file.content,
      journal: parsed,
    };
  } catch {
    return null;
  }
}

function removeExactPublicCaptureJournal(stage: PublicCaptureStage): boolean {
  const snapshot = readStableRegularFile(stage.journalPath);
  if (!snapshot.ok || snapshot.file.content !== stage.journalContent) return false;
  try {
    unlinkSync(stage.journalPath);
    fsyncParent(stage.journalPath);
    return true;
  } catch {
    return false;
  }
}

function finishPublicCaptureStage(stage: PublicCaptureStage): boolean {
  if (!pathIsAbsent(stage.capturePath)) return false;
  if (!removeExactPublicCaptureJournal(stage)) return false;
  try {
    rmdirSync(stage.directory);
    fsyncParent(stage.directory);
    return true;
  } catch {
    return false;
  }
}

function removeExactCapturedPublicNode(
  stage: PublicCaptureStage,
  expected: CapturedPublicNode,
): boolean {
  const current = capturedPublicNode(stage.capturePath);
  if (!current || !sameCapturedPublicNode(current, expected)) return false;
  if (current.kind === "directory") return false;
  try {
    unlinkSync(stage.capturePath);
    fsyncParent(stage.capturePath);
    return true;
  } catch {
    return false;
  }
}

function restoreCapturedPublicNode(
  stage: PublicCaptureStage,
  captured: CapturedPublicNode,
): boolean {
  if (captured.kind === "directory" || !pathIsAbsent(stage.journal.publicPath)) return false;
  try {
    if (captured.kind === "regular") {
      linkSync(stage.capturePath, stage.journal.publicPath);
      fsyncParent(stage.journal.publicPath);
      const restored = capturedPublicNode(stage.journal.publicPath);
      if (!restored || !sameCapturedPublicNode(restored, captured)) return false;
    } else {
      symlinkSync(captured.linkTarget, stage.journal.publicPath);
      fsyncParent(stage.journal.publicPath);
      const restored = capturedPublicNode(stage.journal.publicPath);
      if (restored?.kind !== "symlink" || restored.linkTarget !== captured.linkTarget) {
        return false;
      }
    }
    return removeExactCapturedPublicNode(stage, captured);
  } catch {
    return false;
  }
}

function recoverPublicCaptureStage(stage: PublicCaptureStage): boolean {
  const captured = capturedPublicNode(stage.capturePath);
  if (!captured) {
    return pathIsAbsent(stage.capturePath) && finishPublicCaptureStage(stage);
  }

  const expected: CapturedPublicNode = {
    kind: "regular",
    dev: stage.journal.expectedDev,
    ino: stage.journal.expectedIno,
    hash: stage.journal.expectedHash,
  };
  if (sameCapturedPublicNode(captured, expected)) {
    return removeExactCapturedPublicNode(stage, expected) && finishPublicCaptureStage(stage);
  }

  if (
    stage.journal.state !== "captured" ||
    !stage.journal.captured ||
    !sameCapturedPublicNode(captured, stage.journal.captured)
  ) {
    return false;
  }

  if (pathIsAbsent(stage.journal.publicPath)) {
    return restoreCapturedPublicNode(stage, captured) && finishPublicCaptureStage(stage);
  }

  const publicNode = capturedPublicNode(stage.journal.publicPath);
  if (
    captured.kind === "regular" &&
    publicNode?.kind === "regular" &&
    sameCapturedPublicNode(publicNode, captured)
  ) {
    return removeExactCapturedPublicNode(stage, captured) && finishPublicCaptureStage(stage);
  }
  return false;
}

/** Recover or explicitly retain every durable sidecar capture for one lock path. */
function recoverPublicCaptures(publicPath: string): boolean {
  const canonicalPath = resolve(publicPath);
  const prefix = publicCapturePrefix(canonicalPath);
  let names: string[];
  try {
    names = readdirSync(dirname(canonicalPath))
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch (error: unknown) {
    return isRecord(error) && error.code === "ENOENT";
  }
  for (const name of names) {
    const directory = join(dirname(canonicalPath), name);
    const stage = readPublicCaptureStage(canonicalPath, directory);
    if (!stage || !recoverPublicCaptureStage(stage)) return false;
  }
  return true;
}

function atomicCaptureAndRemovePublicFile(
  path: string,
  expectedContent: string,
  expectedIdentity: { dev: number; ino: number },
  beforeCapture?: () => void,
): boolean {
  const snapshot = readStableRegularFile(path);
  if (
    !snapshot.ok ||
    snapshot.file.content !== expectedContent ||
    snapshot.file.dev !== expectedIdentity.dev ||
    snapshot.file.ino !== expectedIdentity.ino
  ) {
    return false;
  }

  let stage: PublicCaptureStage | undefined;
  try {
    stage = createPublicCaptureStage(path, snapshot.file);
    beforeCapture?.();
    renameSync(path, stage.capturePath);
    fsyncParent(path);
    const captured = capturedPublicNode(stage.capturePath);
    if (!captured) return false;
    const expected: CapturedPublicNode = {
      kind: "regular",
      dev: snapshot.file.dev,
      ino: snapshot.file.ino,
      hash: snapshot.file.hash,
    };
    if (!sameCapturedPublicNode(captured, expected)) {
      stage = writePublicCaptureJournal(stage, {
        ...stage.journal,
        state: "captured",
        captured,
      });
      if (
        (captured.kind === "regular" || captured.kind === "symlink") &&
        restoreCapturedPublicNode(stage, captured)
      ) {
        finishPublicCaptureStage(stage);
      }
      return false;
    }
    if (!removeExactCapturedPublicNode(stage, expected)) return false;
    return finishPublicCaptureStage(stage);
  } catch {
    // The prepared/captured journal remains authoritative. The next migration
    // pass either completes a proven cleanup/restoration or reports it.
    return false;
  }
}

function pendingCaptureAuthority(
  target: LegacyTarget,
  receipt: MigrationReceipt,
): CaptureAuthority | "invalid" | null {
  const fields = [receipt.capturePath, receipt.sourceDev, receipt.sourceIno];
  if (fields.every((value) => value === undefined)) return null;
  if (
    typeof receipt.capturePath !== "string" ||
    typeof receipt.sourceDev !== "number" ||
    !Number.isSafeInteger(receipt.sourceDev) ||
    receipt.sourceDev < 0 ||
    typeof receipt.sourceIno !== "number" ||
    !Number.isSafeInteger(receipt.sourceIno) ||
    receipt.sourceIno < 0 ||
    !captureDirectoryFor(target.path, receipt.capturePath)
  ) {
    return "invalid";
  }
  return {
    capturePath: receipt.capturePath,
    sourceDev: receipt.sourceDev,
    sourceIno: receipt.sourceIno,
  };
}

function cleanupPendingStageWithoutCapture(
  targetPath: string,
  capturePath: string,
  plannedAfterHash: string | undefined,
): boolean {
  return (
    cleanupStagedNext(targetPath, capturePath, plannedAfterHash) &&
    removeStageDirectoryIfEmpty(targetPath, capturePath)
  );
}

function pendingBackupIsValid(receipt: MigrationReceipt): boolean {
  if (typeof receipt.backupPath !== "string" || typeof receipt.beforeHash !== "string") {
    return false;
  }
  try {
    secureBackup(receipt.backupPath, receipt.beforeHash);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover journals written by the atomic-capture implementation. `null`
 * delegates to the pre-capture recovery path for old receipts.
 */
function decideCapturedPendingReceipt(
  target: LegacyTarget,
  backupRoot: string,
  receipt: MigrationReceipt,
  state: TargetState,
): PriorReceiptDecision | null {
  const capture = pendingCaptureAuthority(target, receipt);
  if (capture === null) return null;
  if (capture === "invalid") {
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "invalid_pending_receipt"),
    };
  }
  if (typeof receipt.beforeHash !== "string") {
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "invalid_pending_receipt"),
    };
  }

  const captureAbsent = pathIsAbsent(capture.capturePath);
  const captureExact = !captureAbsent && exactCapturedSource(capture, receipt.beforeHash);
  if (!captureAbsent && !captureExact) {
    // Keep the pending journal and unexpected object as recovery evidence.
    return {
      action: "return",
      receipt: baseReceipt(target, "preserved_ambiguous", "pending_capture_invalid"),
    };
  }

  const cleanupCapture = (): boolean =>
    captureExact
      ? cleanupVerifiedCapture(
          target.path,
          capture,
          receipt.beforeHash as string,
          receipt.plannedAfterHash,
        )
      : cleanupPendingStageWithoutCapture(
          target.path,
          capture.capturePath,
          receipt.plannedAfterHash,
        );

  if (state.kind === "file" && state.hash === receipt.beforeHash) {
    if (!cleanupCapture()) {
      return {
        action: "return",
        receipt: baseReceipt(target, "preserved_ambiguous", "pending_capture_cleanup_failed"),
      };
    }
    return { action: "continue" };
  }

  const reachedAfter =
    (receipt.plannedMutation === "delete" && state.kind === "absent") ||
    (receipt.plannedMutation === "write" &&
      state.kind === "file" &&
      typeof receipt.plannedAfterHash === "string" &&
      state.hash === receipt.plannedAfterHash);
  if (reachedAfter) {
    if (!pendingBackupIsValid(receipt)) {
      return {
        action: "return",
        receipt: baseReceipt(target, "preserved_ambiguous", "pending_backup_invalid"),
      };
    }
    if (!cleanupCapture()) {
      return {
        action: "return",
        receipt: baseReceipt(target, "preserved_ambiguous", "pending_capture_cleanup_failed"),
      };
    }
    return {
      action: "return",
      receipt: persistTerminal(target, backupRoot, "removed", "recovered_pending_mutation", {
        beforeHash: receipt.beforeHash,
        afterHash: receipt.plannedAfterHash,
        backupPath: receipt.backupPath,
        plannedMutation: receipt.plannedMutation,
        plannedAfterHash: receipt.plannedAfterHash,
      }),
    };
  }

  if (
    receipt.plannedMutation === "write" &&
    state.kind === "absent" &&
    captureExact &&
    restoreCapturedReplacement(target.path, capture.capturePath, receipt.plannedAfterHash)
  ) {
    return { action: "continue" };
  }

  // Leave both the pending journal and capture untouched when another object
  // now owns the target path or recovery cannot be proven.
  return {
    action: "return",
    receipt: baseReceipt(target, "preserved_ambiguous", "pending_recovery_conflict"),
  };
}

export function applyContentPlan(input: {
  bundle: ProjectBundleProof;
  target: LegacyTarget;
  plan: ContentPlan;
  backupRoot: string;
  allowRemoval: boolean;
  /**
   * Final fail-closed authorization evaluated under the per-target lock both
   * immediately before and immediately after capture. A non-null reason keeps
   * the public target intact (or restores its exact captured preimage).
   */
  finalMutationAuthorization?: FinalMutationAuthorization;
  /** @internal Deterministic fault injection for filesystem race tests only. */
  _testHooks?: MigrationTestHooks;
}): MigrationReceipt {
  assertProjectBundleProof(input.bundle);
  const { target, plan, backupRoot } = input;
  const authorizationFailure = bundleFailure(input.bundle, target);
  if (authorizationFailure) {
    return baseReceipt(target, "preserved_ambiguous", authorizationFailure);
  }
  if (plan.disposition === "remove" && !input.allowRemoval) {
    return baseReceipt(target, "preserved_ambiguous", "runtime_not_verified");
  }
  const priorDecision = decidePriorReceipt(target, backupRoot);
  if (priorDecision.action === "return") return priorDecision.receipt;
  if (plan.disposition === "not_found") {
    return persistTerminal(target, backupRoot, "not_found", plan.reason, {
      beforeHash: plan.expectedHash,
    });
  }
  if (plan.disposition === "preserved_ambiguous") {
    return persistTerminal(target, backupRoot, "preserved_ambiguous", plan.reason, {
      beforeHash: plan.expectedHash,
    });
  }
  if (!plan.mutation || (plan.mutation === "write" && plan.nextContent === undefined)) {
    return persistTerminal(target, backupRoot, "preserved_ambiguous", "invalid_migration_plan", {
      beforeHash: plan.expectedHash,
    });
  }

  // This early guard gives a newly published intent a descriptive preserve
  // result before lock acquisition. The shared target lock and the two final
  // checks below remain the actual race-free mutation authorization.
  const earlyAuthorizationFailure = mutationAuthorizationFailure(
    input.finalMutationAuthorization,
    target,
  );
  if (earlyAuthorizationFailure) {
    return baseReceipt(target, "preserved_ambiguous", earlyAuthorizationFailure);
  }

  const firstCheck = recheckSource(target, plan.expectedHash);
  if (!firstCheck.ok) {
    return persistTerminal(target, backupRoot, "concurrent_conflict", firstCheck.reason, {
      beforeHash: plan.expectedHash,
    });
  }

  const receiptPath = receiptPathFor(target, backupRoot);
  const lockPath = `${target.path}.dosu-migration.lock`;
  const lock = acquireMigrationLock(lockPath, target.path, backupRoot, input._testHooks);
  if (!lock.ok) {
    // Do not overwrite a pending journal: another process (or an untrusted
    // sidecar) may be the only evidence needed for safe crash recovery.
    return baseReceipt(target, "preserved_ambiguous", lock.reason);
  }

  let journalWritten = false;
  let stage: CaptureStage | undefined;
  const plannedAfterHash =
    plan.mutation === "write" ? hashContent(plan.nextContent ?? "") : undefined;
  try {
    input._testHooks?.afterLockAcquired?.();
    const lockedCheck = recheckSource(target, plan.expectedHash);
    if (!lockedCheck.ok) {
      return persistTerminal(target, backupRoot, "concurrent_conflict", lockedCheck.reason, {
        beforeHash: plan.expectedHash,
      });
    }
    prepareBackupRoot(backupRoot);
    const backupPath = backupPathFor(target, plan.expectedHash, backupRoot);
    ensureBackup(target.path, backupPath, plan.expectedHash);

    input._testHooks?.afterBackupCreated?.();
    const afterBackupCheck = recheckSource(target, plan.expectedHash);
    if (!afterBackupCheck.ok) {
      return persistTerminal(target, backupRoot, "concurrent_conflict", afterBackupCheck.reason, {
        beforeHash: plan.expectedHash,
        backupPath,
      });
    }

    input._testHooks?.beforeFinalBundleCheck?.();
    const finalBundleFailure = bundleFailure(input.bundle, target);
    if (finalBundleFailure) {
      const receipt = receiptWithJournalFields(
        target,
        "preserved_ambiguous",
        finalBundleFailure,
        plan.expectedHash,
        backupPath,
        receiptPath,
        undefined,
        plan.mutation,
        plannedAfterHash,
      );
      writePersistedReceipt(receiptPath, receipt);
      return receipt;
    }

    input._testHooks?.beforeFinalSourceCheck?.();
    const finalCheck = recheckSource(target, plan.expectedHash);
    if (!finalCheck.ok) {
      const receipt = receiptWithJournalFields(
        target,
        "concurrent_conflict",
        finalCheck.reason,
        plan.expectedHash,
        backupPath,
        receiptPath,
        undefined,
        plan.mutation,
        plannedAfterHash,
      );
      writePersistedReceipt(receiptPath, receipt);
      return receipt;
    }
    input._testHooks?.beforeFinalMutationAuthorization?.();
    const finalAuthorizationFailure = mutationAuthorizationFailure(
      input.finalMutationAuthorization,
      target,
    );
    if (finalAuthorizationFailure) {
      const receipt = receiptWithJournalFields(
        target,
        "preserved_ambiguous",
        finalAuthorizationFailure,
        plan.expectedHash,
        backupPath,
        receiptPath,
        undefined,
        plan.mutation,
        plannedAfterHash,
      );
      writePersistedReceipt(receiptPath, receipt);
      return receipt;
    }
    // Re-prove the immutable preimage backup before preparing a durable
    // capture journal. A replaced symlink is never trusted.
    secureBackup(backupPath, plan.expectedHash);

    stage = createCaptureStage(
      target.path,
      finalCheck,
      plan.mutation === "write" ? (plan.nextContent ?? "") : undefined,
    );
    input._testHooks?.afterStagePrepared?.(stage);
    const pending = receiptWithJournalFields(
      target,
      "pending",
      "mutation_prepared",
      plan.expectedHash,
      backupPath,
      receiptPath,
      undefined,
      plan.mutation,
      plannedAfterHash,
      stage,
    );
    writePersistedReceipt(receiptPath, pending);
    journalWritten = true;

    input._testHooks?.beforeCapture?.(target);
    renameSync(target.path, stage.capturePath);
    fsyncParent(target.path);
    input._testHooks?.afterCapture?.(stage);

    if (!exactCapturedSource(stage, plan.expectedHash)) {
      const restored = restoreCapturedReplacement(target.path, stage.capturePath, plannedAfterHash);
      if (!restored || !pathIsAbsent(stage.capturePath)) {
        // The durable pending journal is the recovery authority for a captured
        // directory or any object that cannot be restored without clobbering.
        // Never replace it with a terminal tombstone while capturePath exists.
        return baseReceipt(target, "pending", "captured_source_mismatch");
      }
      const receipt = receiptWithJournalFields(
        target,
        "concurrent_conflict",
        "captured_source_mismatch",
        plan.expectedHash,
        backupPath,
        receiptPath,
        undefined,
        plan.mutation,
        plannedAfterHash,
        undefined,
      );
      writePersistedReceipt(receiptPath, receipt);
      return receipt;
    }

    // A concurrent explicit-global install publishes its intent marker before
    // it touches the provider file. Rechecking after capture closes the final
    // authorization-to-rename window. If authorization changed, restore the
    // exact legacy preimage with no-clobber semantics; when another writer has
    // already recreated the target, retain the durable pending journal and
    // capture for the next recovery pass.
    const capturedAuthorizationFailure = mutationAuthorizationFailure(
      input.finalMutationAuthorization,
      target,
    );
    if (capturedAuthorizationFailure) {
      if (
        !restoreCapturedReplacement(target.path, stage.capturePath, plannedAfterHash) ||
        !pathIsAbsent(stage.capturePath)
      ) {
        return baseReceipt(target, "pending", capturedAuthorizationFailure);
      }
      const receipt = receiptWithJournalFields(
        target,
        "preserved_ambiguous",
        capturedAuthorizationFailure,
        plan.expectedHash,
        backupPath,
        receiptPath,
        undefined,
        plan.mutation,
        plannedAfterHash,
      );
      writePersistedReceipt(receiptPath, receipt);
      return receipt;
    }

    if (plan.mutation === "delete") {
      if (!pathIsAbsent(target.path)) {
        if (!cleanupVerifiedCapture(target.path, stage, plan.expectedHash, plannedAfterHash)) {
          throw new Error("Could not safely clean the captured legacy source");
        }
        const receipt = receiptWithJournalFields(
          target,
          "concurrent_conflict",
          "target_recreated_during_migration",
          plan.expectedHash,
          backupPath,
          receiptPath,
          undefined,
          plan.mutation,
          plannedAfterHash,
        );
        writePersistedReceipt(receiptPath, receipt);
        return receipt;
      }
      if (!cleanupVerifiedCapture(target.path, stage, plan.expectedHash, plannedAfterHash)) {
        throw new Error("Could not safely remove the captured legacy source");
      }
    } else {
      if (!stage.nextPath || plannedAfterHash === undefined) {
        throw new Error("Missing staged migration content");
      }
      const stagedWrite = readStableRegularFile(stage.nextPath);
      if (!stagedWrite.ok || stagedWrite.file.hash !== plannedAfterHash) {
        throw new Error("Staged migration content changed");
      }
      try {
        // A hard link is an atomic no-replace publish on the same filesystem.
        // Unlike rename(), it fails when any process has recreated target.path.
        linkSync(stage.nextPath, target.path);
        fsyncParent(target.path);
      } catch (error: unknown) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
        if (!cleanupVerifiedCapture(target.path, stage, plan.expectedHash, plannedAfterHash)) {
          throw new Error("Could not safely clean a conflicted capture");
        }
        const receipt = receiptWithJournalFields(
          target,
          "concurrent_conflict",
          "target_recreated_during_migration",
          plan.expectedHash,
          backupPath,
          receiptPath,
          undefined,
          plan.mutation,
          plannedAfterHash,
        );
        writePersistedReceipt(receiptPath, receipt);
        return receipt;
      }
      input._testHooks?.afterPublish?.(stage);

      const published = readStableRegularFile(target.path);
      if (
        !published.ok ||
        published.file.hash !== plannedAfterHash ||
        published.file.dev !== stagedWrite.file.dev ||
        published.file.ino !== stagedWrite.file.ino
      ) {
        if (!cleanupVerifiedCapture(target.path, stage, plan.expectedHash, plannedAfterHash)) {
          throw new Error("Could not safely clean a raced publish");
        }
        const receipt = receiptWithJournalFields(
          target,
          "concurrent_conflict",
          "target_changed_after_publish",
          plan.expectedHash,
          backupPath,
          receiptPath,
          undefined,
          plan.mutation,
          plannedAfterHash,
        );
        writePersistedReceipt(receiptPath, receipt);
        return receipt;
      }
      if (!cleanupVerifiedCapture(target.path, stage, plan.expectedHash, plannedAfterHash)) {
        throw new Error("Could not safely finalize the captured legacy source");
      }
    }
    const afterHash = plan.mutation === "delete" ? undefined : hashContent(plan.nextContent ?? "");
    const receipt = receiptWithJournalFields(
      target,
      "removed",
      plan.reason,
      plan.expectedHash,
      backupPath,
      receiptPath,
      afterHash,
      plan.mutation,
      plannedAfterHash,
    );
    writePersistedReceipt(receiptPath, receipt);
    return receipt;
  } catch {
    // Once pending is durable, leave it intact. The next run can distinguish
    // before/after/conflict and recover safely instead of guessing here.
    if (journalWritten) return baseReceipt(target, "failed", "migration_io_failed");
    if (stage) {
      cleanupStagedNext(target.path, stage.capturePath, plannedAfterHash);
      removeStageDirectoryIfEmpty(target.path, stage.capturePath);
    }
    return persistTerminal(target, backupRoot, "failed", "migration_io_failed", {
      beforeHash: plan.expectedHash,
      plannedMutation: plan.mutation,
      plannedAfterHash,
    });
  } finally {
    releaseMigrationLock(
      lockPath,
      lock.content,
      { dev: lock.dev, ino: lock.ino },
      input._testHooks,
    );
  }
}

export function migrateLegacyTargets(input: {
  bundle: ProjectBundleProof;
  targets: readonly LegacyTarget[];
  backupRoot: string;
  allowRemoval: boolean;
  finalMutationAuthorization?: FinalMutationAuthorization;
  /** @internal Deterministic fault injection for filesystem race tests only. */
  _testHooks?: MigrationTestHooks;
}): MigrationReceipt[] {
  assertProjectBundleProof(input.bundle);
  const receipts: MigrationReceipt[] = [];
  const seenPaths = new Set<string>();

  for (const target of input.targets) {
    const key = resolve(target.path);
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    const authorizationFailure = bundleFailure(input.bundle, target);
    if (authorizationFailure) {
      receipts.push(baseReceipt(target, "preserved_ambiguous", authorizationFailure));
      continue;
    }

    const priorDecision = decidePriorReceipt(target, input.backupRoot);
    if (priorDecision.action === "return") {
      receipts.push(priorDecision.receipt);
      continue;
    }

    let content: string;
    try {
      const stat = lstatSync(target.path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        receipts.push(
          persistTerminal(target, input.backupRoot, "preserved_ambiguous", "non_regular_target"),
        );
        continue;
      }
      content = readFileSync(target.path, "utf8");
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      receipts.push(
        code === "ENOENT"
          ? persistTerminal(target, input.backupRoot, "not_found", "target_absent")
          : baseReceipt(target, "failed", "target_read_failed"),
      );
      continue;
    }

    const plan = planForTarget(target, content);
    receipts.push(applyContentPlan({ ...input, target, plan }));
  }
  return receipts;
}
