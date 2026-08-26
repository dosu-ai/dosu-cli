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

describe("members command surface", () => {
  it("only exposes the organization invite operation supported by CLI tRPC", () => {
    expect(membersCommand().commands.map((command) => command.name())).toEqual(["invite"]);
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

  it("rejects unsupported roles before calling tRPC", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("invite", "new@user.com", "--role", "owner")).rejects.toThrow();
    expect(mockMutate).not.toHaveBeenCalled();
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

describe("requireConfig", () => {
  it("exits when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ org_id: undefined }));
    await expect(run("invite", "new@user.com")).rejects.toThrow("exit");
  });

  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("invite", "new@user.com")).rejects.toThrow("exit");
  });
});
