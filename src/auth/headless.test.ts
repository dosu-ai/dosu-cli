import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHeadless } from "./headless";

describe("isHeadless", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalIsTTY = process.stdin.isTTY;
    // Default: interactive terminal, no SSH env vars
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    for (const key of [
      "SSH_CLIENT",
      "SSH_TTY",
      "SSH_CONNECTION",
      "CI",
      "GITHUB_ACTIONS",
      "CODESPACE_NAME",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("returns false in a normal interactive terminal", () => {
    expect(isHeadless()).toBe(false);
  });

  it("returns true when stdin is not a TTY", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    expect(isHeadless()).toBe(true);
  });

  it("returns true when stdin.isTTY is undefined (piped)", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    expect(isHeadless()).toBe(true);
  });

  it("returns true when process.stdin is null (e.g. stdio:ignore spawn)", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: null, configurable: true });
    expect(isHeadless()).toBe(true);
    Object.defineProperty(
      process,
      "stdin",
      descriptor ?? { value: process.stdin, configurable: true },
    );
  });

  it("returns true when SSH_CLIENT is set", () => {
    process.env.SSH_CLIENT = "10.0.0.1 12345 22";
    expect(isHeadless()).toBe(true);
  });

  it("returns true when SSH_TTY is set", () => {
    process.env.SSH_TTY = "/dev/pts/0";
    expect(isHeadless()).toBe(true);
  });

  it("returns true when SSH_CONNECTION is set", () => {
    process.env.SSH_CONNECTION = "10.0.0.1 12345 10.0.0.2 22";
    expect(isHeadless()).toBe(true);
  });

  it("returns true when CI is set", () => {
    process.env.CI = "true";
    expect(isHeadless()).toBe(true);
  });

  it("returns true when GITHUB_ACTIONS is set", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(isHeadless()).toBe(true);
  });

  it("returns true when CODESPACE_NAME is set", () => {
    process.env.CODESPACE_NAME = "my-codespace-abc";
    expect(isHeadless()).toBe(true);
  });
});
