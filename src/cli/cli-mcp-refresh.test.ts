import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configuredProviders: vi.fn(),
  refreshConfiguredProviders: vi.fn(),
  writeMcpRefreshCache: vi.fn(),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));
vi.mock("../version/update-check", () => ({ checkForUpdates: vi.fn() }));
vi.mock("../version/skill-update-check", () => ({ checkForSkillUpdates: vi.fn() }));
vi.mock("../version/pending-tasks-check", () => ({ checkForReadyTasks: vi.fn() }));
vi.mock("../version/mcp-refresh-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/mcp-refresh-check")>()),
  checkForMcpRefresh: vi.fn(),
  writeMcpRefreshCache: mocks.writeMcpRefreshCache,
}));
vi.mock("../mcp/refresh", () => ({
  configuredProviders: mocks.configuredProviders,
  refreshConfiguredProviders: mocks.refreshConfiguredProviders,
}));

import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { SetupProvider } from "../mcp/providers";
import { VERSION } from "../version/version";
import { createProgram } from "./cli";

function named(name: string): SetupProvider {
  return { name: () => name } as unknown as SetupProvider;
}

async function runMcpRefresh(): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  await program.parseAsync(["node", "dosu", "mcp", "refresh"]);
}

let tempDir: string;
let origXDG: string | undefined;
let originalExitCode: typeof process.exitCode;
let logSpy: ReturnType<typeof vi.spyOn>;

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

beforeEach(() => {
  origXDG = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-cli-mcp-refresh-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.resetAllMocks();
  mocks.configuredProviders.mockReturnValue([named("Cursor")]);
  mocks.refreshConfiguredProviders.mockReturnValue({ updated: [named("Cursor")], failed: [] });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  if (origXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG;
  process.exitCode = originalExitCode;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("dosu mcp refresh", () => {
  it("refuses when Dosu is not set up", async () => {
    saveConfig(makeTestConfig({ access_token: "tok", refresh_token: "ref", expires_at: 0 }));

    await expect(runMcpRefresh()).rejects.toThrow(/not set up/);
    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
  });

  it("explains when no tool has Dosu configured", async () => {
    saveConfig(signedIn());
    mocks.configuredProviders.mockReturnValue([]);

    await runMcpRefresh();

    expect(output()).toContain("No AI tools with Dosu configured");
    expect(mocks.refreshConfiguredProviders).not.toHaveBeenCalled();
    expect(mocks.writeMcpRefreshCache).not.toHaveBeenCalled();
  });

  it("rewrites every configured tool and records the version", async () => {
    saveConfig(signedIn());
    mocks.refreshConfiguredProviders.mockReturnValue({
      updated: [named("Cursor"), named("Claude Code")],
      failed: [],
    });

    await runMcpRefresh();

    const cfg = mocks.refreshConfiguredProviders.mock.calls[0][0];
    expect(cfg.active_account?.target?.api_key).toBe("key-1");
    expect(mocks.writeMcpRefreshCache).toHaveBeenCalledWith({ version: VERSION });
    expect(output()).toContain("✓ Cursor");
    expect(output()).toContain("✓ Claude Code");
    expect(output()).toContain("Restart your AI agents");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports failures per tool and exits non-zero", async () => {
    saveConfig(signedIn());
    mocks.refreshConfiguredProviders.mockReturnValue({
      updated: [named("Cursor")],
      failed: [{ provider: named("Codex"), error: new Error("read-only file") }],
    });

    await runMcpRefresh();

    expect(output()).toContain("✓ Cursor");
    expect(output()).toContain("✗ Codex: read-only file");
    expect(process.exitCode).toBe(1);
  });
});

function signedIn() {
  return makeTestConfig({
    access_token: "tok",
    refresh_token: "ref",
    expires_at: 0,
    deployment_id: "dep-1",
    api_key: "key-1",
  });
}
