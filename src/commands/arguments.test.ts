import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { isUuid, uuid } from "./arguments";

const V4 = "9a415b4b-fe96-4abe-a89d-1c4539899447";
const V7 = "01926b3e-8f2a-7c1d-9e4f-3a5b6c7d8e9f";

describe("isUuid", () => {
  it("accepts a full RFC 4122 UUID of any version", () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuid(V7)).toBe(true);
    expect(isUuid(V4.toUpperCase())).toBe(true);
  });

  it("rejects truncated prefixes and non-UUID strings", () => {
    expect(isUuid(V4.slice(0, 8))).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(`${V4} `)).toBe(false);
  });
});

describe("uuid", () => {
  it("returns a valid UUID unchanged", () => {
    expect(uuid(V4)).toBe(V4);
  });

  it("throws InvalidArgumentError for anything that is not a full UUID", () => {
    expect(() => uuid(V4.slice(0, 8))).toThrow(InvalidArgumentError);
    expect(() => uuid("abc")).toThrow("must be a UUID");
  });
});
