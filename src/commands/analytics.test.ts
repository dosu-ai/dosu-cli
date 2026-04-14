import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
vi.mock("../client/trpc", () => ({
  TrpcClient: vi.fn().mockImplementation(() => ({ query: mockQuery, mutate: vi.fn() })),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { analyticsCommand } from "./analytics";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = analyticsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
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

describe("analytics", () => {
  it("calls analytics.getUsageStats with space_id and default 30 days", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ total_responses: 42, answer_rate: 0.85 });

    await run();

    expect(mockQuery).toHaveBeenCalledWith("analytics.getUsageStats", {
      spaceId: "sp1",
      days: 30,
    });
  });

  it("passes --days parameter", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ total_responses: 10 });

    await run("--days", "7");

    expect(mockQuery.mock.calls[0][1].days).toBe(7);
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ total_responses: 42, answer_rate: 0.85 });

    await run("--json");

    const output = JSON.parse(allOutput());
    expect(output.total_responses).toBe(42);
  });

  it("formats percentage values in human output", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      total_responses: 100,
      answer_rate: 0.856,
      positive_rate: 0.923,
    });

    await run();

    const output = allOutput();
    expect(output).toContain("100");
    expect(output).toContain("85.6%");
    expect(output).toContain("92.3%");
  });

  it("handles undefined stats values with fallback defaults", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({});

    await run();

    const output = allOutput();
    // Should show "0" for undefined counts and "—" for undefined percentages
    expect(output).toContain("0");
    expect(output).toContain("—");
  });
});

describe("requireConfig", () => {
  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run()).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run()).rejects.toThrow("exit");
  });
});
