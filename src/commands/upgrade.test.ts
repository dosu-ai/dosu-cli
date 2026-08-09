import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { buildNpmInvocation, runUpgrade } from "./upgrade";

const mockSpawnSync = vi.mocked(spawnSync);
let tempDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function makeEntrypoint(root: string): string {
  const entrypoint = join(root, "@dosu", "cli", "bin", "dosu.js");
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "");
  return entrypoint;
}

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function errors(): string {
  return errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-upgrade-test-"));
  mockSpawnSync.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runUpgrade", () => {
  it("updates a confirmed global npm installation with fixed arguments", () => {
    const globalRoot = join(tempDir, "global", "node_modules");
    const entrypoint = makeEntrypoint(globalRoot);
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: `${globalRoot}\n` } as never)
      .mockReturnValueOnce({ status: 0 } as never);

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(mockSpawnSync).toHaveBeenNthCalledWith(1, "npm", ["root", "-g"], {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(2, "npm", ["install", "-g", "@dosu/cli@latest"], {
      shell: false,
      stdio: "inherit",
    });
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with npm");
    expect(output()).toContain("npm install -g @dosu/cli@latest");
    expect(output()).toContain("Update command completed");
  });

  it("delegates a Homebrew installation to brew", () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 } as never);

    const status = runUpgrade("homebrew", { platform: "darwin" });

    expect(mockSpawnSync).toHaveBeenCalledWith("brew", ["upgrade", "dosu-ai/dosu/dosu"], {
      shell: false,
      stdio: "inherit",
    });
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with Homebrew");
    expect(output()).toContain("brew upgrade dosu-ai/dosu/dosu");
  });

  it("does not turn an npx or local npm invocation into a global install", () => {
    const globalRoot = join(tempDir, "global", "node_modules");
    const entrypoint = makeEntrypoint(join(tempDir, "npx", "node_modules"));
    mockSpawnSync.mockReturnValueOnce({ status: 0, stdout: `${globalRoot}\n` } as never);

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(status).toBe(1);
    expect(output()).toContain("npx -y @dosu/cli@latest");
    expect(output()).toContain("npm install -g @dosu/cli@latest");
  });

  it("does not inspect or install global packages during an npx run", () => {
    const status = runUpgrade("npm", {
      entrypoint: "/tmp/npm-cache/node_modules/@dosu/cli/bin/dosu.js",
      platform: "darwin",
      env: { npm_lifecycle_event: "npx" },
    });

    expect(status).toBe(1);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(output()).toContain("npx -y @dosu/cli@latest");
  });

  it("preserves a package-manager failure and shows the same manual command", () => {
    mockSpawnSync.mockReturnValueOnce({ status: 7 } as never);

    const status = runUpgrade("homebrew", { platform: "darwin" });

    expect(status).toBe(7);
    expect(errors()).toContain("Could not update Dosu automatically");
    expect(errors()).toContain("brew upgrade dosu-ai/dosu/dosu");
    expect(errors()).not.toContain("npm install");
  });

  it("handles a missing package manager without claiming success", () => {
    mockSpawnSync.mockReturnValueOnce({
      error: Object.assign(new Error("spawn brew ENOENT"), { code: "ENOENT" }),
      status: null,
    } as never);

    const status = runUpgrade("homebrew", { platform: "darwin" });

    expect(status).toBe(1);
    expect(errors()).toContain("Could not update Dosu automatically");
    expect(errors()).toContain("brew upgrade dosu-ai/dosu/dosu");
  });

  it("fails closed for standalone and unknown channels", () => {
    expect(runUpgrade("binary")).toBe(1);
    expect(runUpgrade("unexpected")).toBe(1);

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(output()).toContain("github.com/dosu-ai/dosu-cli/releases/latest");
  });

  it("uses a fixed cmd.exe command on Windows instead of shell mode", () => {
    const env = { Path: "C:\\Program Files\\nodejs", TEMP: "C:\\Temp" };
    expect(buildNpmInvocation("root", "win32", "C:\\Windows\\System32\\cmd.exe", env)).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm root -g"],
      env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" },
    });
    expect(buildNpmInvocation("install", "win32", "C:\\Windows\\System32\\cmd.exe", env)).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm install -g @dosu/cli@latest"],
      env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" },
    });
    expect(
      buildNpmInvocation("root", "win32", "cmd.exe", { SystemRoot: "D:\\Windows" }).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
  });
});
