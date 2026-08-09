import {
  existsSync,
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
  setTelemetryConsent,
  setTelemetryConsents,
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
    vi.mocked(readFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
    vi.mocked(writeFileSync).mockClear();
  });

  afterEach(() => {
    restoreEnvironment(savedEnvironment);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("stores an empty, fail-closed schema under the shared config directory", () => {
    expect(getTelemetrySettingsPath()).toBe(join(tempRoot, "dosu-cli", "telemetry.json"));
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(isTelemetryEnabled("errors")).toBe(false);
    expect(existsSync(getTelemetrySettingsPath())).toBe(false);
  });

  it("persists independent explicit consent decisions", () => {
    expect(setTelemetryConsent("analytics", true)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, analytics: true });
    expect(isTelemetryEnabled("analytics")).toBe(true);
    expect(isTelemetryEnabled("errors")).toBe(false);

    expect(setTelemetryConsent("errors", false)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({
      schema_version: 1,
      analytics: true,
      errors: false,
    });

    expect(setTelemetryConsent("all", true)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({
      schema_version: 1,
      analytics: true,
      errors: true,
    });

    expect(setTelemetryConsents({ analytics: false, errors: true })).toBe(true);
    expect(loadTelemetrySettings()).toEqual({
      schema_version: 1,
      analytics: false,
      errors: true,
    });
  });

  it("lets either master environment override disable both lanes", () => {
    setTelemetryConsent("all", true);
    expect(telemetryDisabledByEnvironment()).toBeUndefined();
    expect(isTelemetryEnabled("analytics")).toBe(true);
    expect(isTelemetryEnabled("errors")).toBe(true);

    process.env.DO_NOT_TRACK = "1";
    expect(telemetryDisabledByEnvironment()).toBe("DO_NOT_TRACK");
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(isTelemetryEnabled("errors")).toBe(false);

    delete process.env.DO_NOT_TRACK;
    process.env.DOSU_TELEMETRY_DISABLED = "true";
    expect(telemetryDisabledByEnvironment()).toBe("DOSU_TELEMETRY_DISABLED");
    expect(isTelemetryEnabled("analytics")).toBe(false);

    process.env.DOSU_TELEMETRY_DISABLED = "0";
    expect(telemetryDisabledByEnvironment()).toBeUndefined();
    expect(isTelemetryEnabled("analytics")).toBe(true);

    process.env.DOSU_TELEMETRY_DISABLED = "unexpected-but-present";
    expect(telemetryDisabledByEnvironment()).toBe("DOSU_TELEMETRY_DISABLED");
    expect(isTelemetryEnabled("analytics")).toBe(false);

    process.env.DOSU_TELEMETRY_DISABLED = "   ";
    expect(telemetryDisabledByEnvironment()).toBeUndefined();
  });

  it("fails closed on corrupt or malformed settings", () => {
    const path = createSettingsFile("not json {{{");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(getOrCreateInstallID()).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe("not json {{{");

    expect(setTelemetryConsent("errors", true)).toBe(true);
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, errors: true });
  });

  it("normalizes schema-one fields instead of trusting arbitrary JSON", () => {
    createSettingsFile(
      JSON.stringify({
        schema_version: 1,
        analytics: "yes",
        errors: false,
        install_id: "not-a-uuid",
        unexpected: "ignored",
      }),
    );

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, errors: false });
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(isTelemetryEnabled("errors")).toBe(false);
  });

  it("rejects non-object, unversioned, and invalid runtime updates", () => {
    const path = createSettingsFile("[]");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    writeFileSync(path, "{}");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });

    expect(setTelemetryConsents({})).toBe(false);
    expect(setTelemetryConsent("not-a-lane" as never, true)).toBe(false);
    expect(setTelemetryConsent("analytics", "yes" as never)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe("{}");
  });

  it("does not overwrite an unknown future schema during reads or explicit writes", () => {
    const future = `${JSON.stringify({
      schema_version: 2,
      analytics: true,
      errors: true,
      install_id: "future-owned-value",
      future_field: { keep: true },
    })}\n`;
    const path = createSettingsFile(future);

    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(getOrCreateInstallID()).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe(future);

    expect(resetInstallID()).toBeUndefined();
    expect(setTelemetryConsent("analytics", true)).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(future);
  });

  it("writes atomically with owner-only file and directory permissions", () => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockClear();

    expect(setTelemetryConsent("analytics", true)).toBe(true);

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

  it("replaces a loosely-permissioned settings file with mode 0600", () => {
    const path = createSettingsFile(JSON.stringify({ schema_version: 1 }), 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);

    expect(setTelemetryConsent("analytics", true)).toBe(true);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("creates, persists, and explicitly rotates a random installation UUID", () => {
    setTelemetryConsent("analytics", true);
    const first = getOrCreateInstallID();
    expect(first).toMatch(UUID_V4);
    expect(getOrCreateInstallID()).toBe(first);
    expect(loadTelemetrySettings()).toEqual({
      schema_version: 1,
      analytics: true,
      install_id: first,
    });

    const second = resetInstallID();
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
    expect(getOrCreateInstallID()).toBe(second);
    expect(loadTelemetrySettings().analytics).toBe(true);
  });

  it("never throws and stays disabled when reads fail", () => {
    createSettingsFile(JSON.stringify({ schema_version: 1, analytics: true }));
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("read denied");
    });

    expect(() => loadTelemetrySettings()).not.toThrow();
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error("read denied");
    });
    expect(isTelemetryEnabled("analytics")).toBe(false);

    vi.mocked(existsSync).mockImplementationOnce(() => {
      throw new Error("stat denied");
    });
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
  });

  it("never throws or enables collection when data writes fail", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("read-only filesystem");
    });
    expect(setTelemetryConsent("analytics", true)).toBe(false);
    expect(isTelemetryEnabled("analytics")).toBe(false);
    expect(setTelemetryConsent("analytics", true)).toBe(true);

    rmSync(getTelemetrySettingsPath(), { force: true });
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
