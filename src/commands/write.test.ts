import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDoRequest = vi.fn();
vi.mock("../client/client", () => ({
  Client: vi.fn().mockImplementation(() => ({ doRequest: mockDoRequest })),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { writeCommand } from "./write";

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  deployment_id: "dep-1",
  deployment_name: "Default MCP",
  org_id: "org1",
  space_id: "sp1",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

beforeEach(() => {
  mockDoRequest.mockReset();
  mockLoadConfig.mockReset();
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

async function run(...args: string[]) {
  const cmd = writeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

function errorOutput(): string {
  return errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("dosu write", () => {
  it("rejects empty string before any network call", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("")).rejects.toThrow("exit");
    expect(errorOutput()).toContain("fact cannot be empty or whitespace-only");
    expect(mockDoRequest).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only string before any network call", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("   \t\n  ")).rejects.toThrow("exit");
    expect(errorOutput()).toContain("fact cannot be empty or whitespace-only");
    expect(mockDoRequest).not.toHaveBeenCalled();
  });

  it("sends a trimmed body when the fact has surrounding whitespace", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockDoRequest.mockResolvedValue(new Response("{}", { status: 200 }));

    await run("  TOKEN_TTL=3600 is intentional, do not change.  ");

    expect(mockDoRequest).toHaveBeenCalledTimes(1);
    const [method, path, body] = mockDoRequest.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/v1/topics");
    expect(body.context).toBe("TOKEN_TTL=3600 is intentional, do not change.");
    // name = first 8 whitespace-separated words of the trimmed content
    expect(body.name.startsWith("TOKEN_TTL=3600")).toBe(true);
  });

  it("exits with helpful guidance on backend error", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockDoRequest.mockResolvedValue(
      new Response(JSON.stringify({ detail: "knowledge store not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(run("a real fact")).rejects.toThrow("exit");
    expect(errorOutput()).toContain("knowledge store not found");
    expect(errorOutput()).toContain("dosu logs --tail 30");
  });

  it("exits when not configured (no api_key)", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });

    await expect(run("a fact")).rejects.toThrow("exit");
    expect(errorOutput()).toContain("Not configured");
    expect(mockDoRequest).not.toHaveBeenCalled();
  });
});
