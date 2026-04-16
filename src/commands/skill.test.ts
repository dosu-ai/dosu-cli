import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { skillCommand } from "./skill";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function allErrors(): string {
  return errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = skillCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockExecSync.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("skill install", () => {
  it("runs npx skills add with correct args", async () => {
    await run("install");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills add dosu-ai/dosu-skill -g -s dosu -y", {
      stdio: "inherit",
    });
  });

  it("prints success message", async () => {
    await run("install");
    expect(allOutput()).toContain("installed successfully");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("install")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to install skill");
  });
});

describe("skill remove", () => {
  it("runs npx skills remove with correct args", async () => {
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g -s dosu -y", {
      stdio: "inherit",
    });
  });

  it("prints success message", async () => {
    await run("remove");
    expect(allOutput()).toContain("removed");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("remove")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to remove skill");
  });
});

describe("skill update", () => {
  it("runs npx skills update with correct args", async () => {
    await run("update");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills update dosu -g", {
      stdio: "inherit",
    });
  });

  it("prints success message", async () => {
    await run("update");
    expect(allOutput()).toContain("updated");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("update")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to update skill");
  });
});
