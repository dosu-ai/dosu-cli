import { InvalidArgumentError } from "commander";
import type { CliJson } from "../generated/dosu-api-types";

export function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

export function positiveIntegerAtMost(maximum: number): (value: string) => number {
  return (value: string) => {
    const parsed = positiveInteger(value);
    if (parsed > maximum) {
      throw new InvalidArgumentError(`must be at most ${maximum}`);
    }
    return parsed;
  };
}

export function messageLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (parsed !== -1 && parsed <= 0)) {
    throw new InvalidArgumentError("must be -1 or a positive integer");
  }
  return parsed;
}

export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidArgumentError("must be a UUID");
  }
  return value;
}

export function uuidV4(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InvalidArgumentError("must be a UUID v4");
  }
  return value;
}

export function jsonValue(value: string): CliJson {
  try {
    return JSON.parse(value) as CliJson;
  } catch {
    throw new InvalidArgumentError("must be valid JSON");
  }
}

export function jsonStringArray(value: string): string[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new InvalidArgumentError("must be a JSON array of strings");
  }
  return parsed;
}

export function onOrOff(value: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new InvalidArgumentError("must be 'on' or 'off'");
}

export function boundedText(maximum: number): (value: string) => string {
  return (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) throw new InvalidArgumentError("must not be empty");
    if (trimmed.length > maximum) {
      throw new InvalidArgumentError(`must be at most ${maximum} characters`);
    }
    return trimmed;
  };
}
