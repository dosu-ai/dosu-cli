import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("../statusline/install", () => ({
  writeStatuslineScripts: vi.fn(),
  installStatuslineSettings: vi.fn(),
  uninstallStatusline: vi.fn(),
  inspectStatusline: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
  inspectStatusline,
  installStatuslineSettings,
  uninstallStatusline,
  writeStatuslineScripts,
} from "../statusline/install";
import {
  python3OnPath,
  runStatuslineInstall,
  runStatuslineStatus,
  runStatuslineUninstall,
  statuslineCommand,
} from "./statusline";

let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  log.mockRestore();
  error.mockRestore();
  process.exitCode = undefined;
});

function logged(): string {
  return log.mock.calls.map((c) => c.join(" ")).join("\n");
}

const INSTALL_OK = {
  settingsPath: "/home/u/.claude/settings.json",
  statusLine: "installed" as const,
  warnings: [],
};

describe("python3OnPath", () => {
  it("is true when the probe exits 0", () => {
    expect(python3OnPath()).toBe(true);
  });

  it("is false when the probe fails or throws", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    expect(python3OnPath()).toBe(false);
    vi.mocked(spawnSync).mockImplementation(() => {
      throw new Error("no shell");
    });
    expect(python3OnPath()).toBe(false);
  });
});

describe("runStatuslineInstall", () => {
  it("writes scripts and reports a fresh install", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue(INSTALL_OK);
    await runStatuslineInstall({});
    expect(writeStatuslineScripts).toHaveBeenCalled();
    expect(installStatuslineSettings).toHaveBeenCalledWith(undefined, { force: undefined });
    expect(logged()).toContain("✓ Installed the Dosu knowledge status line.");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports a refresh on re-install", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue({ ...INSTALL_OK, statusLine: "updated" });
    await runStatuslineInstall({});
    expect(logged()).toContain("Refreshed");
  });

  it("reports a conflict without touching the existing status line", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue({
      ...INSTALL_OK,
      statusLine: "conflict",
      existingCommand: "~/mine.sh",
    });
    await runStatuslineInstall({});
    expect(process.exitCode).toBe(1);
    expect(logged()).toContain("~/mine.sh");
    expect(logged()).toContain("--force");
  });

  it("reports a forced replace", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue({
      ...INSTALL_OK,
      statusLine: "replaced",
      existingCommand: "~/mine.sh",
    });
    await runStatuslineInstall({ force: true });
    expect(installStatuslineSettings).toHaveBeenCalledWith(undefined, { force: true });
    expect(logged()).toContain("Replaced");
  });

  it("warns when python3 is missing and surfaces settings warnings", async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
    vi.mocked(installStatuslineSettings).mockReturnValue({
      ...INSTALL_OK,
      warnings: ["disableAllHooks is set"],
    });
    await runStatuslineInstall({});
    expect(logged()).toContain("python3 was not found");
    expect(logged()).toContain("disableAllHooks is set");
  });

  it("emits JSON when asked", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue(INSTALL_OK);
    await runStatuslineInstall({ json: true });
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "statusline-install", status_line: "installed" });
  });

  it("sets exit code 1 on a JSON conflict", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue({ ...INSTALL_OK, statusLine: "conflict" });
    await runStatuslineInstall({ json: true });
    expect(process.exitCode).toBe(1);
  });

  it("reports write failures", async () => {
    vi.mocked(installStatuslineSettings).mockImplementation(() => {
      throw new Error("refusing to modify");
    });
    await runStatuslineInstall({});
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls[0][0]).toContain("refusing to modify");
  });

  it("reports write failures as JSON", async () => {
    vi.mocked(installStatuslineSettings).mockImplementation(() => {
      throw new Error("disk full");
    });
    await runStatuslineInstall({ json: true });
    expect(process.exitCode).toBe(1);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "statusline-install", reason: "write_failed" });
  });
});

describe("runStatuslineUninstall", () => {
  const REMOVED = {
    settingsPath: "/home/u/.claude/settings.json",
    statusLineRemoved: true,
    statusLineRestored: false,
  };

  it("reports a removal", async () => {
    vi.mocked(uninstallStatusline).mockReturnValue(REMOVED);
    await runStatuslineUninstall({});
    expect(logged()).toContain("✓ Removed");
  });

  it("mentions a restored status line", async () => {
    vi.mocked(uninstallStatusline).mockReturnValue({ ...REMOVED, statusLineRestored: true });
    await runStatuslineUninstall({});
    expect(logged()).toContain("Restored your previous status line");
  });

  it("reports a no-op", async () => {
    vi.mocked(uninstallStatusline).mockReturnValue({ ...REMOVED, statusLineRemoved: false });
    await runStatuslineUninstall({});
    expect(logged()).toContain("No Dosu status line was installed.");
  });

  it("emits JSON when asked", async () => {
    vi.mocked(uninstallStatusline).mockReturnValue(REMOVED);
    await runStatuslineUninstall({ json: true });
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "statusline-uninstall", status_line_removed: true });
  });
});

describe("runStatuslineStatus", () => {
  const INFO = {
    scriptInstalled: true,
    statusLineConfigured: true,
    settingsParseError: false,
    warnings: [],
  };

  it("prints a check per component", async () => {
    vi.mocked(inspectStatusline).mockReturnValue(INFO);
    await runStatuslineStatus({});
    expect(logged()).toContain("✓ renderer installed");
    expect(logged()).toContain("✓ statusLine configured");
    expect(logged()).toContain("✓ python3 on PATH");
    expect(logged()).toContain("dosu hooks doctor");
  });

  it("flags a parse error and warnings", async () => {
    vi.mocked(inspectStatusline).mockReturnValue({
      ...INFO,
      settingsParseError: true,
      warnings: ["allowManagedHooksOnly is set"],
    });
    await runStatuslineStatus({});
    expect(logged()).toContain("not valid JSON");
    expect(logged()).toContain("⚠ allowManagedHooksOnly is set");
  });

  it("emits JSON when asked", async () => {
    vi.mocked(inspectStatusline).mockReturnValue(INFO);
    await runStatuslineStatus({ json: true });
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "statusline-status", python3_on_path: true });
  });
});

describe("statuslineCommand", () => {
  it("registers install, uninstall, and status subcommands", () => {
    const cmd = statuslineCommand();
    expect(cmd.name()).toBe("statusline");
    expect(cmd.commands.map((c) => c.name())).toEqual(["install", "uninstall", "status"]);
  });

  it("dispatches install through the command", async () => {
    vi.mocked(installStatuslineSettings).mockReturnValue(INSTALL_OK);
    await statuslineCommand().parseAsync(["install"], { from: "user" });
    expect(writeStatuslineScripts).toHaveBeenCalled();
  });

  it("dispatches uninstall through the command", async () => {
    vi.mocked(uninstallStatusline).mockReturnValue({
      settingsPath: "p",
      statusLineRemoved: false,
      statusLineRestored: false,
    });
    await statuslineCommand().parseAsync(["uninstall"], { from: "user" });
    expect(uninstallStatusline).toHaveBeenCalled();
  });

  it("dispatches status through the command", async () => {
    vi.mocked(inspectStatusline).mockReturnValue({
      scriptInstalled: false,
      statusLineConfigured: false,
      settingsParseError: false,
      warnings: [],
    });
    await statuslineCommand().parseAsync(["status"], { from: "user" });
    expect(inspectStatusline).toHaveBeenCalled();
  });
});
