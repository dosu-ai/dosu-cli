import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
vi.mock("../client/trpc", () => ({
  TrpcClient: vi.fn().mockImplementation(() => ({ query: mockQuery, mutate: vi.fn() })),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { orgCommand } from "./org";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: "org1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = orgCommand();
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

describe("org info", () => {
  it("calls organization.getOrganizations", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "org1", name: "Acme" }]);
    await run("info");
    expect(mockQuery).toHaveBeenCalledWith("organization.getOrganizations", {});
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "org1", name: "Acme" }]);
    await run("info", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("info");
    expect(allOutput()).toContain("No organizations found");
  });

  it("prints single org as key-value info", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ id: "org1", name: "Acme" }]);
    await run("info");
    const output = allOutput();
    expect(output).toContain("Acme");
    expect(output).toContain("org1");
  });

  it("prints multiple orgs as table", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { id: "org1-full-uuid", name: "Acme" },
      { id: "org2-full-uuid", name: "Beta" },
    ]);
    await run("info");
    const output = allOutput();
    expect(output).toContain("Acme");
    expect(output).toContain("Beta");
  });

  it("shows current org hint for multiple orgs when org_id is set", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([
      { id: "org1", name: "Acme" },
      { id: "org2", name: "Beta" },
    ]);
    await run("info");
    expect(allOutput()).toContain("Current:");
  });
});

describe("requireConfig", () => {
  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("info")).rejects.toThrow("exit");
  });
});
