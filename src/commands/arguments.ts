import { InvalidArgumentError } from "commander";

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
