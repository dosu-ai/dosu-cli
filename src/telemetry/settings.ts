import { randomUUID } from "node:crypto";
import {
  existsSync,
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

export type TelemetryLane = "analytics" | "errors";
export type TelemetryEnvironmentOverride = "DO_NOT_TRACK" | "DOSU_TELEMETRY_DISABLED";

export interface TelemetrySettings {
  schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  analytics?: boolean;
  errors?: boolean;
  install_id?: string;
}

export type TelemetryConsentUpdate = Partial<Record<TelemetryLane, boolean>>;

type SettingsReadStatus = "current" | "missing" | "invalid" | "unsupported" | "error";

interface SettingsReadResult {
  status: SettingsReadStatus;
  settings: TelemetrySettings;
}

export function getTelemetrySettingsPath(): string {
  return join(getConfigDir(), TELEMETRY_SETTINGS_FILENAME);
}

/**
 * Load only the schema this CLI understands. Invalid, unreadable, and future
 * settings all fail closed without changing the file on disk.
 */
export function loadTelemetrySettings(): TelemetrySettings {
  return readTelemetrySettings().settings;
}

export function setTelemetryConsent(lane: TelemetryLane | "all", enabled: boolean): boolean {
  if (typeof enabled !== "boolean") return false;
  if (lane === "all") return setTelemetryConsents({ analytics: enabled, errors: enabled });
  if (lane !== "analytics" && lane !== "errors") return false;
  return setTelemetryConsents({ [lane]: enabled });
}

/** Persist one or both explicit consent decisions while keeping the lanes independent. */
export function setTelemetryConsents(consents: TelemetryConsentUpdate): boolean {
  const current = readTelemetrySettings();
  if (current.status === "unsupported") return false;
  const settings = current.status === "current" ? current.settings : emptyTelemetrySettings();
  let hasDecision = false;

  if (typeof consents.analytics === "boolean") {
    settings.analytics = consents.analytics;
    hasDecision = true;
  }
  if (typeof consents.errors === "boolean") {
    settings.errors = consents.errors;
    hasDecision = true;
  }

  return hasDecision ? writeTelemetrySettings(settings) : false;
}

/** Environment overrides are master switches and take precedence over persisted consent. */
export function telemetryDisabledByEnvironment(): TelemetryEnvironmentOverride | undefined {
  if (isEnabledEnvironmentFlag(process.env.DO_NOT_TRACK)) return "DO_NOT_TRACK";
  if (isEnabledEnvironmentFlag(process.env.DOSU_TELEMETRY_DISABLED)) {
    return "DOSU_TELEMETRY_DISABLED";
  }
  return undefined;
}

/** Unset consent is disabled; collection starts only after an explicit persisted enable. */
export function isTelemetryEnabled(lane: TelemetryLane): boolean {
  if (telemetryDisabledByEnvironment() !== undefined) return false;
  return loadTelemetrySettings()[lane] === true;
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

/** Explicitly rotate the installation UUID, preserving understood consent decisions. */
export function resetInstallID(): string | undefined {
  const current = readTelemetrySettings();
  if (current.status === "unsupported") return undefined;
  const settings = current.status === "current" ? current.settings : emptyTelemetrySettings();
  const installID = randomUUID();
  settings.install_id = installID;
  return writeTelemetrySettings(settings) ? installID : undefined;
}

function readTelemetrySettings(): SettingsReadResult {
  const path = getTelemetrySettingsPath();
  try {
    if (!existsSync(path)) return { status: "missing", settings: emptyTelemetrySettings() };
  } catch {
    return { status: "error", settings: emptyTelemetrySettings() };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return { status: "invalid", settings: emptyTelemetrySettings() };
  }

  if (!isRecord(raw)) return { status: "invalid", settings: emptyTelemetrySettings() };
  if (raw.schema_version !== TELEMETRY_SCHEMA_VERSION) {
    const status = "schema_version" in raw ? "unsupported" : "invalid";
    return { status, settings: emptyTelemetrySettings() };
  }

  const settings = emptyTelemetrySettings();
  if (typeof raw.analytics === "boolean") settings.analytics = raw.analytics;
  if (typeof raw.errors === "boolean") settings.errors = raw.errors;
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
