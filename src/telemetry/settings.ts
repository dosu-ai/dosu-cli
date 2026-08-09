import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";

const TELEMETRY_SCHEMA_VERSION = 1 as const;
const TELEMETRY_SETTINGS_FILENAME = "telemetry.json";
const MAX_TELEMETRY_SETTINGS_BYTES = 16 * 1_024;

export type TelemetryEnvironmentOverride = "DO_NOT_TRACK" | "DOSU_TELEMETRY_DISABLED";

export interface TelemetrySettings {
  schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  disabled?: true;
  install_id?: string;
}

type SettingsReadStatus = "current" | "missing" | "invalid" | "unsupported" | "error";

interface SettingsReadResult {
  status: SettingsReadStatus;
  settings: TelemetrySettings;
}

export function getTelemetrySettingsPath(): string {
  return join(getConfigDir(), TELEMETRY_SETTINGS_FILENAME);
}

/**
 * Load only the schema this CLI understands. Telemetry is enabled when the
 * file is missing; invalid, unreadable, and future settings disable it for
 * this run without changing the file on disk.
 */
export function loadTelemetrySettings(): TelemetrySettings {
  return readTelemetrySettings().settings;
}

/** Telemetry is on by default; this persists the single global override. */
export function setTelemetryEnabled(enabled: boolean): boolean {
  if (typeof enabled !== "boolean") return false;
  const current = readTelemetrySettings();
  if (current.status === "unsupported" || current.status === "error") return false;
  const settings = current.status === "current" ? current.settings : emptyTelemetrySettings();
  if (enabled) delete settings.disabled;
  else settings.disabled = true;
  return writeTelemetrySettings(settings);
}

/** Environment overrides are master switches and take precedence over persisted settings. */
export function telemetryDisabledByEnvironment(): TelemetryEnvironmentOverride | undefined {
  if (isEnabledEnvironmentFlag(process.env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (isEnabledEnvironmentFlag(process.env.DOSU_TELEMETRY_DISABLED)) {
    return "DOSU_TELEMETRY_DISABLED";
  }
  return undefined;
}

/** Missing settings mean enabled; explicit or defensive disables always win. */
export function isTelemetryEnabled(settings = loadTelemetrySettings()): boolean {
  if (telemetryDisabledByEnvironment() !== undefined) return false;
  return settings.disabled !== true;
}

/**
 * Return the installation UUID, creating it only for a missing or understood
 * settings file. Corrupt, unreadable, and future schemas are preserved.
 */
export function getOrCreateInstallID(): string | undefined {
  const current = readTelemetrySettings();
  if (current.status === "current" && current.settings.install_id) {
    return current.settings.install_id;
  }
  if (current.status !== "current" && current.status !== "missing") return undefined;

  const installID = randomUUID();
  const settings = current.status === "current" ? current.settings : emptyTelemetrySettings();
  settings.install_id = installID;
  return writeTelemetrySettings(settings) ? installID : undefined;
}

/** Explicitly rotate the installation UUID, preserving the understood global setting. */
export function resetInstallID(): string | undefined {
  const current = readTelemetrySettings();
  if (current.status !== "current" && current.status !== "missing") return undefined;
  const settings = current.status === "current" ? current.settings : emptyTelemetrySettings();
  const installID = randomUUID();
  settings.install_id = installID;
  return writeTelemetrySettings(settings) ? installID : undefined;
}

function readTelemetrySettings(): SettingsReadResult {
  const path = getTelemetrySettingsPath();
  let file: ReturnType<typeof lstatSync>;
  try {
    file = lstatSync(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { status: "missing", settings: emptyTelemetrySettings() };
    }
    return { status: "error", settings: disabledTelemetrySettings() };
  }
  if (!file.isFile() || file.size > MAX_TELEMETRY_SETTINGS_BYTES) {
    return { status: "invalid", settings: disabledTelemetrySettings() };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { status: "error", settings: disabledTelemetrySettings() };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid", settings: disabledTelemetrySettings() };
  }

  if (!isRecord(raw)) return { status: "invalid", settings: disabledTelemetrySettings() };
  if (raw.schema_version !== TELEMETRY_SCHEMA_VERSION) {
    const status = "schema_version" in raw ? "unsupported" : "invalid";
    return { status, settings: disabledTelemetrySettings() };
  }
  if ("disabled" in raw && typeof raw.disabled !== "boolean") {
    return { status: "invalid", settings: disabledTelemetrySettings() };
  }

  const settings = emptyTelemetrySettings();
  if (raw.disabled === true) settings.disabled = true;
  if (typeof raw.install_id === "string" && isUUID(raw.install_id)) {
    settings.install_id = raw.install_id;
  }
  return { status: "current", settings };
}

function writeTelemetrySettings(settings: TelemetrySettings): boolean {
  const path = getTelemetrySettingsPath();
  const dir = getConfigDir();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The write may have failed before a temporary file existed.
    }
    return false;
  }
}

function emptyTelemetrySettings(): TelemetrySettings {
  return { schema_version: TELEMETRY_SCHEMA_VERSION };
}

function disabledTelemetrySettings(): TelemetrySettings {
  return { schema_version: TELEMETRY_SCHEMA_VERSION, disabled: true };
}

function isEnabledEnvironmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
