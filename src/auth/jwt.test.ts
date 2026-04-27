import { describe, expect, it } from "vitest";
import { decodeJwtPayload, userIdFromAccessToken } from "./jwt";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.signature`;
}

describe("decodeJwtPayload", () => {
  it("returns the payload of a well-formed token", () => {
    const token = makeJwt({ sub: "user-123", email: "a@b.com", exp: 1700000000 });
    expect(decodeJwtPayload(token)).toEqual({
      sub: "user-123",
      email: "a@b.com",
      exp: 1700000000,
    });
  });

  it("returns null for an empty string", () => {
    expect(decodeJwtPayload("")).toBeNull();
  });

  it("returns null when the token has fewer than two segments", () => {
    expect(decodeJwtPayload("only-one-segment")).toBeNull();
  });

  it("decodes payloads that need base64url padding", () => {
    // A short payload whose base64 encoding length is not a multiple of 4
    // (forces the padding branch).
    const token = makeJwt({ a: 1 });
    expect(decodeJwtPayload(token)).toEqual({ a: 1 });
  });

  it("decodes payloads that include - and _ base64url characters", () => {
    const raw = Buffer.from('{"sub":"???"}').toString("base64");
    expect(raw).toContain("/");
    const b64url = raw.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const token = `header.${b64url}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ sub: "???" });
  });

  it("returns null when the payload is not valid JSON", () => {
    const garbage = Buffer.from("not-json").toString("base64").replace(/=+$/, "");
    expect(decodeJwtPayload(`header.${garbage}.sig`)).toBeNull();
  });

  it("returns null when the payload is JSON but not an object", () => {
    const arr = Buffer.from("123").toString("base64").replace(/=+$/, "");
    expect(decodeJwtPayload(`header.${arr}.sig`)).toBeNull();
  });

  it("returns null when the payload is the JSON literal null", () => {
    const literalNull = Buffer.from("null").toString("base64").replace(/=+$/, "");
    expect(decodeJwtPayload(`header.${literalNull}.sig`)).toBeNull();
  });
});

describe("userIdFromAccessToken", () => {
  it("returns the sub claim from a valid token", () => {
    const token = makeJwt({ sub: "user-abc" });
    expect(userIdFromAccessToken(token)).toBe("user-abc");
  });

  it("returns null when the token cannot be decoded", () => {
    expect(userIdFromAccessToken("malformed")).toBeNull();
  });

  it("returns null when the sub claim is missing", () => {
    const token = makeJwt({ email: "a@b.com" });
    expect(userIdFromAccessToken(token)).toBeNull();
  });

  it("returns null when the sub claim is not a string", () => {
    const token = makeJwt({ sub: 12345 });
    expect(userIdFromAccessToken(token)).toBeNull();
  });

  it("returns null when the sub claim is an empty string", () => {
    const token = makeJwt({ sub: "" });
    expect(userIdFromAccessToken(token)).toBeNull();
  });
});
