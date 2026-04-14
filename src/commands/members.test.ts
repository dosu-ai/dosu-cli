import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockMutate = vi.fn();
vi.mock("../client/trpc", () => ({
  TrpcClient: vi.fn().mockImplementation(() => ({ query: mockQuery, mutate: mockMutate })),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { membersCommand } from "./members";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  it("calls invitations.getInvitations with org_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ email: "a@b.com", role: "ADMIN", status: "accepted" }]);

    await run("list");

    expect(mockQuery).toHaveBeenCalledWith("invitations.getInvitations", { orgId: "org1" });
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ email: "a@b.com" }]);
    await run("list", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("list");
    expect(allOutput()).toContain("No members");
  });

  it("handles missing role and status fields", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ email: "a@b.com" }]);
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
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("invite", "new@user.com");
    expect(allOutput()).toContain("Invitation sent to new@user.com as MEMBER");
  });
});

describe("members remove", () => {
  it("calls invitations.removeMember with email", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("remove", "old@user.com");

    expect(mockMutate).toHaveBeenCalledWith("invitations.removeMember", {
      orgId: "org1",
      email: "old@user.com",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("remove", "--json", "old@user.com");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.email).toBe("old@user.com");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("remove", "old@user.com");
    expect(allOutput()).toContain("Member old@user.com removed");
  });
});

describe("members approve", () => {
  it("calls invitations.approveAccessRequest", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "req@user.com");

    expect(mockMutate).toHaveBeenCalledWith("invitations.approveAccessRequest", {
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
    mockQuery.mockResolvedValueOnce([{ email: "req@user.com", requested_at: "2024-01-01" }]);
    await run("requests");
    expect(allOutput()).toContain("req@user.com");
  });

  it("prints message for empty requests", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([]);
    await run("requests");
    expect(allOutput()).toContain("No pending access requests");
  });

  it("handles missing requested_at field", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ email: "req@user.com" }]);
    await run("requests");
    const output = allOutput();
    expect(output).toContain("req@user.com");
    expect(output).toContain("—");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce([{ email: "req@user.com", requested_at: "2024-01-01" }]);
    await run("requests", "--json");
    expect(() => JSON.parse(allOutput())).not.toThrow();
  });
});

describe("requireConfig", () => {
  it("exits when org_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, org_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
