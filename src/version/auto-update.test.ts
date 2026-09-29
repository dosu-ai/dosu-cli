import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import {
  autoUpdateDisabledReason,
  backgroundInvocation,
  runBackgroundUpgrade,
  setAutoUpdateEnabled,
  startAutoUpdate,
} from "./auto-update";

const mockSpawn = vi.mocked(spawn);
const ENV = { PATH: "/usr/bin" };
const NPM = { channel: "npm", env: ENV, entrypoint: "/g/@dosu/cli/bin/dosu.js", execPath: "/n" };

let tempDir: string;
let originalXDG: string | undefined;
let child: { on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };

function configPath(name: string): string {
  return join(tempDir, "dosu-cli", name);
}

function writeConfig(name: string, content: string): void {
  mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
  writeFileSync(configPath(name), content);
}

beforeEach(() => {
  originalXDG = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-auto-update-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  child = { on: vi.fn(), unref: vi.fn() };
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(child as never);
});

afterEach(() => {
  if (originalXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXDG;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("backgroundInvocation", () => {
  it("re-runs the npm entrypoint with the current node", () => {
    expect(backgroundInvocation("npm", "/g/bin/dosu.js", "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      args: ["/g/bin/dosu.js", "upgrade", "--background"],
    });
  });

  it("re-runs the compiled Homebrew binary directly", () => {
    expect(backgroundInvocation("homebrew", "/$bunfs/root/dosu", "/opt/dosu")).toEqual({
      command: "/opt/dosu",
      args: ["upgrade", "--background"],
    });
  });

  it("has nothing to run without an npm entrypoint or for other channels", () => {
    expect(backgroundInvocation("npm", "", "/n")).toBeNull();
    expect(backgroundInvocation("binary", "/x", "/n")).toBeNull();
  });
});

describe("startAutoUpdate", () => {
  it("spawns a detached, telemetry-free background upgrade and takes the lock", () => {
    expect(startAutoUpdate("1.2.3", NPM)).toBe("started");

    expect(mockSpawn).toHaveBeenCalledWith(
      "/n",
      ["/g/@dosu/cli/bin/dosu.js", "upgrade", "--background"],
      expect.objectContaining({
        cwd: homedir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...ENV, DOSU_TELEMETRY_DISABLED: "1" },
      }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(readFileSync(configPath("auto-update.lock"), "utf-8")).toBe("1.2.3");
  });

  it("releases the lock when the child cannot be started", () => {
    startAutoUpdate("1.2.3", NPM);
    const onError = child.on.mock.calls.find(([event]) => event === "error")?.[1];

    onError?.(new Error("ENOENT"));

    expect(existsSync(configPath("auto-update.lock"))).toBe(false);
  });

  it("releases the lock and reports unavailable when spawn throws", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(startAutoUpdate("1.2.3", NPM)).toBe("unavailable");
    expect(existsSync(configPath("auto-update.lock"))).toBe(false);
  });

  it("joins an install that is already running instead of starting another", () => {
    expect(startAutoUpdate("1.2.3", NPM)).toBe("started");
    expect(startAutoUpdate("1.2.3", NPM)).toBe("in_progress");
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it("reclaims a stale lock left by a dead install", () => {
    writeConfig("auto-update.lock", "1.2.2");

    expect(startAutoUpdate("1.2.3", { ...NPM, now: Date.now() + 16 * 60 * 1000 })).toBe("started");
    expect(readFileSync(configPath("auto-update.lock"), "utf-8")).toBe("1.2.3");
  });

  it("waits before retrying a version whose install already ran", () => {
    const now = Date.now();
    writeConfig(
      "auto-update.json",
      JSON.stringify({ lastAttempt: { version: "1.2.3", ok: false, finishedAt: now } }),
    );

    expect(startAutoUpdate("1.2.3", { ...NPM, now: now + 60_000 })).toBe("unavailable");
    expect(startAutoUpdate("1.2.4", { ...NPM, now: now + 60_000 })).toBe("started");
  });

  it("retries the same version after the retry interval", () => {
    const now = Date.now();
    writeConfig(
      "auto-update.json",
      JSON.stringify({ lastAttempt: { version: "1.2.3", ok: false, finishedAt: now } }),
    );

    expect(startAutoUpdate("1.2.3", { ...NPM, now: now + 6 * 60 * 60 * 1000 + 1 })).toBe("started");
  });

  it.each([
    ["an npx run", { env: { ...ENV, npm_command: "exec" } }],
    ["a standalone binary", { channel: "binary" }],
    ["CI", { env: { ...ENV, CI: "true" } }],
    ["tests", { env: { ...ENV, NODE_ENV: "test" } }],
    ["a dev checkout", { env: { ...ENV, DOSU_DEV: "true" } }],
    ["the opt-out env var", { env: { ...ENV, DOSU_DISABLE_AUTOUPDATE: "1" } }],
  ])("never installs for %s", (_label, overrides) => {
    expect(startAutoUpdate("1.2.3", { ...NPM, ...overrides })).toBe("unavailable");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects a malformed version", () => {
    expect(startAutoUpdate("1.2.3\nrm -rf /", NPM)).toBe("unavailable");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("honors the persisted opt-out", () => {
    setAutoUpdateEnabled(false);

    expect(startAutoUpdate("1.2.3", NPM)).toBe("unavailable");
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("auto-update settings", () => {
  it("is on by default and toggles with a persisted setting", () => {
    expect(autoUpdateDisabledReason(ENV)).toBeUndefined();

    expect(setAutoUpdateEnabled(false)).toBe(true);
    expect(autoUpdateDisabledReason(ENV)).toBe("settings");

    expect(setAutoUpdateEnabled(true)).toBe(true);
    expect(autoUpdateDisabledReason(ENV)).toBeUndefined();
  });

  it("lets the environment variable win over the setting", () => {
    expect(autoUpdateDisabledReason({ DOSU_DISABLE_AUTOUPDATE: "true" })).toBe("env");
    expect(autoUpdateDisabledReason({ DOSU_DISABLE_AUTOUPDATE: "0" })).toBeUndefined();
  });

  it("treats a corrupt state file as the default", () => {
    writeConfig("auto-update.json", "NOT JSON{{{");
    expect(autoUpdateDisabledReason(ENV)).toBeUndefined();

    writeConfig("auto-update.json", "[]");
    expect(autoUpdateDisabledReason(ENV)).toBeUndefined();
  });

  it("keeps the last attempt when toggling", () => {
    const lastAttempt = { version: "1.2.3", ok: true, finishedAt: 5 };
    writeConfig("auto-update.json", JSON.stringify({ lastAttempt }));

    setAutoUpdateEnabled(false);

    expect(JSON.parse(readFileSync(configPath("auto-update.json"), "utf-8"))).toEqual({
      disabled: true,
      lastAttempt,
    });
  });
});

describe("runBackgroundUpgrade", () => {
  it("records a successful install and releases the lock", () => {
    writeConfig("auto-update.lock", "1.2.3");

    expect(
      runBackgroundUpgrade(
        () => 0,
        () => 42,
      ),
    ).toBe(0);

    expect(existsSync(configPath("auto-update.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(configPath("auto-update.json"), "utf-8"))).toEqual({
      lastAttempt: { version: "1.2.3", ok: true, finishedAt: 42 },
    });
  });

  it("records a failed or throwing install", () => {
    writeConfig("auto-update.lock", "1.2.3");
    expect(
      runBackgroundUpgrade(
        () => 243,
        () => 1,
      ),
    ).toBe(243);
    expect(JSON.parse(readFileSync(configPath("auto-update.json"), "utf-8")).lastAttempt.ok).toBe(
      false,
    );

    writeConfig("auto-update.lock", "1.2.3");
    const status = runBackgroundUpgrade(() => {
      throw new Error("boom");
    });
    expect(status).toBe(1);
    expect(existsSync(configPath("auto-update.lock"))).toBe(false);
  });

  it("runs without recording when no lock names a version", () => {
    const upgrade = vi.fn(() => 0);

    expect(runBackgroundUpgrade(upgrade)).toBe(0);

    expect(upgrade).toHaveBeenCalledOnce();
    expect(existsSync(configPath("auto-update.json"))).toBe(false);
  });
});
