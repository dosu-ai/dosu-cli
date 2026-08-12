import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    lstatSync: vi.fn(actual.lstatSync),
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});

import {
  getOrCreateInstallID,
  getTelemetrySettingsPath,
  isTelemetryEnabled,
  loadTelemetrySettings,
  resetInstallID,
  setTelemetryEnabled,
  telemetryDisabledByEnvironment,
} from "./settings";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SavedEnvironment {
  XDG_CONFIG_HOME?: string;
  DOSU_DEV?: string;
  DO_NOT_TRACK?: string;
  DOSU_TELEMETRY_DISABLED?: string;
}

describe("telemetry settings", () => {
  let tempRoot: string;
  let savedEnvironment: SavedEnvironment;

  beforeEach(() => {
    savedEnvironment = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      DOSU_DEV: process.env.DOSU_DEV,
      DO_NOT_TRACK: process.env.DO_NOT_TRACK,
      DOSU_TELEMETRY_DISABLED: process.env.DOSU_TELEMETRY_DISABLED,
    };
    tempRoot = mkdtempSync(join(tmpdir(), "dosu-telemetry-settings-"));
    process.env.XDG_CONFIG_HOME = tempRoot;
    delete process.env.DOSU_DEV;
    delete process.env.DO_NOT_TRACK;
    delete process.env.DOSU_TELEMETRY_DISABLED;
    vi.mocked(existsSync).mockClear();
    vi.mocked(lstatSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  afterEach(() => {
    restoreEnvironment(savedEnvironment);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("is enabled by default without creating a settings file", () => {
    expect(getTelemetrySettingsPath()).toBe(join(tempRoot, "dosu-cli", "telemetry.json"));
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled()).toBe(true);
    expect(existsSync(getTelemetrySettingsPath())).toBe(false);
  });

  it("persists one global disable and returns to the default when enabled", () => {
    expect(setTelemetryEnabled(false)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(isTelemetryEnabled()).toBe(false);

    expect(setTelemetryEnabled(true)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("lets either master environment override disable telemetry", () => {
    expect(telemetryDisabledByEnvironment()).toBeUndefined();
    expect(isTelemetryEnabled()).toBe(true);

    process.env.DO_NOT_TRACK = "1";
    expect(telemetryDisabledByEnvironment()).toBe("DO_NOT_TRACK");
    expect(isTelemetryEnabled()).toBe(false);

    delete process.env.DO_NOT_TRACK;
    process.env.DOSU_TELEMETRY_DISABLED = "true";
    expect(telemetryDisabledByEnvironment()).toBe("DOSU_TELEMETRY_DISABLED");
    expect(isTelemetryEnabled()).toBe(false);

    process.env.DOSU_TELEMETRY_DISABLED = "0";
    expect(telemetryDisabledByEnvironment()).toBeUndefined();
    expect(isTelemetryEnabled()).toBe(true);

    process.env.DOSU_TELEMETRY_DISABLED = "unexpected-but-present";
    expect(isTelemetryEnabled()).toBe(false);

    process.env.DOSU_TELEMETRY_DISABLED = "   ";
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("disables telemetry and preserves corrupt settings until an explicit enable", () => {
    const path = createSettingsFile("not json {{{");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(isTelemetryEnabled()).toBe(false);
    expect(getOrCreateInstallID()).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("not json {{{");

    expect(setTelemetryEnabled(true)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("rejects special files before trying to read them", () => {
    vi.mocked(lstatSync).mockReturnValueOnce({
      isFile: () => false,
      size: 0,
    } as ReturnType<typeof lstatSync>);

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("rejects oversized settings before reading their contents", () => {
    createSettingsFile("x".repeat(16_385));

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("accepts only the global flag and a valid installation id", () => {
    createSettingsFile(
      JSON.stringify({
        schema_version: 1,
        disabled: true,
        analytics: true,
        errors: true,
        install_id: "not-a-uuid",
        unexpected: "ignored",
      }),
    );

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });

    createSettingsFile(JSON.stringify({ schema_version: 1, disabled: "yes" }));
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("rejects invalid runtime updates", () => {
    const path = createSettingsFile("[]");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(setTelemetryEnabled("yes" as never)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("[]");
  });

  it("does not overwrite an unknown future schema", () => {
    const future = `${JSON.stringify({
      schema_version: 2,
      disabled: false,
      install_id: "future-owned-value",
      future_field: { keep: true },
    })}\n`;
    const path = createSettingsFile(future);

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(isTelemetryEnabled()).toBe(false);
    expect(getOrCreateInstallID()).toBeUndefined();
    expect(resetInstallID()).toBeUndefined();
    expect(setTelemetryEnabled(true)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(future);
  });

  it("writes atomically with owner-only file and directory permissions", () => {
    expect(setTelemetryEnabled(false)).toBe(true);

    const finalPath = getTelemetrySettingsPath();
    const writtenPaths = vi.mocked(writeFileSync).mock.calls.map((call) => String(call[0]));
    expect(writtenPaths).not.toContain(finalPath);
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
    const [temporaryPath, destinationPath] = vi.mocked(renameSync).mock.calls[0];
    expect(String(destinationPath)).toBe(finalPath);
    expect(dirname(String(temporaryPath))).toBe(dirname(finalPath));
    expect(statSync(finalPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(finalPath)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(finalPath))).toEqual(["telemetry.json"]);
  });

  it("replaces a loosely permissioned settings file with mode 0600", () => {
    const path = createSettingsFile(JSON.stringify({ schema_version: 1 }), 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    expect(setTelemetryEnabled(false)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("creates and rotates a random installation id while preserving the global switch", () => {
    const first = getOrCreateInstallID();
    expect(first).toMatch(UUID_V4);
    expect(getOrCreateInstallID()).toBe(first);

    expect(setTelemetryEnabled(false)).toBe(true);
    const second = resetInstallID();
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
    expect(loadTelemetrySettings()).toEqual({
      schema_version: 1,
      disabled: true,
      install_id: second,
    });
  });

  it("never throws and disables telemetry when reads fail", () => {
    createSettingsFile(JSON.stringify({ schema_version: 1 }));
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("read denied");
    });
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });

    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("read denied");
    });
    expect(isTelemetryEnabled()).toBe(false);

    vi.mocked(lstatSync).mockImplementationOnce(() => {
      throw new Error("stat denied");
    });
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
  });

  it("preserves existing settings when a transient read fails", () => {
    const original = `${JSON.stringify({
      schema_version: 1,
      disabled: true,
      install_id: "11111111-1111-4111-8111-111111111111",
    })}\n`;
    const path = createSettingsFile(original);

    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("temporarily unreadable");
    });
    expect(setTelemetryEnabled(true)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(original);

    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("temporarily unreadable");
    });
    expect(resetInstallID()).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe(original);
  });

  it("never throws when writes fail", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("read-only filesystem");
    });
    expect(setTelemetryEnabled(false)).toBe(false);
    expect(isTelemetryEnabled()).toBe(true);

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("read-only filesystem");
    });
    expect(getOrCreateInstallID()).toBeUndefined();
    expect(existsSync(getTelemetrySettingsPath())).toBe(false);
  });

  it("removes a temporary file and preserves the previous value when rename fails", () => {
    const original = getOrCreateInstallID();
    expect(original).toMatch(UUID_V4);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("rename denied");
    });

    expect(resetInstallID()).toBeUndefined();
    expect(getOrCreateInstallID()).toBe(original);
    expect(readdirSync(dirname(getTelemetrySettingsPath()))).toEqual(["telemetry.json"]);
  });

  function createSettingsFile(content: string, mode = 0o600): string {
    const path = getTelemetrySettingsPath();
    const dir = dirname(path);
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode });
    return path;
  }
});

function restoreEnvironment(saved: SavedEnvironment): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
