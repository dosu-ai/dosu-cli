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

export function hostedDrivesDir(): string {
  return join(driveHome(), "drives");
}
