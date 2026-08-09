import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  finalizeGlobalMcpIntent,
  globalMcpIntentMarkerPath,
  inspectGlobalMcpIntent,
  prepareGlobalMcpIntent,
  releaseGlobalMcpIntent,
} from "./global-intent";
import { acquireTargetOperationLock, releaseTargetOperationLock } from "./orchestrator";

let tempDir: string;
let intentRoot: string;
let targetPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-global-intent-"));
  intentRoot = join(tempDir, "private", "migrations", "global-mcp-intent-v1");
  targetPath = join(tempDir, "home", ".cursor", "mcp.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("explicit global MCP intent", () => {
  it("rejects invalid identities, relative paths, and a non-file marker before writing", () => {
    expect(() => globalMcpIntentMarkerPath({ provider: "Cursor", targetPath, intentRoot })).toThrow(
      "Invalid global MCP provider ID",
    );
    expect(() =>
      globalMcpIntentMarkerPath({ provider: "cursor", targetPath: "relative", intentRoot }),
    ).toThrow("Global MCP target path must be absolute");
    expect(() =>
      globalMcpIntentMarkerPath({ provider: "cursor", targetPath, intentRoot: "relative" }),
    ).toThrow("Global MCP intent root must be absolute");

    mkdirSync(intentRoot, { recursive: true });
    const markerPath = globalMcpIntentMarkerPath({ provider: "cursor", targetPath, intentRoot });
    mkdirSync(markerPath);

    expect(() => prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toThrow(
      "Unsafe global MCP intent marker",
    );
    expect(lstatSync(markerPath).isDirectory()).toBe(true);
  });

  it("durably records pending intent before the target changes, then binds installed content", () => {
    const pending = prepareGlobalMcpIntent({
      provider: "cursor",
      targetPath,
      intentRoot,
    });
    const pendingMarker = JSON.parse(readFileSync(pending.markerPath, "utf8"));
    expect(pendingMarker).toMatchObject({
      version: 1,
      state: "pending",
      provider: "cursor",
      targetPath,
    });
    expect(existsSync(`${targetPath}.dosu-migration.lock`)).toBe(true);

    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"one"}}}\n');
    finalizeGlobalMcpIntent(pending);

    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toEqual({
      status: "preserve",
      reason: "explicit_global_intent",
    });
    expect(existsSync(`${targetPath}.dosu-migration.lock`)).toBe(false);
  });

  it("shares target exclusion with migration and releases it while retaining failed intent", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    const migrationLock = acquireTargetOperationLock(targetPath, join(tempDir, "receipts"));
    expect(() => prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toThrow(
      "Global MCP target is locked",
    );
    expect(
      existsSync(globalMcpIntentMarkerPath({ provider: "cursor", targetPath, intentRoot })),
    ).toBe(false);
    releaseTargetOperationLock(migrationLock);

    const pending = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    expect(existsSync(pending.operationLock.path)).toBe(true);
    releaseGlobalMcpIntent(pending);
    expect(existsSync(pending.operationLock.path)).toBe(false);
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toEqual({
      status: "preserve",
      reason: "global_intent_pending",
    });
  });

  it("updates the content binding on an explicit reinstall", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    const first = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"one"}}}\n');
    finalizeGlobalMcpIntent(first);
    const markerPath = globalMcpIntentMarkerPath({ provider: "cursor", targetPath, intentRoot });
    const firstHash = JSON.parse(readFileSync(markerPath, "utf8")).contentHash;

    const second = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"two"}}}\n');
    finalizeGlobalMcpIntent(second);
    const secondHash = JSON.parse(readFileSync(markerPath, "utf8")).contentHash;

    expect(secondHash).not.toBe(firstHash);
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toEqual({
      status: "preserve",
      reason: "explicit_global_intent",
    });
  });

  it("prefers an exact marker and recognizes canonical intent shared across providers", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"shared"}}}\n');
    for (const provider of ["claude", "copilot", "cursor"]) {
      const pending = prepareGlobalMcpIntent({ provider, targetPath, intentRoot });
      finalizeGlobalMcpIntent(pending);
    }

    for (const provider of ["claude", "copilot", "cursor", "gemini"]) {
      expect(inspectGlobalMcpIntent({ provider, targetPath, intentRoot })).toEqual({
        status: "preserve",
        reason: "explicit_global_intent",
      });
    }
  });

  it("refuses to finalize a marker or target that changed after prepare", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"one"}}}\n');
    const changedMarker = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    const marker = JSON.parse(readFileSync(changedMarker.markerPath, "utf8"));
    writeFileSync(changedMarker.markerPath, `${JSON.stringify({ ...marker, unexpected: true })}\n`);

    expect(() => finalizeGlobalMcpIntent(changedMarker)).toThrow(
      "Global MCP intent marker changed during install",
    );
    expect(readFileSync(targetPath, "utf8")).toContain('"url":"one"');

    const directoryTarget = join(tempDir, "home", ".claude", "config.json");
    const nonRegularTarget = prepareGlobalMcpIntent({
      provider: "claude",
      targetPath: directoryTarget,
      intentRoot,
    });
    mkdirSync(directoryTarget, { recursive: true });

    expect(() => finalizeGlobalMcpIntent(nonRegularTarget)).toThrow(
      "Global MCP install target is not a regular file",
    );
    expect(lstatSync(directoryTarget).isDirectory()).toBe(true);
  });

  it("fails closed for invalid inputs, unsafe roots, and an empty marker inventory", () => {
    expect(inspectGlobalMcpIntent({ provider: "Cursor", targetPath, intentRoot })).toEqual({
      status: "preserve",
      reason: "global_intent_unsafe",
    });

    const unsafeRoot = join(tempDir, "intent-root-file");
    writeFileSync(unsafeRoot, "do not replace");
    expect(
      inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot: unsafeRoot }),
    ).toEqual({ status: "preserve", reason: "global_intent_unsafe" });
    expect(readFileSync(unsafeRoot, "utf8")).toBe("do not replace");

    mkdirSync(intentRoot, { recursive: true });
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toEqual({
      status: "absent",
    });
  });

  it("fails closed for invalid installed markers and missing or non-regular targets", () => {
    mkdirSync(intentRoot, { recursive: true });
    const hash = "0".repeat(64);
    const writeInstalledMarker = (
      provider: string,
      target: string,
      extra: Record<string, unknown> = {},
    ) => {
      const markerPath = globalMcpIntentMarkerPath({ provider, targetPath: target, intentRoot });
      writeFileSync(
        markerPath,
        `${JSON.stringify({
          version: 1,
          state: "installed",
          provider,
          targetPath: target,
          contentHash: hash,
          ...extra,
        })}\n`,
      );
    };

    const invalidTarget = join(tempDir, "invalid-target.json");
    writeInstalledMarker("cursor", invalidTarget, { unexpected: true });
    expect(
      inspectGlobalMcpIntent({ provider: "cursor", targetPath: invalidTarget, intentRoot }),
    ).toEqual({ status: "preserve", reason: "global_intent_invalid" });

    const directoryTarget = join(tempDir, "directory-target");
    mkdirSync(directoryTarget);
    writeInstalledMarker("claude", directoryTarget);
    expect(
      inspectGlobalMcpIntent({ provider: "claude", targetPath: directoryTarget, intentRoot }),
    ).toEqual({ status: "preserve", reason: "global_intent_content_changed" });

    const missingTarget = join(tempDir, "missing-target.json");
    writeInstalledMarker("gemini", missingTarget);
    expect(
      inspectGlobalMcpIntent({ provider: "gemini", targetPath: missingTarget, intentRoot }),
    ).toEqual({ status: "preserve", reason: "global_intent_content_changed" });
  });

  it("rejects a marker replaced by a symlink between prepare and finalize", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"one"}}}\n');
    const pending = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    const pendingContent = readFileSync(pending.markerPath, "utf8");
    const foreignMarker = join(tempDir, "foreign-pending-marker");
    writeFileSync(foreignMarker, pendingContent);
    rmSync(pending.markerPath);
    symlinkSync(foreignMarker, pending.markerPath);

    expect(() => finalizeGlobalMcpIntent(pending)).toThrow(/regular|unsafe/i);
    expect(readFileSync(foreignMarker, "utf8")).toBe(pendingContent);
  });

  it("fails closed for pending, damaged, symlinked, and content-mismatched markers", () => {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"one"}}}\n');
    const pending = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toMatchObject({
      status: "preserve",
    });

    writeFileSync(pending.markerPath, "not-json");
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toMatchObject({
      status: "preserve",
    });

    rmSync(pending.markerPath);
    symlinkSync(join(tempDir, "foreign-marker"), pending.markerPath);
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toMatchObject({
      status: "preserve",
    });

    rmSync(pending.markerPath);
    releaseGlobalMcpIntent(pending);
    const installed = prepareGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot });
    finalizeGlobalMcpIntent(installed);
    writeFileSync(targetPath, '{"mcpServers":{"dosu":{"url":"changed"}}}\n');
    expect(inspectGlobalMcpIntent({ provider: "cursor", targetPath, intentRoot })).toEqual({
      status: "preserve",
      reason: "global_intent_content_changed",
    });
  });
});
