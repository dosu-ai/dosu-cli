import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getConfigDir } from "../config/config";
import {
  inspectLegacyTarget,
  type LegacyTarget,
  type LegacyTargetEnvironment,
  legacyTargetsNeedCleanup,
  type MigrationOutcome,
  migrateLegacyTargets,
  type ProjectBundleFailureReason,
  type ProjectBundleProof,
  type ProjectProof,
  type ProjectProxyExpectation,
  type ProviderId,
  resolveLegacyTargets,
  verifyProjectBundle,
} from "../migration";
import { inspectGlobalMcpIntent } from "../migration/global-intent";

export interface ProjectScopeMigrationEnvironment extends LegacyTargetEnvironment {}

export interface ProjectScopeMigrationInput {
  /** Opaque proof returned by resolveProjectProof/proveProjectScope. */
  project: ProjectProof;
  /** Providers whose complete project bundle was successfully installed. */
  providerIDs: readonly ProviderId[];
  /** Exact secretless proxy command expected in every selected project config. */
  proxy: ProjectProxyExpectation;
  instructionContent: string;
  environment?: ProjectScopeMigrationEnvironment;
  /** Test override. Production receipts live under getConfigDir(). */
  backupRoot?: string;
  /** Test override. Production global intent lives under getConfigDir(). */
  globalIntentRoot?: string;
  /** @internal Deterministic race injection for migration tests only. */
  _testHooks?: {
    afterExplicitGlobalIntentPartition?: () => void;
    beforeLegacyTargetCapture?: (target: LegacyTarget) => void;
  };
}

export interface ProjectScopeMigrationCounts {
  removed: number;
  not_found: number;
  preserved: number;
  failed: number;
  total: number;
}

type ProjectScopeMigrationFailureReason =
  | ProjectBundleFailureReason
  | "unsupported_platform"
  | "unsafe_backup_root"
  | "migration_failed";

export type ProjectScopeMigrationInspection =
  | {
      ok: true;
      needsRuntimeVerification: boolean;
      receiptRoot: string;
      warnings: string[];
    }
  | {
      ok: false;
      reason: Exclude<ProjectScopeMigrationFailureReason, "migration_failed">;
      receiptRoot: string;
      warnings: string[];
    };

export type ProjectScopeMigrationResult =
  | {
      ok: true;
      cleanupAttempted: true;
      runtimeVerified: boolean;
      receiptRoot: string;
      counts: ProjectScopeMigrationCounts;
      warnings: string[];
    }
  | {
      ok: false;
      cleanupAttempted: boolean;
      runtimeVerified: boolean;
      reason: ProjectScopeMigrationFailureReason;
      receiptRoot: string;
      counts: ProjectScopeMigrationCounts;
      warnings: string[];
    };

interface ResolvedMigration {
  bundle: ProjectBundleProof;
  providerIDs: ProviderId[];
  targets: LegacyTarget[];
  environment: ProjectScopeMigrationEnvironment;
  receiptRoot: string;
  globalIntentRoot: string;
  warnings: string[];
}

type Resolution =
  | { ok: true; value: ResolvedMigration }
  | {
      ok: false;
      reason: Exclude<ProjectScopeMigrationFailureReason, "migration_failed">;
      receiptRoot: string;
      warnings: string[];
    };

const EMPTY_COUNTS: ProjectScopeMigrationCounts = Object.freeze({
  removed: 0,
  not_found: 0,
  preserved: 0,
  failed: 0,
  total: 0,
});

function runtimeEnvironment(): ProjectScopeMigrationEnvironment | null {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return null;
  return { platform, homeDir: homedir(), env: process.env };
}

function receiptRoot(input: ProjectScopeMigrationInput): string {
  return input.backupRoot ?? join(getConfigDir(), "migrations", "project-scope-v1");
}

function globalIntentRoot(input: ProjectScopeMigrationInput): string {
  return input.globalIntentRoot ?? join(getConfigDir(), "migrations", "global-mcp-intent-v1");
}

function safeExistingReceiptRoot(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error: unknown) {
    return (
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  }
}

function counterpart(provider: ProviderId): ProviderId | null {
  if (provider === "gemini") return "antigravity";
  if (provider === "antigravity") return "gemini";
  return null;
}

/**
 * Old Gemini and Antigravity setup shared one global GEMINI.md section. If an
 * unselected counterpart MCP target is anything except strictly absent, keep
 * that provider in the authorization set so the shared rule cannot be removed.
 */
function effectiveProviderIDs(
  selected: readonly ProviderId[],
  environment: ProjectScopeMigrationEnvironment,
): { providerIDs: ProviderId[]; warnings: string[] } {
  const effective = new Set(selected);
  const warnings: string[] = [];

  for (const provider of selected) {
    const other = counterpart(provider);
    if (!other || effective.has(other)) continue;
    const resolution = resolveLegacyTargets([other], environment);
    warnings.push(...resolution.warnings);
    const mcpTarget = resolution.targets.find(
      (target) => target.provider === other && target.id === `${other}:mcp`,
    );
    if (!mcpTarget || inspectLegacyTarget(mcpTarget).disposition !== "not_found") {
      effective.add(other);
    }
  }

  return { providerIDs: [...effective], warnings };
}

function resolveMigration(input: ProjectScopeMigrationInput): Resolution {
  const root = receiptRoot(input);
  const verified = verifyProjectBundle({
    project: input.project,
    providerIDs: input.providerIDs,
    proxy: input.proxy,
    instructionContent: input.instructionContent,
  });
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, receiptRoot: root, warnings: [] };
  }

  const environment = input.environment ?? runtimeEnvironment();
  if (!environment) {
    return { ok: false, reason: "unsupported_platform", receiptRoot: root, warnings: [] };
  }
  if (!safeExistingReceiptRoot(root)) {
    return { ok: false, reason: "unsafe_backup_root", receiptRoot: root, warnings: [] };
  }

  const selected = [...new Set(input.providerIDs)];
  const effective = effectiveProviderIDs(selected, environment);
  const legacy = resolveLegacyTargets(effective.providerIDs, environment);
  return {
    ok: true,
    value: {
      bundle: verified.proof,
      providerIDs: effective.providerIDs,
      targets: legacy.targets,
      environment,
      receiptRoot: root,
      globalIntentRoot: globalIntentRoot(input),
      warnings: [...new Set([...effective.warnings, ...legacy.warnings])],
    },
  };
}

function partitionExplicitGlobalIntent(
  targets: readonly LegacyTarget[],
  intentRoot: string,
): { migratable: LegacyTarget[]; preserved: LegacyTarget[]; warnings: string[] } {
  const migratable: LegacyTarget[] = [];
  const preserved: LegacyTarget[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    if (target.kind !== "json_mcp" && target.kind !== "codex_toml") {
      migratable.push(target);
      continue;
    }
    const intent = inspectGlobalMcpIntent({
      provider: target.provider,
      targetPath: target.path,
      intentRoot,
    });
    if (intent.status === "absent") {
      migratable.push(target);
      continue;
    }
    preserved.push(target);
    warnings.push(
      `Preserved explicit global MCP configuration for ${target.provider} (${intent.reason})`,
    );
  }
  return { migratable, preserved, warnings };
}

function finalGlobalMcpAuthorization(target: LegacyTarget, intentRoot: string): string | null {
  if (target.kind !== "json_mcp" && target.kind !== "codex_toml") return null;
  const intent = inspectGlobalMcpIntent({
    provider: target.provider,
    targetPath: target.path,
    intentRoot,
  });
  return intent.status === "absent" ? null : intent.reason;
}

/**
 * Read-only ownership inspection. Callers may use this to avoid a cleanup-only
 * runtime check when no removable legacy target exists.
 */
export function inspectProjectScopeMigration(
  input: ProjectScopeMigrationInput,
): ProjectScopeMigrationInspection {
  const resolved = resolveMigration(input);
  if (!resolved.ok) return resolved;
  const { globalIntentRoot: intentRoot, receiptRoot: root, targets, warnings } = resolved.value;
  const explicitIntent = partitionExplicitGlobalIntent(targets, intentRoot);
  return {
    ok: true,
    needsRuntimeVerification: legacyTargetsNeedCleanup(explicitIntent.migratable),
    receiptRoot: root,
    warnings: [...new Set([...warnings, ...explicitIntent.warnings])],
  };
}

function summarizeOutcomes(outcomes: readonly MigrationOutcome[]): ProjectScopeMigrationCounts {
  const counts: ProjectScopeMigrationCounts = { ...EMPTY_COUNTS };
  for (const outcome of outcomes) {
    counts.total += 1;
    switch (outcome) {
      case "removed":
        counts.removed += 1;
        break;
      case "not_found":
        counts.not_found += 1;
        break;
      case "preserved_ambiguous":
      case "concurrent_conflict":
        counts.preserved += 1;
        break;
      case "pending":
      case "failed":
        counts.failed += 1;
        break;
    }
  }
  return counts;
}

/**
 * Re-verifies the complete project bundle, then performs only strict,
 * recoverable legacy cleanup. This function never starts the MCP runtime.
 */
export function runProjectScopeMigration(
  input: ProjectScopeMigrationInput & { runtimeVerified: boolean },
): ProjectScopeMigrationResult {
  const resolved = resolveMigration(input);
  if (!resolved.ok) {
    return {
      ok: false,
      cleanupAttempted: false,
      runtimeVerified: input.runtimeVerified,
      reason: resolved.reason,
      receiptRoot: resolved.receiptRoot,
      counts: { ...EMPTY_COUNTS },
      warnings: resolved.warnings,
    };
  }

  const {
    bundle,
    globalIntentRoot: intentRoot,
    receiptRoot: root,
    targets,
    warnings,
  } = resolved.value;
  const resultWarnings = [...warnings];
  const outcomes: MigrationOutcome[] = [];
  try {
    const explicitIntent = partitionExplicitGlobalIntent(targets, intentRoot);
    input._testHooks?.afterExplicitGlobalIntentPartition?.();
    resultWarnings.push(...explicitIntent.warnings);
    outcomes.push(...explicitIntent.preserved.map(() => "preserved_ambiguous" as const));
    const targetReceipts = migrateLegacyTargets({
      bundle,
      targets: explicitIntent.migratable,
      backupRoot: root,
      allowRemoval: input.runtimeVerified,
      finalMutationAuthorization: (target) => finalGlobalMcpAuthorization(target, intentRoot),
      ...(input._testHooks?.beforeLegacyTargetCapture
        ? {
            _testHooks: {
              beforeCapture: input._testHooks.beforeLegacyTargetCapture,
            },
          }
        : {}),
    });
    outcomes.push(...targetReceipts.map((receipt) => receipt.outcome));
    for (const receipt of targetReceipts) {
      if (
        !receipt.reason.startsWith("global_intent_") &&
        receipt.reason !== "explicit_global_intent"
      ) {
        continue;
      }
      resultWarnings.push(
        `Preserved explicit global MCP configuration for ${receipt.provider} (${receipt.reason})`,
      );
    }
  } catch {
    return {
      ok: false,
      cleanupAttempted: true,
      runtimeVerified: input.runtimeVerified,
      reason: "migration_failed",
      receiptRoot: root,
      counts: summarizeOutcomes([...outcomes, "failed"]),
      warnings: [...new Set(resultWarnings)],
    };
  }

  const counts = summarizeOutcomes(outcomes);
  if (counts.failed > 0) {
    return {
      ok: false,
      cleanupAttempted: true,
      runtimeVerified: input.runtimeVerified,
      reason: "migration_failed",
      receiptRoot: root,
      counts,
      warnings: [...new Set(resultWarnings)],
    };
  }
  return {
    ok: true,
    cleanupAttempted: true,
    runtimeVerified: input.runtimeVerified,
    receiptRoot: root,
    counts,
    warnings: [...new Set(resultWarnings)],
  };
}
