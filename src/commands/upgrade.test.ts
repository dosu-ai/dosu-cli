import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

import { buildPackageManagerInvocation, runUpgrade, upgradeCommand } from "./upgrade";

const mockSpawnSync = vi.mocked(spawnSync);
const mockRealpathSync = vi.mocked(realpathSync);
const PNPM_LOCATE_COMMAND = "pnpm list -g --depth=0 --parseable @dosu/cli";
let tempDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalNpmCommand: string | undefined;
let originalNpmLifecycleEvent: string | undefined;

interface MockResult {
  status: number | null;
  stdout?: string;
  error?: Error;
}

function makeEntrypoint(packageRoot: string): string {
  const entrypoint = join(packageRoot, "bin", "dosu.js");
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "");
  return entrypoint;
}

function npmPackageRoot(modulesRoot: string): string {
  return join(modulesRoot, "@dosu", "cli");
}

function yarnPackageRoot(globalDir: string): string {
  return join(globalDir, "node_modules", "@dosu", "cli");
}

function pnpmOutput(packageRoot?: string): string {
  return packageRoot ? `${join(tempDir, "pnpm", "global-project")}\n${packageRoot}\n` : "";
}

function hardenedEnv(env: Record<string, string> = {}): Record<string, string> {
  return {
    ...env,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    YARN_IGNORE_PATH: "1",
  };
}

function mockCommands(responses: Record<string, MockResult>): void {
  mockSpawnSync.mockImplementation((command, args) => {
    const commandArgs = Array.isArray(args) ? args : [];
    const key = [String(command), ...commandArgs].join(" ");
    return (responses[key] ?? { status: 127, stdout: "" }) as never;
  });
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
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalNpmCommand = process.env.npm_command;
  originalNpmLifecycleEvent = process.env.npm_lifecycle_event;
  delete process.env.npm_command;
  delete process.env.npm_lifecycle_event;
  process.exitCode = undefined;
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalNpmCommand === undefined) delete process.env.npm_command;
  else process.env.npm_command = originalNpmCommand;
  if (originalNpmLifecycleEvent === undefined) delete process.env.npm_lifecycle_event;
  else process.env.npm_lifecycle_event = originalNpmLifecycleEvent;
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runUpgrade", () => {
  it("updates a confirmed global npm installation with fixed arguments", () => {
    const npmRoot = join(tempDir, "npm", "node_modules");
    const entrypoint = makeEntrypoint(npmPackageRoot(npmRoot));
    const neutralCwd = join(tempDir, "neutral");
    const env = { PATH: "/trusted/bin" };
    const safeEnv = hardenedEnv(env);
    mkdirSync(neutralCwd);
    mockCommands({
      "npm root -g": { status: 0, stdout: `${npmRoot}\n` },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "" },
      "yarn --silent global dir": { status: 1, stdout: "" },
      "npm install -g @dosu/cli@latest": { status: 0 },
    });

    const status = runUpgrade("npm", {
      entrypoint,
      platform: "darwin",
      cwd: neutralCwd,
      env,
    });

    expect(mockSpawnSync).toHaveBeenCalledWith("npm", ["install", "-g", "@dosu/cli@latest"], {
      cwd: neutralCwd,
      env: safeEnv,
      shell: false,
      stdio: "inherit",
    });
    expect(mockSpawnSync).toHaveBeenCalledWith("yarn", ["--silent", "global", "dir"], {
      cwd: neutralCwd,
      encoding: "utf8",
      env: safeEnv,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with npm");
    expect(output()).toContain("npm install -g @dosu/cli@latest");
    expect(output()).toContain("Update command completed");
  });

  it("updates a confirmed global pnpm installation without switching managers", () => {
    const packageRoot = join(tempDir, "pnpm", "global-project", "node_modules", "@dosu", "cli");
    const entrypoint = makeEntrypoint(packageRoot);
    mockCommands({
      "npm root -g": { status: 1, stdout: "" },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: pnpmOutput(packageRoot) },
      "yarn --silent global dir": { status: 1, stdout: "" },
      "pnpm add -g @dosu/cli@latest": { status: 0 },
    });

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(mockSpawnSync).toHaveBeenCalledWith("pnpm", ["add", "-g", "@dosu/cli@latest"], {
      cwd: homedir(),
      env: hardenedEnv(),
      shell: false,
      stdio: "inherit",
    });
    expect(mockSpawnSync).not.toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@dosu/cli@latest"],
      expect.anything(),
    );
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with pnpm");
  });

  it("recognizes a pnpm package symlink by its real package path", () => {
    const storeRoot = join(
      tempDir,
      "pnpm",
      "store",
      "node_modules",
      ".pnpm",
      "@dosu+cli@0.44.0",
      "node_modules",
      "@dosu",
      "cli",
    );
    const entrypoint = makeEntrypoint(storeRoot);
    const linkedRoot = join(tempDir, "pnpm", "global-project", "node_modules", "@dosu", "cli");
    mkdirSync(dirname(linkedRoot), { recursive: true });
    symlinkSync(storeRoot, linkedRoot, "dir");
    mockCommands({
      "npm root -g": { status: 1, stdout: "" },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: pnpmOutput(linkedRoot) },
      "yarn --silent global dir": { status: 1, stdout: "" },
      "pnpm add -g @dosu/cli@latest": { status: 0 },
    });

    expect(runUpgrade("npm", { entrypoint, platform: "darwin", env: {} })).toBe(0);
    expect(mockSpawnSync).toHaveBeenLastCalledWith("pnpm", ["add", "-g", "@dosu/cli@latest"], {
      cwd: homedir(),
      env: hardenedEnv(),
      shell: false,
      stdio: "inherit",
    });
  });

  it("updates a confirmed global Yarn Classic installation without switching managers", () => {
    const globalDir = join(tempDir, "yarn", "global");
    const entrypoint = makeEntrypoint(yarnPackageRoot(globalDir));
    mockCommands({
      "npm root -g": { status: 1, stdout: "" },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "" },
      "yarn --silent global dir": { status: 0, stdout: `${globalDir}\n` },
      "yarn global add @dosu/cli@latest": { status: 0 },
    });

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(mockSpawnSync).toHaveBeenCalledWith("yarn", ["global", "add", "@dosu/cli@latest"], {
      cwd: homedir(),
      env: hardenedEnv(),
      shell: false,
      stdio: "inherit",
    });
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with Yarn Classic");
  });

  it("rejects a local entrypoint even when a global package exists", () => {
    const npmRoot = join(tempDir, "npm", "node_modules");
    makeEntrypoint(npmPackageRoot(npmRoot));
    const localEntrypoint = makeEntrypoint(
      join(tempDir, "project", "node_modules", "@dosu", "cli"),
    );
    mockCommands({
      "npm root -g": { status: 0, stdout: `${npmRoot}\n` },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "" },
      "yarn --silent global dir": { status: 1, stdout: "" },
    });

    const status = runUpgrade("npm", {
      entrypoint: localEntrypoint,
      platform: "darwin",
      env: {},
    });

    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(status).toBe(1);
    expect(output()).toContain("not a uniquely identified global package installation");
    expect(output()).toContain("pnpm add -g @dosu/cli@latest");
    expect(output()).toContain("yarn global add @dosu/cli@latest");
  });

  it("fails closed when more than one manager claims the same installation", () => {
    const npmRoot = join(tempDir, "shared", "node_modules");
    const packageRoot = npmPackageRoot(npmRoot);
    const entrypoint = makeEntrypoint(packageRoot);
    mockCommands({
      "npm root -g": { status: 0, stdout: `${npmRoot}\n` },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: pnpmOutput(packageRoot) },
      "yarn --silent global dir": { status: 1, stdout: "" },
    });

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(status).toBe(1);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(output()).toContain("not a uniquely identified global package installation");
  });

  it("fails closed when package-manager ownership cannot be queried", () => {
    const entrypoint = makeEntrypoint(join(tempDir, "unknown", "@dosu", "cli"));
    mockCommands({
      "npm root -g": { status: 1, stdout: "/untrusted\n" },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "not-a-package-path\n" },
      "yarn --silent global dir": { status: 0, stdout: "\n" },
    });

    const status = runUpgrade("npm", { entrypoint, platform: "darwin", env: {} });

    expect(status).toBe(1);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(output()).toContain("not a uniquely identified global package installation");
  });

  it("fails closed without probing when the running entrypoint has disappeared", () => {
    const status = runUpgrade("npm", {
      entrypoint: join(tempDir, "missing", "bin", "dosu.js"),
      platform: "darwin",
      env: {},
    });

    expect(status).toBe(1);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(output()).toContain("not a uniquely identified global package installation");
  });

  it("fails closed without probing when no running entrypoint is available", () => {
    process.argv = [process.execPath];

    expect(runUpgrade("npm", { platform: "darwin", env: {} })).toBe(1);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(output()).toContain("not a uniquely identified global package installation");
  });

  it("ignores a manager package path that no longer exists", () => {
    const entrypoint = makeEntrypoint(join(tempDir, "cache", "@dosu", "cli"));
    const missingNpmRoot = join(tempDir, "removed", "node_modules");
    mockCommands({
      "npm root -g": { status: 0, stdout: `${missingNpmRoot}\n` },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "" },
      "yarn --silent global dir": { status: 1, stdout: "" },
    });

    expect(runUpgrade("npm", { entrypoint, platform: "darwin", env: {} })).toBe(1);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(output()).toContain("not a uniquely identified global package installation");
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

  it("delegates a Homebrew installation to brew", () => {
    mockCommands({ "brew upgrade dosu-ai/dosu/dosu": { status: 0 } });

    const status = runUpgrade("homebrew", { platform: "darwin" });

    expect(mockSpawnSync).toHaveBeenCalledWith("brew", ["upgrade", "dosu-ai/dosu/dosu"], {
      shell: false,
      stdio: "inherit",
    });
    expect(status).toBe(0);
    expect(output()).toContain("Updating Dosu with Homebrew");
  });

  it("preserves a package-manager failure and shows the same manual command", () => {
    mockCommands({ "brew upgrade dosu-ai/dosu/dosu": { status: 7 } });

    const status = runUpgrade("homebrew", { platform: "darwin" });

    expect(status).toBe(7);
    expect(errors()).toContain("Could not update Dosu automatically");
    expect(errors()).toContain("brew upgrade dosu-ai/dosu/dosu");
    expect(errors()).not.toContain("npm install");
  });

  it("handles a missing package manager without claiming success", () => {
    mockCommands({
      "brew upgrade dosu-ai/dosu/dosu": {
        error: Object.assign(new Error("spawn brew ENOENT"), { code: "ENOENT" }),
        status: null,
      },
    });

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

  it("detects and updates an npm-owned installation on Windows with fixed commands", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe";
    const npmRoot = "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules";
    const entrypoint = `${npmRoot}\\@dosu\\cli\\bin\\dosu.js`;
    const neutralCwd = "C:\\Users\\alice";
    const safeEnv = { Path: "C:\\Program Files\\nodejs" };
    mockCommands({
      [`${cmd} /d /s /c npm root -g`]: { status: 0, stdout: `${npmRoot}\r\n` },
      [`${cmd} /d /s /c ${PNPM_LOCATE_COMMAND}`]: { status: 0, stdout: "" },
      [`${cmd} /d /s /c yarn --silent global dir`]: { status: 1, stdout: "" },
      [`${cmd} /d /s /c npm install -g @dosu/cli@latest`]: { status: 0 },
    });

    mockRealpathSync.withImplementation(((path: unknown) => String(path)) as never, () => {
      expect(
        runUpgrade("npm", {
          entrypoint,
          platform: "win32",
          comSpec: cmd,
          cwd: neutralCwd,
          env: safeEnv,
        }),
      ).toBe(0);
    });

    expect(mockSpawnSync).toHaveBeenLastCalledWith(
      cmd,
      ["/d", "/s", "/c", "npm install -g @dosu/cli@latest"],
      {
        cwd: neutralCwd,
        env: { ...hardenedEnv(safeEnv), NoDefaultCurrentDirectoryInExePath: "1" },
        shell: false,
        stdio: "inherit",
      },
    );
  });

  it.each([
    { installStatus: 0, expectedExitCode: undefined },
    { installStatus: 7, expectedExitCode: 7 },
  ])("maps an upgrade result of $installStatus to shell exit code $expectedExitCode", async ({
    installStatus,
    expectedExitCode,
  }) => {
    const npmRoot = join(tempDir, "npm", "node_modules");
    const entrypoint = makeEntrypoint(npmPackageRoot(npmRoot));
    process.argv = [process.execPath, entrypoint];
    mockCommands({
      "npm root -g": { status: 0, stdout: `${npmRoot}\n` },
      [PNPM_LOCATE_COMMAND]: { status: 0, stdout: "" },
      "yarn --silent global dir": { status: 1, stdout: "" },
      "npm install -g @dosu/cli@latest": { status: installStatus },
    });

    await upgradeCommand().parseAsync([], { from: "user" });

    expect(process.exitCode).toBe(expectedExitCode);
  });
});

describe("buildPackageManagerInvocation", () => {
  it("uses fixed Windows commands and a safe command processor environment", () => {
    const env = { Path: "C:\\Program Files\\nodejs", TEMP: "C:\\Temp" };
    const cmd = "C:\\Windows\\System32\\cmd.exe";

    expect(buildPackageManagerInvocation("npm", "locate", "win32", cmd, env)).toEqual({
      command: cmd,
      args: ["/d", "/s", "/c", "npm root -g"],
      env: { ...hardenedEnv(env), NoDefaultCurrentDirectoryInExePath: "1" },
    });
    expect(buildPackageManagerInvocation("pnpm", "install", "win32", cmd, env)).toEqual({
      command: cmd,
      args: ["/d", "/s", "/c", "pnpm add -g @dosu/cli@latest"],
      env: { ...hardenedEnv(env), NoDefaultCurrentDirectoryInExePath: "1" },
    });
    expect(buildPackageManagerInvocation("yarn", "locate", "win32", cmd, env)).toEqual({
      command: cmd,
      args: ["/d", "/s", "/c", "yarn --silent global dir"],
      env: { ...hardenedEnv(env), NoDefaultCurrentDirectoryInExePath: "1" },
    });
  });

  it("accepts only absolute Windows command processor paths", () => {
    expect(
      buildPackageManagerInvocation("npm", "locate", "win32", undefined, {
        ComSpec: "D:\\Windows\\System32\\cmd.exe",
      }).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(
      buildPackageManagerInvocation("npm", "locate", "win32", "cmd.exe", {
        ComSpec: "cmd.exe",
        SystemRoot: "D:\\Windows",
      }).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(
      buildPackageManagerInvocation(
        "npm",
        "locate",
        "win32",
        "D:\\Windows\\System32\\powershell.exe",
        { SystemRoot: "D:\\Windows" },
      ).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
    expect(
      buildPackageManagerInvocation("npm", "locate", "win32", undefined, {
        ComSpec: "cmd.exe",
        SystemRoot: "Windows",
      }).command,
    ).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});
