import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/config";

export function driveHome(): string {
  return process.env.DOSU_DRIVE_HOME ?? join(getConfigDir(), "drive");
}

export function ensureDriveHome(): string {
  const dir = driveHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function driveStatePath(): string {
  return join(driveHome(), "state.json");
}

function hostedDrivesDir(): string {
  return join(driveHome(), "drives");
}

export function hostedDrivePointerPath(): string {
  return join(hostedDrivesDir(), "active.json");
}

export function hostedDriveDir(driveId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(driveId)) throw new Error("Invalid Drive ID");
  return join(hostedDrivesDir(), driveId);
}
