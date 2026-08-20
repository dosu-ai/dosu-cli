import { existsSync, readFileSync } from "node:fs";
import { writeSecureFile } from "../mcp/config-helpers";
import { driveStatePath, ensureDriveHome } from "./paths";
import {
  DRIVE_PROTOCOL_VERSION,
  DRIVE_STATE_SCHEMA_VERSION,
  type DriveConnection,
  type DriveState,
} from "./types";

export function emptyDriveState(): DriveState {
  return { schemaVersion: DRIVE_STATE_SCHEMA_VERSION, recentRepositories: [] };
}

export function loadDriveState(): DriveState {
  const path = driveStatePath();
  if (!existsSync(path)) return emptyDriveState();
  try {
    return parseDriveState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return emptyDriveState();
  }
}

export function saveDriveState(state: DriveState): void {
  ensureDriveHome();
  writeSecureFile(driveStatePath(), `${JSON.stringify(parseDriveState(state), null, 2)}\n`);
}

export function setActiveDrive(connection: DriveConnection): DriveState {
  const state = loadDriveState();
  state.active = parseConnection(connection);
  saveDriveState(state);
  return state;
}

export function rememberRepositories(paths: readonly string[]): DriveState {
  const state = loadDriveState();
  state.recentRepositories = [
    ...new Set([...paths.filter(Boolean), ...state.recentRepositories]),
  ].slice(0, 20);
  saveDriveState(state);
  return state;
}

function parseDriveState(value: unknown): DriveState {
  if (!isRecord(value) || value.schemaVersion !== DRIVE_STATE_SCHEMA_VERSION) {
    return emptyDriveState();
  }
  const active = isRecord(value.active) ? safeConnection(value.active) : undefined;
  const recentRepositories = Array.isArray(value.recentRepositories)
    ? value.recentRepositories.filter((item): item is string => typeof item === "string")
    : [];
  return {
    schemaVersion: DRIVE_STATE_SCHEMA_VERSION,
    ...(active ? { active } : {}),
    recentRepositories: [...new Set(recentRepositories)].slice(0, 20),
  };
}

function parseConnection(value: DriveConnection): DriveConnection {
  const parsed = safeConnection(value);
  if (!parsed) throw new Error("Invalid Drive connection");
  return parsed;
}

function safeConnection(value: unknown): DriveConnection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.url !== "string" ||
    value.protocolVersion !== DRIVE_PROTOCOL_VERSION ||
    typeof value.local !== "boolean"
  ) {
    return undefined;
  }
  try {
    const url = new URL(value.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    url: value.url.replace(/\/$/, ""),
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    local: value.local,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
