import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockMutate = vi.fn();

function createMockProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
      if (prop === "mutate") return (input: unknown) => mockMutate(path.join("."), input);
      return createMockProxy([...path, prop]);
    },
  });
}

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn().mockImplementation(() => createMockProxy()),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { membersCommand } from "./members";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  org_id: "org1",
};
const makeValidConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...validFlatConfig, ...overrides });
const validConfig = makeValidConfig();

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = membersCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
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

describe("members list", () => {
  it("calls invitations.getInvitations with no args", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "a@b.com", org: { name: "Acme" } }],
      tokenAvailable: true,
      authProvider: "email",
    });

    await run("list");

    expect(mockQuery).toHaveBeenCalledWith("invitations.getInvitations", undefined);
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "a@b.com" }],
      tokenAvailable: true,
      authProvider: "email",
    });
    await run("list", "--json");
    const output = JSON.parse(allOutput());
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({ email: "a@b.com" });
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ items: [], tokenAvailable: true, authProvider: "email" });
    await run("list");
    expect(allOutput()).toContain("No members");
  });

  it("handles missing role and status fields", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "a@b.com" }],
      tokenAvailable: true,
      authProvider: "email",
    });
    await run("list");
    const output = allOutput();
    expect(output).toContain("a@b.com");
    expect(output).toContain("—");
  });
});

describe("members invite", () => {
  it("calls invitations.invite with email and default role MEMBER", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("invite", "new@user.com");

    expect(mockMutate).toHaveBeenCalledWith("invitations.invite", {
      orgId: "org1",
      email: "new@user.com",
      role: "MEMBER",
    });
  });

  it("passes ADMIN role with --role admin", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("invite", "admin@user.com", "--role", "admin");

    expect(mockMutate.mock.calls[0][1].role).toBe("ADMIN");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "inv1" });
    await run("invite", "--json", "a@b.com");
    expect(JSON.parse(allOutput())).toMatchObject({
      success: true,
      email: "a@b.com",
      role: "MEMBER",
    });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("invite", "new@user.com");
    expect(allOutput()).toContain("Invitation sent to new@user.com as MEMBER");
  });
});

describe("members approve", () => {
  it("calls invitations.acceptInvitation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "req@user.com");

    expect(mockMutate).toHaveBeenCalledWith("invitations.acceptInvitation", {
      orgId: "org1",
      email: "req@user.com",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("approve", "--json", "req@user.com");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.action).toBe("approved");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("approve", "req@user.com");
    expect(allOutput()).toContain("Access request from req@user.com approved");
  });
});

describe("members deny", () => {
  it("calls invitations.rejectInvitation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("deny", "req@user.com");

    expect(mockMutate).toHaveBeenCalledWith("invitations.rejectInvitation", {
      orgId: "org1",
      email: "req@user.com",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("deny", "--json", "req@user.com");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.action).toBe("denied");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("deny", "req@user.com");
    expect(allOutput()).toContain("Access request from req@user.com denied");
  });
});

describe("members requests", () => {
  it("lists pending access requests", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "req@user.com", org: { name: "Acme" } }],
      tokenAvailable: true,
      authProvider: "email",
    });
    await run("requests");
    expect(allOutput()).toContain("req@user.com");
  });

  it("prints message for empty requests", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ items: [], tokenAvailable: true, authProvider: "email" });
    await run("requests");
    expect(allOutput()).toContain("No pending access requests");
  });

  it("handles missing org field", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "req@user.com" }],
      tokenAvailable: true,
      authProvider: "email",
    });
    await run("requests");
    const output = allOutput();
    expect(output).toContain("req@user.com");
    expect(output).toContain("—");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      items: [{ email: "req@user.com", org: { name: "Acme" } }],
      tokenAvailable: true,
      authProvider: "email",
    });
    await run("requests", "--json");
    const output = JSON.parse(allOutput());
    expect(output.items).toHaveLength(1);
    expect(output.items[0]).toMatchObject({ email: "req@user.com" });
  });
});

describe("requireConfig", () => {
  it("exits when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ org_id: undefined }));
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("list")).rejects.toThrow("exit");
  });
});
