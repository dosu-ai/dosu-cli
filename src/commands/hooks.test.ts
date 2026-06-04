import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));

vi.mock("../hooks/state", () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  clearState: vi.fn(),
}));

vi.mock("../hooks/ticket-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/ticket-client")>();
  return { ...actual, requestCreateTicket: vi.fn(), requestGetTicket: vi.fn() };
});

vi.mock("../config/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config")>();
  return { ...actual, loadConfig: vi.fn() };
});

vi.mock("../client/client", () => ({
  Client: vi.fn(() => ({ validateAPIKey: vi.fn(async () => true) })),
}));

import { Client } from "../client/client";
import { loadConfig } from "../config/config";
import { loadState, saveState, type TicketState } from "../hooks/state";
import { requestCreateTicket, requestGetTicket, TicketHttpError } from "../hooks/ticket-client";
import {
  collectDoctorChecks,
  runDoctor,
  runHookEntrypoint,
  runInstall,
  runPostToolUse,
  runStatus,
  runStop,
  runUninstall,
  runUserPromptSubmit,
} from "./hooks";

const AUTHED = {
  access_token: "at",
  refresh_token: "rt",
  expires_at: Date.now() + 3_600_000,
  deployment_id: "dep-1",
  deployment_name: "My Deploy",
  api_key: "key-abc",
};

function pending(overrides: Partial<TicketState> = {}): TicketState {
  return {
    ticketId: "kt_1",
    sessionId: "sess",
    status: "pending",
    createdAt: 0,
    expiresAt: 1_000_000,
    ...overrides,
  };
}

function readyResp(context = "ROUTE MAP") {
  return {
    ticket_id: "kt_1",
    status: "ready" as const,
    created_at: "x",
    expires_at: "y",
    result: { context, sources: [], attribution: "attr" },
    error: null,
  };
}

let logSpy: MockInstance;
let errSpy: MockInstance;

function stdout(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockReturnValue({ ...AUTHED });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  process.exitCode = 0;
});

describe("runUserPromptSubmit", () => {
  it("creates a ticket, stores pending state, and injects the lookup note", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockResolvedValue({
      ticket_id: "kt_new",
      status: "pending",
      created_at: "x",
      expires_at: "y",
    });

    await runUserPromptSubmit(
      { session_id: "sess", turn_id: "t1", prompt: "investigate X", cwd: "/Users/me/work/myrepo" },
      10_000,
    );

    const arg = vi.mocked(requestCreateTicket).mock.calls[0][1];
    expect(arg).toMatchObject({
      agent: "claude-code",
      session_id: "sess",
      prompt: "investigate X",
      repo: "myrepo",
      turn_id: "t1",
    });
    expect(arg).not.toHaveProperty("cwd"); // absolute path is never sent
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: "kt_new",
        status: "pending",
        createdAt: 10_000,
        expiresAt: 610_000,
      }),
    );
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(printed.hookSpecificOutput.additionalContext).toContain("Keep working normally");
  });

  it("no-ops without a session id, an empty prompt, or when not configured", async () => {
    await runUserPromptSubmit({ prompt: "x" });
    await runUserPromptSubmit({ session_id: "s", prompt: "   " });
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, deployment_id: undefined });
    await runUserPromptSubmit({ session_id: "s", prompt: "real" });
    expect(requestCreateTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("reuses a live pending ticket instead of minting a second", async () => {
    vi.mocked(loadState).mockReturnValue(pending({ expiresAt: 999_999 }));
    await runUserPromptSubmit({ session_id: "sess", prompt: "another prompt" }, 1000);
    expect(requestCreateTicket).not.toHaveBeenCalled();
  });

  it("is silent and writes no state when create fails", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockRejectedValue(new TicketHttpError(500));
    await runUserPromptSubmit({ session_id: "sess", prompt: "x" });
    expect(saveState).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });
});

describe("runPostToolUse", () => {
  it("does nothing (no poll, no output) when there is no active ticket", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    await runPostToolUse({ session_id: "sess" });
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("short-circuits terminal states without calling the server", async () => {
    for (const status of ["delivered", "failed", "expired"] as const) {
      vi.clearAllMocks();
      vi.mocked(loadConfig).mockReturnValue({ ...AUTHED });
      vi.mocked(loadState).mockReturnValue(pending({ status }));
      await runPostToolUse({ session_id: "sess" }, 500);
      expect(requestGetTicket).not.toHaveBeenCalled();
    }
  });

  it("marks expired and skips the poll once past the TTL", async () => {
    vi.mocked(loadState).mockReturnValue(pending({ expiresAt: 100 }));
    await runPostToolUse({ session_id: "sess" }, 200);
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }));
    expect(requestGetTicket).not.toHaveBeenCalled();
  });

  it("respects the cooldown gate (at most one poll per window)", async () => {
    vi.mocked(loadState).mockReturnValue(pending({ lastCheckedAt: 1000 }));
    await runPostToolUse({ session_id: "sess" }, 1500); // 500ms < 3000ms default
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("delivers ready context exactly once and latches delivered", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue(readyResp("FAST PATH"));
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "delivered", deliveredAt: 50_000 }),
    );
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(printed.hookSpecificOutput.additionalContext).toContain("FAST PATH");
    expect(printed.hookSpecificOutput.additionalContext).toContain("verify adjacent");
  });

  it("appends a save nudge when the server recommends saving", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({
      ticket_id: "kt_1",
      status: "ready",
      created_at: "x",
      expires_at: "y",
      result: { context: "", sources: [], attribution: "attr", save_recommended: true },
      error: null,
    });
    await runPostToolUse({ session_id: "sess" }, 50_000);
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.hookSpecificOutput.additionalContext).toContain("save_topic");
  });

  it("marks delivered but injects nothing on ready with empty context and no save", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({
      ticket_id: "kt_1",
      status: "ready",
      created_at: "x",
      expires_at: "y",
      result: { context: "", sources: [], attribution: "attr" },
      error: null,
    });
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered" }));
    expect(stdout()).toBe("");
  });

  it("stays pending without output when the ticket is not ready", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({
      ticket_id: "kt_1",
      status: "pending",
      created_at: "x",
      expires_at: "y",
      result: null,
      error: null,
    });
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ lastCheckedAt: 50_000 }));
    expect(stdout()).toBe("");
  });

  it("skips the tick (keeps pending) on a transient error but fails on a definitive one", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockRejectedValueOnce(new TicketHttpError(503));
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(saveState).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "pending", lastCheckedAt: 50_000 }),
    );
    expect(stdout()).toBe("");

    vi.mocked(requestGetTicket).mockRejectedValueOnce(new TicketHttpError(404));
    await runPostToolUse({ session_id: "sess" }, 60_000);
    expect(saveState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("treats a ready response with no result as failed (never injects empty context)", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({ ...readyResp(), result: null });
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(stdout()).toBe("");
  });

  it("records the check but never polls when auth/deployment is missing", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, deployment_id: undefined });
    await runPostToolUse({ session_id: "sess" }, 50_000);
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ lastCheckedAt: 50_000 }));
    expect(stdout()).toBe("");
  });
});

describe("runStop (opt-in)", () => {
  it("continues without a session, on the loop-guard, or without a pending ticket", async () => {
    await runStop({});
    await runStop({ session_id: "s", stop_hook_active: true });
    vi.mocked(loadState).mockReturnValue(null);
    await runStop({ session_id: "s" });
    expect(requestGetTicket).not.toHaveBeenCalled();
    for (const call of logSpy.mock.calls) {
      expect(JSON.parse(call[0])).toEqual({ continue: true });
    }
  });

  it("blocks once with the route map when a ready ticket was missed", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue(readyResp("LATE CONTEXT"));
    await runStop({ session_id: "sess" }, 70_000);
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.decision).toBe("block");
    expect(printed.reason).toContain("LATE CONTEXT");
    expect(printed.reason).toContain("Re-check");
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered" }));
  });

  it("continues (never blocks) when the ticket is still pending", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({
      ticket_id: "kt_1",
      status: "pending",
      created_at: "x",
      expires_at: "y",
      result: null,
      error: null,
    });
    await runStop({ session_id: "sess" }, 70_000);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("continues on a poll error (never holds the agent open)", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockRejectedValue(new TicketHttpError(500));
    await runStop({ session_id: "sess" }, 70_000);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });
});

describe("runStatus", () => {
  it("prints a human summary for an active ticket", () => {
    vi.mocked(loadState).mockReturnValue(pending({ deliveredAt: 5 }));
    runStatus({ session_id: "sess" }, {}, 10);
    expect(stdout()).toContain("Ticket: kt_1");
    expect(stdout()).toContain("Delivered: yes");
  });

  it("emits JSON with derived flags under --json", () => {
    vi.mocked(loadState).mockReturnValue(pending({ expiresAt: 100 }));
    runStatus({ session_id: "sess" }, { json: true }, 200);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ expired: true, delivered: false });
  });

  it("reports no active ticket when there is none", () => {
    runStatus({}, {});
    expect(stdout()).toContain("No active Dosu knowledge ticket");
  });
});

describe("runHookEntrypoint", () => {
  it("dispatches valid stdin to the matching handler", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockResolvedValue({
      ticket_id: "kt",
      status: "pending",
      created_at: "x",
      expires_at: "y",
    });
    await runHookEntrypoint(
      "user-prompt-submit",
      JSON.stringify({ session_id: "s", prompt: "p" }),
      1,
    );
    expect(stdout()).toContain("UserPromptSubmit");
  });

  it("treats malformed stdin as empty and never throws", async () => {
    await expect(runHookEntrypoint("post-tool-use", "{not json")).resolves.toBeUndefined();
    expect(stdout()).toBe("");
  });

  it("swallows handler errors; stop still emits continue", async () => {
    vi.mocked(loadState).mockImplementation(() => {
      throw new Error("disk boom");
    });
    await runHookEntrypoint("post-tool-use", JSON.stringify({ session_id: "s" }));
    expect(stdout()).toBe("");
    await runHookEntrypoint("stop", JSON.stringify({ session_id: "s" }));
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });
});

describe("lifecycle commands", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dosu-hooks-cmd-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("install writes only the local settings file and uninstall reverses it", async () => {
    await runInstall("claude-code", { dir });
    expect(stdout()).toContain("Installed Dosu hooks");
    logSpy.mockClear();
    await runUninstall("claude-code", { dir });
    expect(stdout()).toContain("Removed Dosu hooks");
  });

  it("install --json emits a machine-readable step", async () => {
    await runInstall("claude-code", { dir, json: true });
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line.step).toBe("hooks-install");
    expect(line.events).toEqual(["UserPromptSubmit", "PostToolUse"]);
  });

  it("rejects an unsupported agent and a non-local scope", async () => {
    await runInstall("codex", {});
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    await runInstall("claude-code", { scope: "project" });
    expect(process.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalled();
  });

  it("uninstall rejects an unsupported agent", async () => {
    await runUninstall("codex", {});
    expect(process.exitCode).toBe(2);
  });

  it("doctor reports ok when fully configured and installed", async () => {
    await runInstall("claude-code", { dir });
    logSpy.mockClear();
    const checks = await collectDoctorChecks({ dir });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      config: "ok",
      hooks: "ok",
      auth: "ok",
      deployment: "ok",
      backend: "ok",
    });
  });

  it("doctor flags missing config / auth / deployment and exits non-zero", async () => {
    vi.mocked(loadConfig).mockReturnValue({ access_token: "", refresh_token: "", expires_at: 0 });
    const checks = await collectDoctorChecks({ dir });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      config: "fail", // not installed
      auth: "fail",
      deployment: "fail",
      backend: "warn", // skipped — unauthenticated
    });
    await runDoctor({ dir }); // exercise the printing path
    expect(process.exitCode).toBe(1);
  });

  it("doctor reports a backend failure when the API key is rejected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED });
    vi.mocked(Client).mockImplementationOnce(
      () => ({ validateAPIKey: vi.fn(async () => false) }) as unknown as Client,
    );
    await runInstall("claude-code", { dir });
    const checks = await collectDoctorChecks({ dir });
    expect(checks.find((c) => c.name === "backend")?.status).toBe("fail");
  });

  it("uninstall on a clean project reports nothing was installed", async () => {
    await runUninstall("claude-code", { dir });
    expect(stdout()).toContain("No Dosu hooks were installed");
  });

  it("uninstall --json emits a machine-readable step", async () => {
    await runInstall("claude-code", { dir });
    logSpy.mockClear();
    await runUninstall("claude-code", { dir, json: true });
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-uninstall", removed: true });
  });

  it("install surfaces a write failure on an unparseable settings file", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{ broken");
    await runInstall("claude-code", { dir });
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("doctor --json emits a line per check", async () => {
    await runInstall("claude-code", { dir });
    logSpy.mockClear();
    await runDoctor({ dir, json: true });
    const steps = logSpy.mock.calls.map((c) => JSON.parse(c[0]).step);
    expect(steps).toEqual(
      expect.arrayContaining(["doctor-config", "doctor-hooks", "doctor-backend"]),
    );
  });
});
