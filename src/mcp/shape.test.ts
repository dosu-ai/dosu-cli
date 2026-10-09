import { describe, expect, it } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";
import { getBackendURL } from "../config/constants";
import { ANY, entryHasShape, hasShape, shapeEndpoint } from "./shape";

const session = { access_token: "at", refresh_token: "rt", expires_at: 0 };

describe("hasShape", () => {
  it("matches equal scalars, arrays, and objects regardless of key order", () => {
    expect(hasShape("a", "a")).toBe(true);
    expect(hasShape(true, true)).toBe(true);
    expect(hasShape(["x", "y"], ["x", "y"])).toBe(true);
    expect(hasShape({ a: 1, b: { c: "d" } }, { b: { c: "d" }, a: 1 })).toBe(true);
  });

  it("rejects a different value, type, or array length", () => {
    expect(hasShape("a", "b")).toBe(false);
    expect(hasShape("a", 1)).toBe(false);
    expect(hasShape(true, "true")).toBe(false);
    expect(hasShape(["x"], ["x", "y"])).toBe(false);
    expect(hasShape(["x"], "x")).toBe(false);
    expect(hasShape({ a: 1 }, [1])).toBe(false);
    expect(hasShape({ a: 1 }, null)).toBe(false);
  });

  it("rejects a missing or an extra key", () => {
    expect(hasShape({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(hasShape({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(hasShape({ a: undefined }, { b: undefined })).toBe(false);
  });

  it("rejects an entry that is absent", () => {
    expect(hasShape({ a: 1 }, undefined)).toBe(false);
  });

  it("accepts any text in an open slot and keeps the text around it exact", () => {
    const expected = { url: `${ANY}/v1/mcp/deployments/${ANY}`, key: ANY };
    expect(hasShape(expected, { url: "https://a.example/v1/mcp/deployments/d1", key: "k" })).toBe(
      true,
    );
    expect(hasShape(expected, { url: "https://a.example/v2/mcp/deployments/d1", key: "k" })).toBe(
      false,
    );
    expect(hasShape(expected, { url: "https://a.example/v1/mcp/deployments/d1", key: 7 })).toBe(
      false,
    );
  });

  it("treats regex characters in the fixed text literally", () => {
    expect(hasShape(`${ANY}/a.b(c)`, "x/a.b(c)")).toBe(true);
    expect(hasShape(`${ANY}/a.b(c)`, "x/aXb(c)")).toBe(false);
  });
});

describe("entryHasShape", () => {
  it("ignores the on/off, tool, and timeout keys an agent sets from its own UI", () => {
    const expected = { url: "u", disabled: false };
    expect(entryHasShape(expected, { url: "u", disabled: true, autoApprove: ["t"] })).toBe(true);
    expect(entryHasShape(expected, { url: "u" })).toBe(true);
    expect(entryHasShape({ url: "u" }, { url: "u", enabled: false, timeout: 30 })).toBe(true);
  });

  it("still compares every other key", () => {
    expect(entryHasShape({ url: "u" }, { url: "u", alwaysLoad: true })).toBe(false);
    expect(entryHasShape({ url: "u", alwaysLoad: true }, { url: "u", disabled: true })).toBe(false);
    expect(entryHasShape({ url: "u" }, undefined)).toBe(false);
  });
});

describe("shapeEndpoint", () => {
  it("leaves the backend and deployment open for a cloud config", () => {
    const cfg = makeTestConfig({ ...session, deployment_id: "dep-1", api_key: "k" });
    const shape = shapeEndpoint(cfg);
    expect(shape).toBe(`${ANY}/v1/mcp/deployments/${ANY}`);
    expect(hasShape(shape, `${getBackendURL()}/v1/mcp/deployments/dep-2`)).toBe(true);
    expect(hasShape(shape, `${getBackendURL()}/v1/mcp`)).toBe(false);
  });

  it("uses the cloud form when no config is available", () => {
    expect(shapeEndpoint(undefined)).toBe(`${ANY}/v1/mcp/deployments/${ANY}`);
  });

  it("uses the deployment-less form in OSS mode", () => {
    const shape = shapeEndpoint(makeTestConfig({ ...session, mode: "oss" }));
    expect(shape).toBe(`${ANY}/v1/mcp`);
    expect(hasShape(shape, `${getBackendURL()}/v1/mcp`)).toBe(true);
  });
});
