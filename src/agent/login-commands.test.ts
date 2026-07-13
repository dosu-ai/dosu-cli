import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockMintTicket, mockExchangeTicket, mockLoadConfig, mockSaveConfig } = vi.hoisted(() => ({
  mockMintTicket: vi.fn(),
  mockExchangeTicket: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockSaveConfig: vi.fn(),
}));

vi.mock("../auth/ticket", () => ({
  mintTicket: mockMintTicket,
  exchangeTicket: mockExchangeTicket,
}));

vi.mock("../config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config")>()),
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test.log"),
  },
}));

import { runLoginCheck, runLoginRequest } from "./login-commands";

describe("runLoginRequest", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockMintTicket.mockReset();
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emits NDJSON with ticket, url, check_command, and agent_next_steps when --json", async () => {
    mockMintTicket.mockResolvedValue({
      ticket: "tkt-abc",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-abc",
    });

    const code = await runLoginRequest({ json: true });

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toEqual({
      ticket: "tkt-abc",
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-abc",
      check_command: "dosu login --check tkt-abc --json",
      expires_in: 600,
      agent_next_steps: expect.stringContaining("Give the URL"),
    });
  });

  it("prints a human-readable message when --json is omitted", async () => {
    mockMintTicket.mockResolvedValue({
      ticket: "tkt-xyz",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-xyz",
    });

    const code = await runLoginRequest({ json: false });

    expect(code).toBe(0);
    const joined = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("https://app.dosu.dev/cli/auth?ticket=tkt-xyz");
    expect(joined).toContain("dosu login --check tkt-xyz");
    // No --json suffix when the user did not opt in.
    expect(joined).not.toMatch(/--check tkt-xyz --json/);
  });

  it("emits a structured error when minting fails (--json)", async () => {
    mockMintTicket.mockRejectedValue(new Error("network down"));

    const code = await runLoginRequest({ json: true });

    expect(code).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      step: "request",
      status: "error",
      reason: "mint_failed",
    });
  });

  it("prints a human-readable error when minting fails (no --json)", async () => {
    mockMintTicket.mockRejectedValue(new Error("network down"));

    const code = await runLoginRequest({ json: false });

    expect(code).toBe(1);
    const joined = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Failed to mint login ticket: network down");
  });

  it("stringifies non-Error rejections when minting fails (no --json)", async () => {
    mockMintTicket.mockRejectedValue("boom");

    const code = await runLoginRequest({ json: false });

    expect(code).toBe(1);
    const joined = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Failed to mint login ticket: boom");
  });
});

describe("runLoginCheck", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockExchangeTicket.mockReset();
    mockLoadConfig.mockReset();
    mockSaveConfig.mockReset();
    mockLoadConfig.mockReturnValue({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("saves tokens and emits authenticated NDJSON when ticket is ready", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 1800,
      email: "user@example.com",
    });

    const code = await runLoginCheck({ ticket: "tkt", json: true });

    expect(code).toBe(0);
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const saved = mockSaveConfig.mock.calls[0]?.[0] as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(saved.access_token).toBe("tok");
    expect(saved.refresh_token).toBe("ref");
    expect(saved.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      step: "check",
      status: "authenticated",
      email: "user@example.com",
    });
    expect(payload.agent_next_steps).toMatch(/Authentication complete/);
  });

  it("emits pending NDJSON and returns 0 when user has not signed in yet", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "pending" });

    const code = await runLoginCheck({ ticket: "tkt", json: true });

    expect(code).toBe(0);
    expect(mockSaveConfig).not.toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      step: "check",
      status: "pending",
      ticket: "tkt",
    });
  });

  it("emits expired NDJSON and returns 1 when ticket is gone", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "expired" });

    const code = await runLoginCheck({ ticket: "tkt", json: true });

    expect(code).toBe(1);
    expect(mockSaveConfig).not.toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      step: "check",
      status: "expired",
    });
  });

  it("prints a human-readable success message in non-JSON mode", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
      email: "user@example.com",
    });

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(0);
    const joined = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Successfully authenticated");
    expect(joined).toContain("user@example.com");
  });

  it("emits a structured error when exchange throws (--json)", async () => {
    mockExchangeTicket.mockRejectedValue(new Error("network down"));

    const code = await runLoginCheck({ ticket: "tkt", json: true });

    expect(code).toBe(1);
    expect(mockSaveConfig).not.toHaveBeenCalled();
    const payload = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      step: "check",
      status: "error",
      reason: "exchange_failed",
    });
  });

  it("prints a human-readable error when exchange throws (no --json)", async () => {
    mockExchangeTicket.mockRejectedValue(new Error("network down"));

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(1);
    const joined = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Ticket exchange failed: network down");
  });

  it("stringifies non-Error rejections when exchange throws (no --json)", async () => {
    mockExchangeTicket.mockRejectedValue("boom");

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(1);
    const joined = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Ticket exchange failed: boom");
  });

  it("falls back to defaults when authenticated response omits tokens", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "authenticated" });

    const code = await runLoginCheck({ ticket: "tkt", json: true });

    expect(code).toBe(0);
    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    const saved = mockSaveConfig.mock.calls[0]?.[0] as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(saved.access_token).toBe("");
    expect(saved.refresh_token).toBe("");
    // 3600s fallback applied.
    expect(saved.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3000);
  });

  it("omits the email line in non-JSON mode when no email is returned", async () => {
    mockExchangeTicket.mockResolvedValue({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 3600,
    });

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(0);
    const joined = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Successfully authenticated");
    expect(joined).not.toContain("Signed in as");
  });

  it("prints a human-readable pending message in non-JSON mode", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "pending" });

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(0);
    expect(mockSaveConfig).not.toHaveBeenCalled();
    const joined = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Still waiting for the user to complete sign-in");
  });

  it("prints a human-readable expired message in non-JSON mode", async () => {
    mockExchangeTicket.mockResolvedValue({ status: "expired" });

    const code = await runLoginCheck({ ticket: "tkt", json: false });

    expect(code).toBe(1);
    expect(mockSaveConfig).not.toHaveBeenCalled();
    const joined = errSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(joined).toContain("Ticket has expired or was already used");
  });
});
