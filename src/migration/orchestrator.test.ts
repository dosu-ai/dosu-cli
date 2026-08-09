import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyContentPlan,
  ensureBackup,
  inspectLegacyTarget,
  legacyTargetsNeedCleanup,
  type MigrationReceipt,
  migrateLegacyTargets,
} from "./orchestrator";
import { hashContent, planLegacyJsonMcp, planLegacyStandaloneRule } from "./planners";
import { type ProjectBundleProof, verifyProjectBundle } from "./project-bundle";
import { proveProjectScope } from "./project-proof";
import type { LegacyTarget } from "./targets";

let tempDir: string;
let backupRoot: string;
const RELEASED_RULE = readFileSync(join(process.cwd(), "rules", "dosu.md"), "utf8");

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-legacy-migration-"));
  backupRoot = join(tempDir, "backups");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function proof(): ProjectBundleProof {
  const root = join(tempDir, "project");
  mkdirSync(join(root, ".agents", "skills", "dosu"), { recursive: true });
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  const skill = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
  writeFileSync(join(root, ".agents", "skills", "dosu", "SKILL.md"), skill);
  const skillHash = createHash("sha256").update("SKILL.md").update(skill).digest("hex");
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        dosu: {
          source: "dosu-ai/dosu-skill",
          sourceType: "github",
          skillPath: "skills/dosu/SKILL.md",
          computedHash: skillHash,
        },
      },
    }),
  );
  const claudeSkill = join(root, ".claude", "skills", "dosu");
  mkdirSync(claudeSkill, { recursive: true });
  writeFileSync(join(claudeSkill, "SKILL.md"), skill);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        dosu: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
  );
  writeFileSync(
    join(root, "CLAUDE.md"),
    "<!-- dosu:project-instructions:start v1 -->\n@AGENTS.md\n<!-- dosu:project-instructions:end -->\n",
  );
  const result = proveProjectScope({
    cwd: root,
    gitTopLevel: root,
    insideWorkTree: true,
    bareRepository: false,
  });
  if (!result.ok) throw new Error(result.reason);
  const bundle = verifyProjectBundle({
    project: result.proof,
    providerIDs: ["claude"],
    proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
    instructionContent: "Use Dosu.",
  });
  if (!bundle.ok) throw new Error(bundle.reason);
  return bundle.proof;
}

function jsonTarget(path: string): LegacyTarget {
  return {
    id: "claude:mcp",
    provider: "claude",
    kind: "json_mcp",
    path,
    topKey: "mcpServers",
  };
}

function crashedWriteCapture(name: string): {
  path: string;
  original: string;
  plan: ReturnType<typeof planLegacyJsonMcp>;
  pending: MigrationReceipt;
} {
  const path = join(tempDir, `${name}.json`);
  const original = JSON.stringify({
    mcpServers: {
      dosu: {
        type: "http",
        url: "https://api.dosu.dev/v1/mcp/deployments/dep",
        headers: { "X-Dosu-API-Key": "legacy-secret" },
      },
      user: { url: "https://example.com" },
    },
  });
  writeFileSync(path, original);
  const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
  expect(
    applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterCapture: () => {
          throw new Error("simulated crash");
        },
      },
    }),
  ).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
  const receiptName = readdirSync(backupRoot).find((entry) => entry.endsWith(".receipt.json"));
  if (!receiptName) throw new Error("expected pending receipt");
  const pending = JSON.parse(readFileSync(join(backupRoot, receiptName), "utf8"));
  return { path, original, plan, pending };
}

describe("backup, receipt, concurrent hash, and idempotence orchestration", () => {
  it("rejects and removes a newly copied backup whose bytes do not match the preimage", () => {
    const source = join(tempDir, "source.json");
    const backup = join(tempDir, "corrupted.bak");
    const content = '{"secret":"original"}';
    writeFileSync(source, content);
    const expectedHash = createHash("sha256").update(content).digest("hex");

    expect(() =>
      ensureBackup(source, backup, expectedHash, (from, to, flags) => {
        copyFileSync(from, to, flags);
        writeFileSync(to, "corrupted during copy");
      }),
    ).toThrow("New migration backup does not match the planned content");
    expect(existsSync(backup)).toBe(false);
  });

  it("rejects an existing backup symlink even when it resolves to the exact preimage", () => {
    const source = join(tempDir, "source.json");
    const backup = join(tempDir, "linked.bak");
    const content = '{"secret":"original"}';
    writeFileSync(source, content);
    symlinkSync(source, backup);

    expect(() => ensureBackup(source, backup, hashContent(content))).toThrow(
      "Existing migration backup is not a regular file",
    );
    expect(readFileSync(source, "utf8")).toBe(content);
    expect(lstatSync(backup).isSymbolicLink()).toBe(true);
  });

  it("inspects strict current plans without mutating and requests runtime verification only for removal", () => {
    const owned = join(tempDir, "owned.json");
    const foreign = join(tempDir, "foreign-inspection.json");
    writeFileSync(
      owned,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep",
            headers: { "X-Dosu-API-Key": "secret" },
          },
        },
      }),
    );
    writeFileSync(foreign, '{"mcpServers":{"dosu":{"url":"https://example.com"}}}');

    expect(legacyTargetsNeedCleanup([jsonTarget(owned)])).toBe(true);
    expect(legacyTargetsNeedCleanup([jsonTarget(foreign)])).toBe(false);
    expect(inspectLegacyTarget(jsonTarget(owned))).toMatchObject({ disposition: "remove" });
    expect(inspectLegacyTarget(jsonTarget(foreign))).toMatchObject({
      disposition: "ambiguous",
      reason: "foreign_dosu_entry",
    });
    expect(inspectLegacyTarget(jsonTarget(join(tempDir, "absent.json")))).toEqual({
      disposition: "not_found",
      reason: "target_absent",
    });
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("inspects every historical target kind and deduplicates repeated paths", () => {
    const codexPath = join(tempDir, "config.toml");
    writeFileSync(
      codexPath,
      '[mcp_servers.dosu]\ntype = "http"\nurl = "https://api.dosu.dev/v1/mcp/deployments/dep"\n\n[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "secret"\n',
    );
    const claudeRule = join(tempDir, "dosu.md");
    writeFileSync(claudeRule, RELEASED_RULE);
    const cursorRule = join(tempDir, "dosu.mdc");
    writeFileSync(cursorRule, `---\nalwaysApply: true\n---\n\n${RELEASED_RULE}`);
    const targets: LegacyTarget[] = [
      { id: "codex:mcp", provider: "codex", kind: "codex_toml", path: codexPath },
      {
        id: "claude:rule",
        provider: "claude",
        kind: "rule_file",
        path: claudeRule,
        ruleKind: "claude",
      },
      {
        id: "cursor:rule",
        provider: "cursor",
        kind: "rule_file",
        path: cursorRule,
        ruleKind: "cursor",
      },
    ];
    for (const target of targets) {
      expect(inspectLegacyTarget(target)).toMatchObject({ disposition: "remove" });
    }
    expect(legacyTargetsNeedCleanup([targets[0], targets[0]])).toBe(true);
  });

  it("treats directories and symlinks as ambiguous without following them", () => {
    const directory = join(tempDir, "directory-target");
    const linked = join(tempDir, "linked-target.json");
    const foreign = join(tempDir, "foreign.json");
    mkdirSync(directory);
    writeFileSync(foreign, '{"mcpServers":{}}');
    symlinkSync(foreign, linked);

    expect(inspectLegacyTarget(jsonTarget(directory))).toEqual({
      disposition: "ambiguous",
      reason: "non_regular_target",
    });
    expect(inspectLegacyTarget(jsonTarget(linked))).toEqual({
      disposition: "ambiguous",
      reason: "non_regular_target",
    });
    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [jsonTarget(directory), jsonTarget(linked)],
        backupRoot,
        allowRemoval: true,
      }).map((receipt) => receipt.reason),
    ).toEqual(["non_regular_target", "non_regular_target"]);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it("fails closed when even a not-found receipt cannot be written", () => {
    const unsafeBackupRoot = join(tempDir, "backup-file");
    writeFileSync(unsafeBackupRoot, "not a directory");
    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [jsonTarget(join(tempDir, "missing.json"))],
        backupRoot: unsafeBackupRoot,
        allowRemoval: true,
      }),
    ).toEqual([expect.objectContaining({ outcome: "failed", reason: "receipt_write_failed" })]);
  });

  it("does not mutate or tombstone a removable target without runtime verification", () => {
    const path = join(tempDir, "runtime-gated.json");
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    writeFileSync(path, content);

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: false,
    })[0];
    expect(receipt).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "runtime_not_verified",
    });
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("backs up before mutation, writes a secret-free receipt, and is idempotent", () => {
    const path = join(tempDir, "home", ".claude.json");
    mkdirSync(join(tempDir, "home"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep",
            headers: { "X-Dosu-API-Key": "super-secret" },
          },
          user: { url: "https://example.com" },
        },
      }),
      { mode: 0o600 },
    );

    const first = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ outcome: "removed", targetId: "claude:mcp" });
    expect(readFileSync(path, "utf8")).toContain("https://example.com");
    expect(readFileSync(path, "utf8")).not.toContain("super-secret");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    const backupFiles = readdirSync(backupRoot).filter((name) => name.endsWith(".bak"));
    const receiptFiles = readdirSync(backupRoot).filter((name) => name.endsWith(".receipt.json"));
    expect(backupFiles).toHaveLength(1);
    expect(receiptFiles).toHaveLength(1);
    expect(readFileSync(join(backupRoot, backupFiles[0]), "utf8")).toContain("super-secret");
    const receiptText = readFileSync(join(backupRoot, receiptFiles[0]), "utf8");
    expect(receiptText).not.toContain("super-secret");
    expect(JSON.parse(receiptText)).toMatchObject({ outcome: "removed" });
    expect(JSON.parse(receiptText)).toMatchObject({
      plannedMutation: "write",
      plannedAfterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const second = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(second[0]).toMatchObject({ outcome: "not_found" });
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  });

  it("refuses to apply a stale plan after a concurrent content change", async () => {
    const path = join(tempDir, "config.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    writeFileSync(path, original);
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    writeFileSync(path, `${original}\n// concurrent edit\n`);

    const { applyContentPlan } = await import("./orchestrator");
    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
    });

    expect(receipt).toMatchObject({ outcome: "concurrent_conflict" });
    expect(readFileSync(path, "utf8")).toContain("concurrent edit");
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".receipt.json"))).toHaveLength(
      1,
    );
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
  });

  it("rechecks the source and project bundle at every pre-capture boundary", () => {
    const phases = [
      "afterLockAcquired",
      "afterBackupCreated",
      "beforeFinalBundleCheck",
      "beforeFinalSourceCheck",
    ] as const;

    for (const phase of phases) {
      const phaseBackupRoot = join(backupRoot, phase);
      const path = join(tempDir, `${phase}.json`);
      const original = JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep",
            headers: { "X-Dosu-API-Key": "legacy-secret" },
          },
          user: { url: "https://example.com" },
        },
      });
      writeFileSync(path, original);
      const bundle = proof();
      const mutate = () => {
        if (phase === "beforeFinalBundleCheck") {
          writeFileSync(join(bundle.root, ".mcp.json"), '{"mcpServers":{}}');
        } else {
          writeFileSync(path, `${original}\nuser concurrent edit`);
        }
      };
      const testHooks =
        phase === "afterLockAcquired"
          ? { afterLockAcquired: mutate }
          : phase === "afterBackupCreated"
            ? { afterBackupCreated: mutate }
            : phase === "beforeFinalBundleCheck"
              ? { beforeFinalBundleCheck: mutate }
              : { beforeFinalSourceCheck: mutate };

      const receipt = applyContentPlan({
        bundle,
        target: jsonTarget(path),
        plan: planLegacyJsonMcp({
          content: original,
          provider: "claude",
          topKey: "mcpServers",
        }),
        backupRoot: phaseBackupRoot,
        allowRemoval: true,
        _testHooks: testHooks,
      });

      expect(receipt).toMatchObject({
        outcome: phase === "beforeFinalBundleCheck" ? "preserved_ambiguous" : "concurrent_conflict",
        reason:
          phase === "beforeFinalBundleCheck" ? "project_bundle_changed" : "content_hash_changed",
      });
    }
  });

  it("applies authorization and not-found plans without touching the target", () => {
    const path = join(tempDir, "direct-not-found.json");
    const content = '{"mcpServers":{"user":{"url":"https://example.com"}}}';
    writeFileSync(path, content);
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan.disposition).toBe("not_found");
    expect(
      applyContentPlan({
        bundle: proof(),
        target: jsonTarget(path),
        plan,
        backupRoot: join(backupRoot, "not-found"),
        allowRemoval: true,
      }),
    ).toMatchObject({ outcome: "not_found" });

    const unauthorized: LegacyTarget = {
      ...jsonTarget(path),
      id: "shared:mcp",
      requiredProviders: ["claude", "gemini"],
    };
    expect(
      applyContentPlan({
        bundle: proof(),
        target: unauthorized,
        plan,
        backupRoot: join(backupRoot, "unauthorized"),
        allowRemoval: true,
      }),
    ).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "shared_target_not_fully_authorized",
    });
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("restores a replacement captured after the final delete check instead of deleting it", () => {
    const path = join(tempDir, "delete-capture-race.md");
    const displaced = join(tempDir, "delete-capture-race.displaced.md");
    const original = RELEASED_RULE;
    const replacement = "# User-owned replacement\n";
    writeFileSync(path, original);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };
    const plan = planLegacyStandaloneRule(original, "claude");
    expect(plan.mutation).toBe("delete");

    const receipt = applyContentPlan({
      bundle: proof(),
      target,
      plan,
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeCapture: () => {
          renameSync(path, displaced);
          writeFileSync(path, replacement);
        },
      },
    });

    expect(receipt).toMatchObject({
      outcome: "concurrent_conflict",
      reason: "captured_source_mismatch",
    });
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(readFileSync(displaced, "utf8")).toBe(original);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("restores a symlink captured after the final delete check without following it", () => {
    const path = join(tempDir, "delete-capture-symlink-race.md");
    const displaced = join(tempDir, "delete-capture-symlink-race.displaced.md");
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };

    const receipt = applyContentPlan({
      bundle: proof(),
      target,
      plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeCapture: () => {
          renameSync(path, displaced);
          symlinkSync(displaced, path);
        },
      },
    });

    expect(receipt).toMatchObject({
      outcome: "concurrent_conflict",
      reason: "captured_source_mismatch",
    });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(displaced);
    expect(readFileSync(displaced, "utf8")).toBe(RELEASED_RULE);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("keeps a captured directory in a durable pending journal and reports it again on recovery", () => {
    const path = join(tempDir, "delete-capture-directory-race.md");
    const displaced = join(tempDir, "delete-capture-directory-race.displaced.md");
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };

    const receipt = applyContentPlan({
      bundle: proof(),
      target,
      plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeCapture: () => {
          renameSync(path, displaced);
          mkdirSync(path);
        },
      },
    });

    expect(receipt).toMatchObject({ outcome: "pending", reason: "captured_source_mismatch" });
    const receiptName = readdirSync(backupRoot).find((name) => name.endsWith(".receipt.json"));
    if (!receiptName) throw new Error("expected pending receipt");
    const persisted = JSON.parse(readFileSync(join(backupRoot, receiptName), "utf8"));
    expect(persisted).toMatchObject({ outcome: "pending", reason: "mutation_prepared" });
    expect(lstatSync(persisted.capturePath).isDirectory()).toBe(true);
    expect(existsSync(path)).toBe(false);

    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [target],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(retried).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "pending_capture_invalid",
    });
    expect(JSON.parse(readFileSync(join(backupRoot, receiptName), "utf8"))).toMatchObject({
      outcome: "pending",
    });
    expect(lstatSync(persisted.capturePath).isDirectory()).toBe(true);
  });

  it("never overwrites a target created after an exact source was captured for a write", () => {
    const path = join(tempDir, "write-publish-race.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    const replacement = '{"userOwned":"created after capture"}';
    writeFileSync(path, original);
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    expect(plan.mutation).toBe("write");

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterCapture: () => writeFileSync(path, replacement),
      },
    });

    expect(receipt).toMatchObject({
      outcome: "concurrent_conflict",
      reason: "target_recreated_during_migration",
    });
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("retries a pending write after a crash immediately after atomic capture", () => {
    const path = join(tempDir, "write-capture-crash.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");

    expect(
      applyContentPlan({
        bundle: proof(),
        target: jsonTarget(path),
        plan,
        backupRoot,
        allowRemoval: true,
        _testHooks: {
          afterCapture: () => {
            throw new Error("simulated crash");
          },
        },
      }),
    ).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(existsSync(path)).toBe(false);

    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(retried.outcome).toBe("removed");
    expect(readFileSync(path, "utf8")).toBe(plan.nextContent);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("finalizes a pending delete without leaking the exact captured legacy file", () => {
    const path = join(tempDir, "delete-capture-crash.md");
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };
    const plan = planLegacyStandaloneRule(RELEASED_RULE, "claude");

    expect(
      applyContentPlan({
        bundle: proof(),
        target,
        plan,
        backupRoot,
        allowRemoval: true,
        _testHooks: {
          afterCapture: () => {
            throw new Error("simulated crash");
          },
        },
      }),
    ).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(existsSync(path)).toBe(false);

    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [target],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(retried).toMatchObject({ outcome: "removed", reason: "recovered_pending_mutation" });
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("does not delete a target recreated after an exact delete capture", () => {
    const path = join(tempDir, "delete-target-recreated.md");
    const replacement = "# New user rule\n";
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };

    const receipt = applyContentPlan({
      bundle: proof(),
      target,
      plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
      backupRoot,
      allowRemoval: true,
      _testHooks: { afterCapture: () => writeFileSync(path, replacement) },
    });

    expect(receipt).toMatchObject({
      outcome: "concurrent_conflict",
      reason: "target_recreated_during_migration",
    });
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  it("does not overwrite a target replacement installed immediately after publish", () => {
    const path = join(tempDir, "write-after-publish-race.json");
    const publishedAside = join(tempDir, "write-after-publish-race.published.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    const replacement = '{"userOwned":"after publish"}';
    writeFileSync(path, original);

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({
        content: original,
        provider: "claude",
        topKey: "mcpServers",
      }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterPublish: () => {
          renameSync(path, publishedAside);
          writeFileSync(path, replacement);
        },
      },
    });

    expect(receipt).toMatchObject({
      outcome: "concurrent_conflict",
      reason: "target_changed_after_publish",
    });
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(readFileSync(publishedAside, "utf8")).toContain("https://example.com");
  });

  it("cleans an unjournaled private stage when preparation fails", () => {
    const path = join(tempDir, "stage-preparation-failure.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);

    expect(
      applyContentPlan({
        bundle: proof(),
        target: jsonTarget(path),
        plan: planLegacyJsonMcp({
          content: original,
          provider: "claude",
          topKey: "mcpServers",
        }),
        backupRoot,
        allowRemoval: true,
        _testHooks: {
          afterStagePrepared: () => {
            throw new Error("simulated preparation failure");
          },
        },
      }),
    ).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(
      readdirSync(tempDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("fails closed when staged write bytes change after capture", () => {
    const path = join(tempDir, "changed-staged-write.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterCapture: (stage) => writeFileSync(stage.nextPath as string, "tampered next bytes"),
      },
    });

    expect(receipt).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a recreated delete target when an unknown stage artifact blocks cleanup", () => {
    const path = join(tempDir, "delete-cleanup-failure.md");
    const replacement = "# User rule created during migration\n";
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };

    const receipt = applyContentPlan({
      bundle: proof(),
      target,
      plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterCapture: (stage) => {
          writeFileSync(path, replacement);
          writeFileSync(join(stage.capturePath, "..", "unknown"), "do not remove blindly");
        },
      },
    });

    expect(receipt).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  it("keeps a recreated write target when an unknown stage artifact blocks conflict cleanup", () => {
    const path = join(tempDir, "write-cleanup-failure.json");
    const replacement = '{"userOwned":"publish conflict"}';
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterCapture: (stage) => {
          writeFileSync(path, replacement);
          writeFileSync(join(stage.capturePath, "..", "unknown"), "do not remove blindly");
        },
      },
    });

    expect(receipt).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(readFileSync(path, "utf8")).toBe(replacement);
  });

  it("leaves a valid published target when an unknown stage artifact blocks final cleanup", () => {
    const path = join(tempDir, "write-final-cleanup-failure.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "legacy-secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");
    writeFileSync(path, original);

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        afterPublish: (stage) =>
          writeFileSync(join(stage.capturePath, "..", "unknown"), "do not remove blindly"),
      },
    });

    expect(receipt).toMatchObject({ outcome: "failed", reason: "migration_io_failed" });
    expect(readFileSync(path, "utf8")).toBe(plan.nextContent);
  });

  it("preserves a pending capture when an unknown artifact prevents recovery cleanup", () => {
    const path = join(tempDir, "pending-cleanup-failure.md");
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };
    expect(
      applyContentPlan({
        bundle: proof(),
        target,
        plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
        backupRoot,
        allowRemoval: true,
        _testHooks: {
          afterCapture: (stage) => {
            writeFileSync(join(stage.capturePath, "..", "unknown"), "do not remove blindly");
            throw new Error("simulated crash");
          },
        },
      }),
    ).toMatchObject({ outcome: "failed" });

    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [target],
        backupRoot,
        allowRemoval: true,
      })[0],
    ).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "pending_capture_cleanup_failed",
    });
  });

  it.each([
    [
      "outside path",
      (receipt: MigrationReceipt) => ({
        ...receipt,
        capturePath: join(tempDir, "outside", "captured"),
      }),
    ],
    ["non-number device", (receipt: MigrationReceipt) => ({ ...receipt, sourceDev: "x" })],
    ["negative device", (receipt: MigrationReceipt) => ({ ...receipt, sourceDev: -1 })],
    ["non-number inode", (receipt: MigrationReceipt) => ({ ...receipt, sourceIno: "x" })],
    ["negative inode", (receipt: MigrationReceipt) => ({ ...receipt, sourceIno: -1 })],
  ])("preserves a pending capture with invalid %s authority", (_variant, mutate) => {
    const { path, pending } = crashedWriteCapture(`invalid-capture-${_variant}`);
    writeFileSync(pending.receiptPath as string, JSON.stringify(mutate(pending)));

    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [jsonTarget(path)],
        backupRoot,
        allowRemoval: true,
      })[0],
    ).toMatchObject({ outcome: "preserved_ambiguous", reason: "invalid_pending_receipt" });
  });

  it("keeps a changed captured object and its pending recovery journal", () => {
    const { path, pending } = crashedWriteCapture("changed-pending-capture");
    writeFileSync(pending.capturePath as string, "changed captured object");

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "pending_capture_invalid",
    });
    expect(readFileSync(pending.receiptPath as string, "utf8")).toContain('"outcome": "pending"');
  });

  it("keeps an exact capture when a conflicting target appears during recovery", () => {
    const { path, pending } = crashedWriteCapture("conflicted-pending-capture");
    const replacement = '{"userOwned":"during recovery"}';
    writeFileSync(path, replacement);

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "pending_recovery_conflict",
    });
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(readFileSync(pending.capturePath as string, "utf8")).toContain("legacy-secret");
  });

  it("preserves a captured delete when its recovery backup changed", () => {
    const path = join(tempDir, "invalid-pending-backup.md");
    writeFileSync(path, RELEASED_RULE);
    const target: LegacyTarget = {
      id: "claude:rule",
      provider: "claude",
      kind: "rule_file",
      path,
      ruleKind: "claude",
    };
    expect(
      applyContentPlan({
        bundle: proof(),
        target,
        plan: planLegacyStandaloneRule(RELEASED_RULE, "claude"),
        backupRoot,
        allowRemoval: true,
        _testHooks: {
          afterCapture: () => {
            throw new Error("simulated crash");
          },
        },
      }),
    ).toMatchObject({ outcome: "failed" });
    const receiptName = readdirSync(backupRoot).find((entry) => entry.endsWith(".receipt.json"));
    if (!receiptName) throw new Error("expected pending receipt");
    const pending: MigrationReceipt = JSON.parse(
      readFileSync(join(backupRoot, receiptName), "utf8"),
    );
    writeFileSync(pending.backupPath as string, "changed backup");

    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [target],
        backupRoot,
        allowRemoval: true,
      })[0],
    ).toMatchObject({ outcome: "preserved_ambiguous", reason: "pending_backup_invalid" });
  });

  it("retries a pre-mutation conflict after the exact source preimage returns", () => {
    const path = join(tempDir, "retry-conflict.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    writeFileSync(path, `${original}\nchanged concurrently`);

    expect(
      applyContentPlan({
        bundle: proof(),
        target: jsonTarget(path),
        plan,
        backupRoot,
        allowRemoval: true,
      }),
    ).toMatchObject({ outcome: "concurrent_conflict" });

    writeFileSync(path, original);
    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];

    expect(retried.outcome).toBe("removed");
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.dosu).toBeUndefined();
  });

  it("retries a terminal pre-mutation I/O failure from the exact source preimage", () => {
    const path = join(tempDir, "retry-io-failure.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    writeFileSync(path, original);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    writeFileSync(
      receiptPath,
      JSON.stringify({
        targetId: "claude:mcp",
        provider: "claude",
        path,
        targetPathHash: targetHash,
        outcome: "failed",
        reason: "migration_io_failed",
        beforeHash: hashContent(original),
        plannedMutation: "delete",
        receiptPath,
      }),
    );

    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];

    expect(retried.outcome).toBe("removed");
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.dosu).toBeUndefined();
  });

  it("never mutates ambiguous content and records the reason", () => {
    const path = join(tempDir, "foreign.json");
    const content = JSON.stringify({ mcpServers: { dosu: { url: "https://example.com" } } });
    writeFileSync(path, content);
    const receipts = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(receipts[0]).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".receipt.json"))).toHaveLength(
      1,
    );
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
  });

  it("deduplicates a shared target and returns one per-target receipt", () => {
    const path = join(tempDir, "GEMINI.md");
    writeFileSync(
      path,
      `<!-- dosu:rules:start v1 -->\n${RELEASED_RULE.trimEnd()}\n<!-- dosu:rules:end -->\n`,
    );
    const shared: LegacyTarget = {
      id: "claude:rule-alias-a",
      provider: "claude",
      kind: "rule_section",
      path,
    };
    const duplicate: LegacyTarget = { ...shared, id: "claude:rule-alias-b" };
    const receipts: MigrationReceipt[] = migrateLegacyTargets({
      bundle: proof(),
      targets: [shared, duplicate],
      backupRoot,
      allowRemoval: true,
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].outcome).toBe("removed");
    expect(existsSync(path)).toBe(false);
  });

  it("preserves a shared target unless every historical consumer has a project proof", () => {
    const path = join(tempDir, "shared-rule.md");
    const content = `<!-- dosu:rules:start v1 -->\n${RELEASED_RULE.trimEnd()}\n<!-- dosu:rules:end -->\n`;
    writeFileSync(path, content);
    const target: LegacyTarget = {
      id: "claude:shared-rule",
      provider: "claude",
      requiredProviders: ["claude", "gemini"],
      kind: "rule_section",
      path,
    };
    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [target],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "shared_target_not_fully_authorized",
    });
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("treats a terminal receipt as a tombstone and never deletes a later global re-creation", () => {
    const path = join(tempDir, "recreated.json");
    const globalEntry = (key: string) =>
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/dep",
            headers: { "X-Dosu-API-Key": key },
          },
        },
      });
    writeFileSync(path, globalEntry("old-secret"));
    expect(
      migrateLegacyTargets({
        bundle: proof(),
        targets: [jsonTarget(path)],
        backupRoot,
        allowRemoval: true,
      })[0].outcome,
    ).toBe("removed");

    writeFileSync(path, globalEntry("explicit-new-secret"));
    const second = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(second[0]).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "already_migrated",
    });
    expect(readFileSync(path, "utf8")).toContain("explicit-new-secret");
  });

  it("persists an absent target tombstone so a later user-created global entry is preserved", () => {
    const path = join(tempDir, "absent-then-created.json");
    const first = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(first[0]).toMatchObject({ outcome: "not_found", reason: "target_absent" });
    expect(readdirSync(backupRoot).filter((name) => name.endsWith(".receipt.json"))).toHaveLength(
      1,
    );

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "http",
            url: "https://api.dosu.dev/v1/mcp/deployments/new",
            headers: { "X-Dosu-API-Key": "new-user-choice" },
          },
        },
      }),
    );
    const second = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    });
    expect(second[0]).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "already_migrated",
    });
    expect(readFileSync(path, "utf8")).toContain("new-user-choice");
  });

  it("recovers a pending journal when mutation already reached the planned after-state", () => {
    const path = join(tempDir, "pending-after.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        other: { url: "https://example.com" },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");
    writeFileSync(path, plan.nextContent);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    const backupPath = join(backupRoot, "pending.bak");
    writeFileSync(backupPath, original);
    writeFileSync(
      receiptPath,
      JSON.stringify({
        targetId: "claude:mcp",
        provider: "claude",
        path,
        targetPathHash: targetHash,
        outcome: "pending",
        reason: "mutation_prepared",
        beforeHash: plan.expectedHash,
        plannedMutation: "write",
        plannedAfterHash: createHash("sha256").update(plan.nextContent).digest("hex"),
        backupPath,
        receiptPath,
      }),
    );

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({ outcome: "removed", reason: "recovered_pending_mutation" });
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ outcome: "removed" });
  });

  it("retries a pending journal from the exact before-state and terminalizes conflicts", () => {
    const path = join(tempDir, "pending-before.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");
    writeFileSync(path, original);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    const backupPath = join(backupRoot, "pending-before.bak");
    writeFileSync(backupPath, original);
    const pending = {
      targetId: "claude:mcp",
      provider: "claude",
      path,
      targetPathHash: targetHash,
      outcome: "pending",
      reason: "mutation_prepared",
      beforeHash: plan.expectedHash,
      plannedMutation: "write",
      plannedAfterHash: createHash("sha256").update(plan.nextContent).digest("hex"),
      backupPath,
      receiptPath,
    };
    writeFileSync(receiptPath, JSON.stringify(pending));

    const retried = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(retried.outcome).toBe("removed");

    const conflictPath = join(tempDir, "pending-conflict.json");
    writeFileSync(conflictPath, `${original}\n// user changed it`);
    const conflictHash = createHash("sha256").update(conflictPath).digest("hex").slice(0, 12);
    const conflictReceiptPath = join(backupRoot, `target-${conflictHash}.receipt.json`);
    const conflictBackupPath = join(backupRoot, "pending-conflict.bak");
    writeFileSync(conflictBackupPath, original);
    writeFileSync(
      conflictReceiptPath,
      JSON.stringify({
        ...pending,
        path: conflictPath,
        targetPathHash: conflictHash,
        receiptPath: conflictReceiptPath,
        backupPath: conflictBackupPath,
      }),
    );
    const conflict = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(conflictPath)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(conflict).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "pending_recovery_conflict",
    });
    expect(JSON.parse(readFileSync(conflictReceiptPath, "utf8"))).toMatchObject({
      outcome: "preserved_ambiguous",
    });
  });

  it("recovers an old lock owned by a process that is definitely gone", () => {
    const path = join(tempDir, "stale-lock.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");
    writeFileSync(path, original);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    const pendingBackup = join(backupRoot, "stale-lock-pending.bak");
    writeFileSync(pendingBackup, original);
    writeFileSync(
      receiptPath,
      JSON.stringify({
        targetId: "claude:mcp",
        provider: "claude",
        path,
        targetPathHash: targetHash,
        outcome: "pending",
        reason: "mutation_prepared",
        beforeHash: plan.expectedHash,
        plannedMutation: "write",
        plannedAfterHash: hashContent(plan.nextContent),
        backupPath: pendingBackup,
        receiptPath,
      }),
    );
    const lockPath = `${path}.dosu-migration.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        targetPath: path,
        backupRoot,
        nonce: "a".repeat(32),
      })}\n`,
    );

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({ outcome: "removed" });
    expect(readFileSync(path, "utf8")).toContain("https://example.com");
    expect(existsSync(lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ outcome: "removed" });
  });

  it("never unlinks a replacement raced into a stale lock path", () => {
    const path = join(tempDir, "stale-lock-race.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const lockPath = `${path}.dosu-migration.lock`;
    const displaced = `${lockPath}.displaced`;
    const replacement = "user-owned lock replacement\n";
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        targetPath: path,
        backupRoot,
        nonce: "c".repeat(32),
      })}\n`,
    );

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeLockCapture: (kind) => {
          if (kind !== "stale") return;
          renameSync(lockPath, displaced);
          writeFileSync(lockPath, replacement);
        },
      },
    });

    expect(receipt).toMatchObject({ outcome: "preserved_ambiguous", reason: "target_locked" });
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(readFileSync(displaced, "utf8")).toContain('"version":1');
  });

  it.each([
    "symlink",
    "directory",
  ] as const)("restores or durably reports a %s raced into a stale lock capture", (replacementKind) => {
    const path = join(tempDir, `stale-lock-${replacementKind}.json`);
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const lockPath = `${path}.dosu-migration.lock`;
    const displaced = `${lockPath}.displaced`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        targetPath: path,
        backupRoot,
        nonce: "d".repeat(32),
      })}\n`,
    );

    const first = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeLockCapture: (kind) => {
          if (kind !== "stale") return;
          renameSync(lockPath, displaced);
          if (replacementKind === "symlink") symlinkSync(displaced, lockPath);
          else mkdirSync(lockPath);
        },
      },
    });

    expect(first).toMatchObject({ outcome: "preserved_ambiguous", reason: "target_locked" });
    expect(readFileSync(path, "utf8")).toBe(original);
    if (replacementKind === "symlink") {
      expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(lockPath)).toBe(displaced);
    } else {
      expect(existsSync(lockPath)).toBe(false);
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith(".dosu-public-capture-")),
      ).toHaveLength(1);
    }

    const retried = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
    });
    expect(retried).toMatchObject(
      replacementKind === "directory"
        ? { outcome: "preserved_ambiguous", reason: "pending_lock_capture_recovery" }
        : { outcome: "preserved_ambiguous", reason: "invalid_target_lock" },
    );
    if (replacementKind === "directory") {
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith(".dosu-public-capture-")),
      ).toHaveLength(1);
    }
  });

  it("never unlinks a replacement raced into the acquired lock during release", () => {
    const path = join(tempDir, "release-lock-race.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const lockPath = `${path}.dosu-migration.lock`;
    const displaced = `${lockPath}.displaced`;
    const replacement = "user-owned release replacement\n";

    const receipt = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan: planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" }),
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeLockCapture: (kind) => {
          if (kind !== "release") return;
          renameSync(lockPath, displaced);
          writeFileSync(lockPath, replacement);
        },
      },
    });

    expect(receipt.outcome).toBe("removed");
    expect(readFileSync(path, "utf8")).toContain("https://example.com");
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(readFileSync(displaced, "utf8")).toContain('"version":1');
  });

  it.each([
    "symlink",
    "directory",
  ] as const)("restores or durably reports a %s raced into an acquired lock during release", (replacementKind) => {
    const path = join(tempDir, `release-lock-${replacementKind}.json`);
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const lockPath = `${path}.dosu-migration.lock`;
    const displaced = `${lockPath}.displaced`;
    const plan = planLegacyJsonMcp({
      content: original,
      provider: "claude",
      topKey: "mcpServers",
    });

    const first = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
      _testHooks: {
        beforeLockCapture: (kind) => {
          if (kind !== "release") return;
          renameSync(lockPath, displaced);
          if (replacementKind === "symlink") symlinkSync(displaced, lockPath);
          else mkdirSync(lockPath);
        },
      },
    });

    expect(first.outcome).toBe("removed");
    expect(readFileSync(path, "utf8")).toContain("https://example.com");
    if (replacementKind === "symlink") {
      expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(lockPath)).toBe(displaced);
    } else {
      expect(existsSync(lockPath)).toBe(false);
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith(".dosu-public-capture-")),
      ).toHaveLength(1);
    }

    const retried = applyContentPlan({
      bundle: proof(),
      target: jsonTarget(path),
      plan,
      backupRoot,
      allowRemoval: true,
    });
    expect(retried).toMatchObject(
      replacementKind === "directory"
        ? { outcome: "preserved_ambiguous", reason: "pending_lock_capture_recovery" }
        : { outcome: "not_found", reason: "terminal_receipt_unchanged" },
    );
    if (replacementKind === "directory") {
      expect(
        readdirSync(tempDir).filter((name) => name.startsWith(".dosu-public-capture-")),
      ).toHaveLength(1);
    }
  });

  it("does not overwrite a pending journal while a recognized active lock exists", () => {
    const path = join(tempDir, "active-lock.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    if (!plan.nextContent) throw new Error("expected write plan");
    writeFileSync(path, original);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    const pendingText = `${JSON.stringify({
      targetId: "claude:mcp",
      provider: "claude",
      path,
      targetPathHash: targetHash,
      outcome: "pending",
      reason: "mutation_prepared",
      beforeHash: plan.expectedHash,
      plannedMutation: "write",
      plannedAfterHash: hashContent(plan.nextContent),
      backupPath: join(backupRoot, "active-lock-pending.bak"),
      receiptPath,
    })}\n`;
    writeFileSync(receiptPath, pendingText);
    const lockPath = `${path}.dosu-migration.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        targetPath: path,
        backupRoot,
        nonce: "b".repeat(32),
      })}\n`,
    );

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({ outcome: "preserved_ambiguous", reason: "target_locked" });
    expect(readFileSync(receiptPath, "utf8")).toBe(pendingText);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("preserves a pending journal and target behind an unrecognized lock", () => {
    const path = join(tempDir, "invalid-lock.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    writeFileSync(path, original);
    mkdirSync(backupRoot, { recursive: true });
    const targetHash = createHash("sha256").update(path).digest("hex").slice(0, 12);
    const receiptPath = join(backupRoot, `target-${targetHash}.receipt.json`);
    const pendingText = `${JSON.stringify({
      targetId: "claude:mcp",
      provider: "claude",
      path,
      targetPathHash: targetHash,
      outcome: "pending",
      reason: "mutation_prepared",
      beforeHash: plan.expectedHash,
      plannedMutation: plan.mutation,
      backupPath: join(backupRoot, "invalid-lock-pending.bak"),
      receiptPath,
    })}\n`;
    writeFileSync(receiptPath, pendingText);
    writeFileSync(`${path}.dosu-migration.lock`, "user data");

    const receipt = migrateLegacyTargets({
      bundle: proof(),
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(receipt).toMatchObject({
      outcome: "preserved_ambiguous",
      reason: "invalid_target_lock",
    });
    expect(readFileSync(receiptPath, "utf8")).toBe(pendingText);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each([
    "directory",
    "array",
    "wrong target",
    "malformed JSON",
  ])("preserves the target behind a tampered %s receipt", (variant) => {
    const path = join(tempDir, `receipt-${variant.replaceAll(" ", "-")}.json`);
    const bundle = proof();
    const first = migrateLegacyTargets({
      bundle,
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    if (!first.receiptPath) throw new Error("expected receipt path");
    rmSync(first.receiptPath);
    if (variant === "directory") mkdirSync(first.receiptPath);
    if (variant === "array") writeFileSync(first.receiptPath, "[]");
    if (variant === "wrong target") {
      writeFileSync(
        first.receiptPath,
        JSON.stringify({
          path: "/other",
          targetPathHash: "wrong",
          outcome: "removed",
          reason: "x",
        }),
      );
    }
    if (variant === "malformed JSON") writeFileSync(first.receiptPath, "{");

    expect(
      migrateLegacyTargets({
        bundle,
        targets: [jsonTarget(path)],
        backupRoot,
        allowRemoval: true,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "preserved_ambiguous",
        reason: "invalid_migration_receipt",
      }),
    ]);
  });

  it("returns an unchanged terminal ambiguity without reinterpreting edited content", () => {
    const path = join(tempDir, "foreign-repeat.json");
    writeFileSync(path, '{"mcpServers":{"dosu":{"url":"https://example.com/user"}}}');
    const bundle = proof();
    const first = migrateLegacyTargets({
      bundle,
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(first).toMatchObject({ outcome: "preserved_ambiguous", reason: "foreign_dosu_entry" });
    const second = migrateLegacyTargets({
      bundle,
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    expect(second).toMatchObject({ outcome: "preserved_ambiguous", reason: "foreign_dosu_entry" });
  });

  it("rejects a pending receipt missing its recovery authority", () => {
    const path = join(tempDir, "invalid-pending.json");
    const bundle = proof();
    const first = migrateLegacyTargets({
      bundle,
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    if (!first.receiptPath) throw new Error("expected receipt path");
    writeFileSync(
      first.receiptPath,
      JSON.stringify({ ...first, outcome: "pending", reason: "mutation_prepared" }),
    );
    expect(
      migrateLegacyTargets({
        bundle,
        targets: [jsonTarget(path)],
        backupRoot,
        allowRemoval: true,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "preserved_ambiguous",
        reason: "invalid_pending_receipt",
      }),
    ]);
  });

  it("does not finalize a pending after-state when its immutable backup is gone", () => {
    const path = join(tempDir, "pending-missing-backup.json");
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
        user: { url: "https://example.com" },
      },
    });
    writeFileSync(path, original);
    const bundle = proof();
    const removed = migrateLegacyTargets({
      bundle,
      targets: [jsonTarget(path)],
      backupRoot,
      allowRemoval: true,
    })[0];
    if (!removed.receiptPath || !removed.backupPath) throw new Error("expected recovery journal");
    writeFileSync(
      removed.receiptPath,
      JSON.stringify({ ...removed, outcome: "pending", reason: "mutation_prepared" }),
    );
    rmSync(removed.backupPath);

    expect(
      migrateLegacyTargets({
        bundle,
        targets: [jsonTarget(path)],
        backupRoot,
        allowRemoval: true,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "preserved_ambiguous",
        reason: "pending_backup_invalid",
      }),
    ]);
  });

  it("rejects invalid plans and source replacement before creating a backup", () => {
    const original = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep",
          headers: { "X-Dosu-API-Key": "secret" },
        },
      },
    });
    const plan = planLegacyJsonMcp({ content: original, provider: "claude", topKey: "mcpServers" });
    const bundle = proof();

    const invalidPath = join(tempDir, "invalid-plan.json");
    writeFileSync(invalidPath, original);
    expect(
      applyContentPlan({
        bundle,
        target: jsonTarget(invalidPath),
        plan: { ...plan, mutation: "write", nextContent: undefined },
        backupRoot: join(tempDir, "invalid-plan-backups"),
        allowRemoval: true,
      }),
    ).toMatchObject({ outcome: "preserved_ambiguous", reason: "invalid_migration_plan" });

    const directoryPath = join(tempDir, "replaced-by-directory.json");
    writeFileSync(directoryPath, original);
    rmSync(directoryPath);
    mkdirSync(directoryPath);
    expect(
      applyContentPlan({
        bundle,
        target: jsonTarget(directoryPath),
        plan,
        backupRoot: join(tempDir, "directory-backups"),
        allowRemoval: true,
      }),
    ).toMatchObject({ outcome: "concurrent_conflict", reason: "non_regular_target" });

    const missingPath = join(tempDir, "removed-before-apply.json");
    expect(
      applyContentPlan({
        bundle,
        target: jsonTarget(missingPath),
        plan,
        backupRoot: join(tempDir, "missing-backups"),
        allowRemoval: true,
      }),
    ).toMatchObject({ outcome: "concurrent_conflict", reason: "target_changed_or_missing" });
  });
});
