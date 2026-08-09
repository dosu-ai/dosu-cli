import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectProof, type ProviderId, proveProjectScope } from "../migration";
import {
  finalizeGlobalMcpIntent,
  globalMcpIntentMarkerPath,
  prepareGlobalMcpIntent,
  releaseGlobalMcpIntent,
} from "../migration/global-intent";
import {
  inspectProjectScopeMigration,
  type ProjectScopeMigrationInput,
  runProjectScopeMigration,
} from "./project-scope-migration";

const INSTRUCTIONS = "Use Dosu.";
const SKILL = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
const RELEASED_RULE = readFileSync(join(process.cwd(), "rules", "dosu.md"), "utf8");
const PROXY_ARGS = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"];

let tempDir: string;
let homeDir: string;
let projectRoot: string;
let backupRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-project-scope-runner-"));
  homeDir = join(tempDir, "home");
  projectRoot = join(tempDir, "project");
  backupRoot = join(tempDir, "config", "migrations", "project-scope-v1");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

function projectProof(): ProjectProof {
  const result = proveProjectScope({
    cwd: projectRoot,
    gitTopLevel: projectRoot,
    insideWorkTree: true,
    bareRepository: false,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.proof;
}

function writeProjectSkill(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), SKILL);
  const computedHash = createHash("sha256").update("SKILL.md").update(SKILL).digest("hex");
  writeFileSync(
    join(projectRoot, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        dosu: {
          source: "dosu-ai/dosu-skill",
          sourceType: "github",
          skillPath: "skills/dosu/SKILL.md",
          computedHash,
        },
      },
    }),
  );
}

function writeProjectBundle(provider: "claude" | "gemini" | "antigravity" | "factory"): void {
  const proxy = { command: "npx", args: PROXY_ARGS };
  writeFileSync(
    join(projectRoot, "AGENTS.md"),
    `<!-- dosu:mcp:start v2 -->\n${INSTRUCTIONS}\n<!-- dosu:mcp:end -->\n`,
  );

  if (provider === "claude") {
    writeFileSync(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { dosu: { type: "stdio", ...proxy } } }),
    );
    writeFileSync(
      join(projectRoot, "CLAUDE.md"),
      "<!-- dosu:project-instructions:start v1 -->\n@AGENTS.md\n<!-- dosu:project-instructions:end -->\n",
    );
    writeProjectSkill(join(projectRoot, ".claude", "skills", "dosu"));
    return;
  }

  if (provider === "gemini") {
    mkdirSync(join(projectRoot, ".gemini"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { dosu: proxy } }),
    );
    writeFileSync(
      join(projectRoot, "GEMINI.md"),
      "<!-- dosu:project-instructions:start v1 -->\n@AGENTS.md\n<!-- dosu:project-instructions:end -->\n",
    );
  } else if (provider === "antigravity") {
    mkdirSync(join(projectRoot, ".agents", "rules"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".agents", "mcp_config.json"),
      JSON.stringify({ mcpServers: { dosu: proxy } }),
    );
    writeFileSync(
      join(projectRoot, ".agents", "rules", "dosu.md"),
      `<!-- dosu:project-instructions:start v1 -->\n${INSTRUCTIONS}\n<!-- dosu:project-instructions:end -->\n`,
    );
  } else {
    mkdirSync(join(projectRoot, ".factory"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".factory", "mcp.json"),
      JSON.stringify({ mcpServers: { dosu: { type: "stdio", ...proxy } } }),
    );
    writeProjectSkill(join(projectRoot, ".factory", "skills", "dosu"));
    return;
  }
  writeProjectSkill(join(projectRoot, ".agents", "skills", "dosu"));
}

function input(
  provider: "claude" | "gemini" | "antigravity" | "factory" = "claude",
): ProjectScopeMigrationInput {
  writeProjectBundle(provider);
  return {
    project: projectProof(),
    providerIDs: [provider],
    proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
    instructionContent: INSTRUCTIONS,
    environment: { platform: "linux", homeDir, env: {} },
    backupRoot,
    globalIntentRoot: join(tempDir, "config", "migrations", "global-mcp-intent-v1"),
  };
}

function writeOwnedGlobalMcp(provider: ProviderId, path: string): string {
  const secret = "global-secret-must-never-appear-in-summary";
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://api.dosu.dev/v1/mcp/deployments/dep-old",
          headers: { "X-Dosu-API-Key": secret },
        },
        user: { url: `https://example.com/${provider}` },
      },
    }),
  );
  return secret;
}

describe("project-scope migration runner", () => {
  it("creates durable not-found tombstones for a new user and is idempotent", () => {
    const migration = input();
    const inspection = inspectProjectScopeMigration(migration);
    expect(inspection).toMatchObject({ ok: true, needsRuntimeVerification: false });
    expect(existsSync(backupRoot)).toBe(false);

    const first = runProjectScopeMigration({ ...migration, runtimeVerified: false });
    expect(first).toMatchObject({
      ok: true,
      cleanupAttempted: true,
      counts: { removed: 0, not_found: 2, preserved: 0, failed: 0, total: 2 },
    });
    expect(existsSync(backupRoot)).toBe(true);

    const second = runProjectScopeMigration({ ...migration, runtimeVerified: false });
    expect(second).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 2, preserved: 0, failed: 0, total: 2 },
    });
  });

  it("keeps an exact legacy target when runtime was not verified", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    const secret = writeOwnedGlobalMcp("claude", globalPath);
    const before = readFileSync(globalPath, "utf8");

    expect(inspectProjectScopeMigration(migration)).toMatchObject({
      ok: true,
      needsRuntimeVerification: true,
    });
    const result = runProjectScopeMigration({ ...migration, runtimeVerified: false });
    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 1, preserved: 1, failed: 0, total: 2 },
    });
    expect(readFileSync(globalPath, "utf8")).toBe(before);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("removes a markerless v0.43 legacy global entry after runtime verification", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    const secret = writeOwnedGlobalMcp("claude", globalPath);

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 1, not_found: 1, preserved: 0, failed: 0, total: 2 },
      receiptRoot: backupRoot,
    });
    const remaining = readFileSync(globalPath, "utf8");
    expect(remaining).toContain("https://example.com/claude");
    expect(remaining).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);

    const second = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(second).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 2, preserved: 0, failed: 0, total: 2 },
    });
  });

  it("preserves the first explicit global opt-in on later project setup", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    const pending = prepareGlobalMcpIntent({
      provider: "claude",
      targetPath: globalPath,
      intentRoot: migration.globalIntentRoot,
    });
    const secret = writeOwnedGlobalMcp("claude", globalPath);
    finalizeGlobalMcpIntent(pending);

    expect(inspectProjectScopeMigration(migration)).toMatchObject({
      ok: true,
      needsRuntimeVerification: false,
    });
    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(result).toMatchObject({ ok: true, counts: { removed: 0, preserved: 1, total: 2 } });
    expect(readFileSync(globalPath, "utf8")).toContain(secret);
    expect(result.warnings.join("\n")).toContain("explicit global MCP");
  });

  it.each([
    "pending",
    "installed",
    "tampered",
  ] as const)("preserves a concurrent %s explicit-global intent created after the initial partition", (markerState) => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    const secret = writeOwnedGlobalMcp("claude", globalPath);
    const before = readFileSync(globalPath, "utf8");
    let injected = false;
    let pendingIntent: ReturnType<typeof prepareGlobalMcpIntent> | undefined;

    const result = runProjectScopeMigration({
      ...migration,
      runtimeVerified: true,
      _testHooks: {
        afterExplicitGlobalIntentPartition: () => {
          if (injected) return;
          injected = true;
          const pending = prepareGlobalMcpIntent({
            provider: "claude",
            targetPath: globalPath,
            intentRoot: migration.globalIntentRoot,
          });
          pendingIntent = pending;
          if (markerState === "installed") finalizeGlobalMcpIntent(pending);
          if (markerState === "tampered") {
            writeFileSync(pending.markerPath, "not-json");
            releaseGlobalMcpIntent(pending);
          }
        },
      },
    });

    expect(injected).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 1, preserved: 1, failed: 0, total: 2 },
    });
    expect(readFileSync(globalPath, "utf8")).toBe(before);
    expect(readFileSync(globalPath, "utf8")).toContain(secret);
    expect(result.warnings.join("\n")).toContain("explicit global MCP");
    if (markerState === "pending" && pendingIntent) releaseGlobalMcpIntent(pendingIntent);
  });

  it("restores the target when a pending marker appears after final authorization but before capture", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    const secret = writeOwnedGlobalMcp("claude", globalPath);
    const before = readFileSync(globalPath, "utf8");

    const result = runProjectScopeMigration({
      ...migration,
      runtimeVerified: true,
      _testHooks: {
        beforeLegacyTargetCapture: () => {
          mkdirSync(migration.globalIntentRoot as string, { recursive: true });
          const markerPath = globalMcpIntentMarkerPath({
            provider: "claude",
            targetPath: globalPath,
            intentRoot: migration.globalIntentRoot,
          });
          writeFileSync(
            markerPath,
            `${JSON.stringify({
              version: 1,
              state: "pending",
              provider: "claude",
              targetPath: globalPath,
              nonce: "a".repeat(32),
            })}\n`,
          );
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 1, preserved: 1, failed: 0, total: 2 },
    });
    expect(readFileSync(globalPath, "utf8")).toBe(before);
    expect(readFileSync(globalPath, "utf8")).toContain(secret);
    expect(result.warnings.join("\n")).toContain("global_intent_pending");
    expect(
      readdirSync(homeDir).filter((name) => name.startsWith(".dosu-migration-capture-")),
    ).toHaveLength(0);
  });

  it("preserves a shared canonical target when another provider recorded the opt-in", () => {
    const migration = input();
    const sharedGlobalPath = join(homeDir, ".claude.json");
    const pending = prepareGlobalMcpIntent({
      provider: "copilot",
      targetPath: sharedGlobalPath,
      intentRoot: migration.globalIntentRoot,
    });
    writeOwnedGlobalMcp("claude", sharedGlobalPath);
    finalizeGlobalMcpIntent(pending);

    const before = readFileSync(sharedGlobalPath, "utf8");
    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(result).toMatchObject({ ok: true, counts: { removed: 0, preserved: 1, total: 2 } });
    expect(readFileSync(sharedGlobalPath, "utf8")).toBe(before);
  });

  it.each([
    "damaged",
    "symlinked",
  ])("fails closed when the explicit global intent marker is %s", (markerState) => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    writeOwnedGlobalMcp("claude", globalPath);
    const pending = prepareGlobalMcpIntent({
      provider: "claude",
      targetPath: globalPath,
      intentRoot: migration.globalIntentRoot,
    });
    if (markerState === "damaged") {
      writeFileSync(pending.markerPath, "not-json");
    } else {
      rmSync(pending.markerPath);
      symlinkSync(join(tempDir, "foreign-marker"), pending.markerPath);
    }

    const before = readFileSync(globalPath, "utf8");
    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(result).toMatchObject({ ok: true, counts: { removed: 0, preserved: 1, total: 2 } });
    expect(readFileSync(globalPath, "utf8")).toBe(before);
  });

  it("fails closed when global config changed after explicit intent was recorded", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    writeOwnedGlobalMcp("claude", globalPath);
    const pending = prepareGlobalMcpIntent({
      provider: "claude",
      targetPath: globalPath,
      intentRoot: migration.globalIntentRoot,
    });
    finalizeGlobalMcpIntent(pending);
    const changed = JSON.parse(readFileSync(globalPath, "utf8"));
    changed.userChangedAfterInstall = true;
    writeFileSync(globalPath, JSON.stringify(changed));

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(result).toMatchObject({ ok: true, counts: { removed: 0, preserved: 1, total: 2 } });
    expect(JSON.parse(readFileSync(globalPath, "utf8")).userChangedAfterInstall).toBe(true);
    expect(result.warnings.join("\n")).toContain("global_intent_content_changed");
  });

  it("migrates Factory MCP", () => {
    const migration = input("factory");
    const globalMcpPath = join(homeDir, ".factory", "mcp.json");
    const secret = writeOwnedGlobalMcp("factory", globalMcpPath);

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 1, not_found: 0, preserved: 0, failed: 0, total: 1 },
    });
    expect(readFileSync(globalMcpPath, "utf8")).not.toContain(secret);
  });

  it("never touches an indistinguishable legacy global skill", () => {
    const migration = input();
    const skillPath = join(homeDir, ".agents", "skills", "dosu", "SKILL.md");
    const lockPath = join(homeDir, ".agents", ".skill-lock.json");
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "user explicitly requested this global Dosu skill\n");
    writeFileSync(lockPath, '{"version":3,"skills":{"dosu":{"source":"dosu-ai/dosu-skill"}}}\n');
    const skillBefore = readFileSync(skillPath, "utf8");
    const lockBefore = readFileSync(lockPath, "utf8");

    runProjectScopeMigration({ ...migration, runtimeVerified: true });

    expect(readFileSync(skillPath, "utf8")).toBe(skillBefore);
    expect(readFileSync(lockPath, "utf8")).toBe(lockBefore);
  });

  it("fails before any cleanup when the project bundle no longer matches", () => {
    const migration = input();
    const globalPath = join(homeDir, ".claude.json");
    writeOwnedGlobalMcp("claude", globalPath);
    const before = readFileSync(globalPath, "utf8");
    writeFileSync(join(projectRoot, ".mcp.json"), '{"mcpServers":{}}');

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(result).toMatchObject({
      ok: false,
      cleanupAttempted: false,
      reason: "project_mcp_mismatch",
      counts: { total: 0 },
    });
    expect(readFileSync(globalPath, "utf8")).toBe(before);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("preserves the shared Gemini rule when an unselected Antigravity target is ambiguous", () => {
    const migration = input("gemini");
    const antigravityPath = join(homeDir, ".gemini", "antigravity", "mcp_config.json");
    mkdirSync(join(antigravityPath, ".."), { recursive: true });
    writeFileSync(
      antigravityPath,
      '{"mcpServers":{"dosu":{"url":"https://example.com/user-owned"}}}',
    );
    const sharedRulePath = join(homeDir, ".gemini", "GEMINI.md");
    writeFileSync(sharedRulePath, "<!-- dosu:rules:start v1 -->\nowned\n<!-- dosu:rules:end -->\n");

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 0, not_found: 1, preserved: 2, failed: 0, total: 3 },
    });
    expect(readFileSync(sharedRulePath, "utf8")).toContain("dosu:rules:start");
    expect(readFileSync(antigravityPath, "utf8")).toContain("user-owned");
  });

  it("removes the shared Gemini rule when the counterpart MCP target is strictly absent", () => {
    const migration = input("gemini");
    const sharedRulePath = join(homeDir, ".gemini", "GEMINI.md");
    mkdirSync(join(sharedRulePath, ".."), { recursive: true });
    writeFileSync(
      sharedRulePath,
      `<!-- dosu:rules:start v1 -->\n${RELEASED_RULE.trimEnd()}\n<!-- dosu:rules:end -->\n`,
    );

    expect(inspectProjectScopeMigration(migration)).toMatchObject({
      ok: true,
      needsRuntimeVerification: true,
    });
    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(result).toMatchObject({
      ok: true,
      counts: { removed: 1, not_found: 1, preserved: 0, failed: 0, total: 2 },
    });
    expect(existsSync(sharedRulePath)).toBe(false);
  });

  it("uses the versioned private config receipt root by default and rejects relative overrides", () => {
    const migration = input();
    delete migration.backupRoot;
    const xdgConfig = join(tempDir, "xdg-config");
    vi.stubEnv("XDG_CONFIG_HOME", xdgConfig);

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: false });
    expect(result).toMatchObject({
      ok: true,
      receiptRoot: join(xdgConfig, "dosu-cli", "migrations", "project-scope-v1"),
    });

    const unsafe = runProjectScopeMigration({
      ...migration,
      backupRoot: "relative-receipts",
      runtimeVerified: true,
    });
    expect(unsafe).toMatchObject({
      ok: false,
      cleanupAttempted: false,
      reason: "unsafe_backup_root",
    });
    expect(
      inspectProjectScopeMigration({ ...migration, backupRoot: "relative-receipts" }),
    ).toMatchObject({ ok: false, reason: "unsafe_backup_root" });
  });

  it("fails closed on an unsupported runtime platform when no environment was injected", () => {
    const migration = input();
    delete migration.environment;
    vi.spyOn(process, "platform", "get").mockReturnValue("freebsd" as NodeJS.Platform);

    expect(inspectProjectScopeMigration(migration)).toMatchObject({
      ok: false,
      reason: "unsupported_platform",
    });
    expect(runProjectScopeMigration({ ...migration, runtimeVerified: true })).toMatchObject({
      ok: false,
      cleanupAttempted: false,
      reason: "unsupported_platform",
    });
  });

  it("preserves the shared Gemini rule for an unselected Gemini target seen by Antigravity setup", () => {
    const migration = input("antigravity");
    const geminiPath = join(homeDir, ".gemini", "settings.json");
    mkdirSync(join(geminiPath, ".."), { recursive: true });
    writeFileSync(geminiPath, '{"mcpServers":{"dosu":{"url":"https://example.com/user"}}}');
    const sharedRulePath = join(homeDir, ".gemini", "GEMINI.md");
    writeFileSync(
      sharedRulePath,
      "<!-- dosu:rules:start v1 -->\nuser edit\n<!-- dosu:rules:end -->\n",
    );

    const result = runProjectScopeMigration({ ...migration, runtimeVerified: true });
    expect(result).toMatchObject({ ok: true, counts: { preserved: 2 } });
    expect(readFileSync(sharedRulePath, "utf8")).toContain("user edit");
    expect(readFileSync(geminiPath, "utf8")).toContain("example.com/user");
  });
});
