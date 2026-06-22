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
  Client: vi.fn(function () {
    return { validateAPIKey: vi.fn(async () => true) };
  }),
}));

import { Client } from "../client/client";
import { loadConfig, MODE_OSS } from "../config/config";
import { loadState, saveState, type TicketState } from "../hooks/state";
import { requestCreateTicket, requestGetTicket, TicketHttpError } from "../hooks/ticket-client";
import {
  collectDoctorChecks,
  hooksCommand,
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

  it("no-ops without a session id, an empty prompt, or when missing api key / deployment", async () => {
    await runUserPromptSubmit({ prompt: "x" });
    await runUserPromptSubmit({ session_id: "s", prompt: "   " });
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, deployment_id: undefined });
    await runUserPromptSubmit({ session_id: "s", prompt: "real" });
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, api_key: undefined });
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

  it("no-ops when the prompt field is absent entirely", async () => {
    await runUserPromptSubmit({ session_id: "sess" });
    expect(requestCreateTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("is silent when create rejects with a non-Error value", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockRejectedValue("boom-string");
    await runUserPromptSubmit({ session_id: "sess", prompt: "x" });
    expect(saveState).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("honors a valid DOSU_HOOK_TTL_MS override when setting expiresAt", async () => {
    process.env.DOSU_HOOK_TTL_MS = "5000";
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockResolvedValue({
      ticket_id: "kt_ttl",
      status: "pending",
      created_at: "x",
      expires_at: "y",
    });
    await runUserPromptSubmit({ session_id: "sess", prompt: "p" }, 10_000);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: 15_000 }), // 10_000 + 5000 override
    );
    delete process.env.DOSU_HOOK_TTL_MS;
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

  it("latches the server status (failed/expired) without injecting context", async () => {
    for (const status of ["failed", "expired"] as const) {
      vi.clearAllMocks();
      vi.mocked(loadConfig).mockReturnValue({ ...AUTHED });
      vi.mocked(loadState).mockReturnValue(pending());
      vi.mocked(requestGetTicket).mockResolvedValue({
        ticket_id: "kt_1",
        status,
        created_at: "x",
        expires_at: "y",
        result: null,
        error: null,
      });
      await runPostToolUse({ session_id: "sess" }, 50_000);
      expect(saveState).toHaveBeenCalledWith(
        expect.objectContaining({ status, lastCheckedAt: 50_000 }),
      );
      expect(stdout()).toBe("");
    }
  });

  it("honors a valid DOSU_HOOK_CHECK_COOLDOWN_MS override on the cooldown gate", async () => {
    process.env.DOSU_HOOK_CHECK_COOLDOWN_MS = "10000";
    vi.mocked(loadState).mockReturnValue(pending({ lastCheckedAt: 1000 }));
    await runPostToolUse({ session_id: "sess" }, 5000); // 4000ms < 10000ms override
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
    delete process.env.DOSU_HOOK_CHECK_COOLDOWN_MS;
  });
});

describe("runStop", () => {
  // Default the Stop wait to 0 so the pending-path tests poll once and never sleep.
  beforeEach(() => {
    process.env.DOSU_HOOK_STOP_WAIT_MS = "0";
  });
  afterEach(() => {
    delete process.env.DOSU_HOOK_STOP_WAIT_MS;
    delete process.env.DOSU_HOOK_STOP_POLL_MS;
  });

  it("continues without a session or without a pending ticket", async () => {
    await runStop({});
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

  it("consumes but does NOT block on a ready gap ticket (empty context)", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockResolvedValue({
      ticket_id: "kt_1",
      status: "ready",
      created_at: "x",
      expires_at: "y",
      result: { context: "", sources: [], attribution: "attr", save_recommended: true },
      error: null,
    });
    await runStop({ session_id: "sess" }, 70_000);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
    expect(saveState).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered" }));
  });

  it("continues (no block) when the ticket is still in flight after the wait", async () => {
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
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", lastCheckedAt: 70_000 }),
    );
  });

  it("waits, re-polls, and delivers when the ticket flips ready mid-wait", async () => {
    process.env.DOSU_HOOK_STOP_WAIT_MS = "50";
    process.env.DOSU_HOOK_STOP_POLL_MS = "1";
    vi.mocked(loadState).mockReturnValue(pending());
    const pendingResp = {
      ticket_id: "kt_1",
      status: "pending" as const,
      created_at: "x",
      expires_at: "y",
      result: null,
      error: null,
    };
    vi.mocked(requestGetTicket)
      .mockResolvedValueOnce(pendingResp)
      .mockResolvedValueOnce(pendingResp)
      .mockResolvedValue(readyResp("READY MID-WAIT"));
    await runStop({ session_id: "sess" }, 70_000);
    expect(requestGetTicket).toHaveBeenCalledTimes(3);
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.decision).toBe("block");
    expect(printed.reason).toContain("READY MID-WAIT");
  });

  it("continues on a poll error (never holds the agent open)", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(requestGetTicket).mockRejectedValue(new TicketHttpError(500));
    await runStop({ session_id: "sess" }, 70_000);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("continues without polling when the ticket is in a terminal (non-pending) state", async () => {
    vi.mocked(loadState).mockReturnValue(pending({ status: "delivered" }));
    await runStop({ session_id: "sess" }, 70_000);
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("continues without polling when the pending ticket has expired", async () => {
    vi.mocked(loadState).mockReturnValue(pending({ expiresAt: 100 }));
    await runStop({ session_id: "sess" }, 70_000);
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("continues without polling when auth/deployment is missing", async () => {
    vi.mocked(loadState).mockReturnValue(pending());
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, api_key: undefined });
    await runStop({ session_id: "sess" }, 70_000);
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("clamps a non-positive poll override back to the default interval", async () => {
    // DOSU_HOOK_STOP_POLL_MS="0" is invalid (must be > 0), so stopPollMs() returns
    // the 1000ms default; with wait=0 (beforeEach) maxWaits = floor(0/1000) = 0,
    // so the loop polls once and never sleeps.
    process.env.DOSU_HOOK_STOP_POLL_MS = "0";
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
    expect(requestGetTicket).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ continue: true });
  });

  it("falls back to the default stop-wait budget when the env override is unset", async () => {
    // No DOSU_HOOK_STOP_WAIT_MS → default 8000ms; a huge poll interval keeps
    // maxWaits at 0 so the loop polls once and never sleeps.
    delete process.env.DOSU_HOOK_STOP_WAIT_MS;
    process.env.DOSU_HOOK_STOP_POLL_MS = "999999"; // floor(8000/999999) = 0
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
    expect(requestGetTicket).toHaveBeenCalledTimes(1);
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

  it("prints Delivered: no for an undelivered ticket", () => {
    vi.mocked(loadState).mockReturnValue(pending());
    runStatus({ session_id: "sess" }, {}, 10);
    expect(stdout()).toContain("Status: pending");
    expect(stdout()).toContain("Delivered: no");
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

  it("treats blank stdin as an empty input object", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    await expect(runHookEntrypoint("post-tool-use", "   ")).resolves.toBeUndefined();
    expect(requestGetTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe("");
  });

  it("threads --agent through to ticket attribution", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    vi.mocked(requestCreateTicket).mockResolvedValue({
      ticket_id: "kt_codex",
      status: "pending",
      created_at: "x",
      expires_at: "y",
    });
    await runHookEntrypoint(
      "user-prompt-submit",
      JSON.stringify({ session_id: "s", prompt: "p" }),
      1,
      "codex",
    );
    expect(vi.mocked(requestCreateTicket).mock.calls[0][1]).toMatchObject({ agent: "codex" });
  });

  it("never mints a lookup for its own Stop-delivered envelope (Codex continuation prompt)", async () => {
    vi.mocked(loadState).mockReturnValue(null);
    const { STOP_PREFIX } = await import("../hooks/prompts");

    // Codex turns a Stop hook's block reason into a NEW user prompt, which
    // re-fires UserPromptSubmit with our own envelope as the prompt text.
    await runHookEntrypoint(
      "user-prompt-submit",
      JSON.stringify({ session_id: "s", prompt: `${STOP_PREFIX}\n\nDosu knowledge context…` }),
      1,
      "codex",
    );

    expect(requestCreateTicket).not.toHaveBeenCalled();
    expect(stdout()).toBe(""); // no injection either
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
    expect(line.events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
  });

  it("rejects an unsupported agent and a non-local scope", async () => {
    await runInstall("cursor", {});
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    await runInstall("claude-code", { scope: "project" });
    expect(process.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalled();
  });

  it("uninstall rejects an unsupported agent", async () => {
    await runUninstall("cursor", {});
    expect(process.exitCode).toBe(2);
  });

  it("install codex writes .codex/hooks.json and surfaces the one-time trust step", async () => {
    await runInstall("codex", { dir });
    expect(process.exitCode ?? 0).toBe(0);

    const { codexHooksPath, inspectCodexHooks } = await import("../hooks/codex");
    const inspection = inspectCodexHooks(codexHooksPath(dir));
    expect(inspection.fileExists).toBe(true);
    expect(inspection.events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);

    expect(stdout()).toContain("Codex");
    expect(stdout()).toContain("/hooks"); // Codex skips untrusted hooks — UX must say so
  });

  it("uninstall codex removes only the Dosu groups", async () => {
    await runInstall("codex", { dir });
    logSpy.mockClear();
    await runUninstall("codex", { dir });

    const { codexHooksPath, inspectCodexHooks } = await import("../hooks/codex");
    expect(inspectCodexHooks(codexHooksPath(dir)).events).toEqual([]);
    expect(stdout()).toContain("Removed");
  });

  it("doctor reports the codex section and softens claude checks when codex carries the chain", async () => {
    await runInstall("codex", { dir });
    logSpy.mockClear();
    const checks = await collectDoctorChecks({ dir });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      config: "warn", // claude config missing, but codex hooks are active
      hooks: "warn",
      "codex-config": "ok",
      "codex-trust": "warn", // trust lives inside Codex; always remind
    });
  });

  it("install factory writes .factory/hooks.json", async () => {
    await runInstall("factory", { dir });
    expect(process.exitCode ?? 0).toBe(0);

    const { factoryHooksPath, inspectFactoryHooks } = await import("../hooks/factory");
    const inspection = inspectFactoryHooks(factoryHooksPath(dir));
    expect(inspection.fileExists).toBe(true);
    expect(inspection.events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);

    expect(stdout()).toContain("Factory");
  });

  it("uninstall factory removes only the Dosu groups", async () => {
    await runInstall("factory", { dir });
    logSpy.mockClear();
    await runUninstall("factory", { dir });

    const { factoryHooksPath, inspectFactoryHooks } = await import("../hooks/factory");
    expect(inspectFactoryHooks(factoryHooksPath(dir)).events).toEqual([]);
    expect(stdout()).toContain("Removed");
  });

  it("doctor reports the factory section and softens claude checks when factory carries the chain", async () => {
    await runInstall("factory", { dir });
    logSpy.mockClear();
    const checks = await collectDoctorChecks({ dir });
    const byName = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    expect(byName).toMatchObject({
      config: "warn", // claude config missing, but factory hooks are active
      hooks: "warn",
      "factory-config": "ok",
    });
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
    vi.mocked(Client).mockImplementationOnce(function () {
      return { validateAPIKey: vi.fn(async () => false) } as unknown as Client;
    });
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

  it("install --json emits a machine-readable error for an unsupported agent", async () => {
    await runInstall("cursor", { dir, json: true });
    expect(process.exitCode).toBe(2);
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-install", reason: "unsupported_agent" });
  });

  it("install --json emits a machine-readable error for an unsupported scope", async () => {
    await runInstall("claude-code", { dir, scope: "project", json: true });
    expect(process.exitCode).toBe(2);
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-install", reason: "unsupported_scope" });
  });

  it("uninstall --json emits a machine-readable error for an unsupported agent", async () => {
    await runUninstall("cursor", { dir, json: true });
    expect(process.exitCode).toBe(2);
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-uninstall", reason: "unsupported_agent" });
  });

  it("install codex --json emits a machine-readable step", async () => {
    await runInstall("codex", { dir, json: true });
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-install", agent: "codex" });
    expect(line.events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
  });

  it("install factory --json emits a machine-readable step", async () => {
    await runInstall("factory", { dir, json: true });
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-install", agent: "factory" });
    expect(line.events).toEqual(["UserPromptSubmit", "PostToolUse", "Stop"]);
  });

  it("install --json surfaces a write failure as a machine-readable error", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{ broken");
    await runInstall("claude-code", { dir, json: true });
    expect(process.exitCode).toBe(1);
    const line = JSON.parse(logSpy.mock.calls[0][0]);
    expect(line).toMatchObject({ step: "hooks-install", reason: "write_failed" });
  });

  it("doctor flags an unparseable claude config as a failure", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{ broken");
    const checks = await collectDoctorChecks({ dir });
    expect(checks.find((c) => c.name === "config")?.status).toBe("fail");
    expect(checks.find((c) => c.name === "config")?.detail).toContain("invalid JSON");
  });

  it("doctor flags an unparseable codex config and an installed-but-incomplete one", async () => {
    // Unparseable codex hooks file.
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "hooks.json"), "{ broken");
    let checks = await collectDoctorChecks({ dir });
    expect(checks.find((c) => c.name === "codex-config")?.status).toBe("fail");

    // Valid JSON, but Dosu hooks not installed.
    writeFileSync(join(dir, ".codex", "hooks.json"), "{}");
    checks = await collectDoctorChecks({ dir });
    const codex = checks.find((c) => c.name === "codex-config");
    expect(codex?.status).toBe("fail");
    expect(codex?.detail).toContain("not both installed");
  });

  it("doctor flags an unparseable factory config and an installed-but-incomplete one", async () => {
    mkdirSync(join(dir, ".factory"), { recursive: true });
    writeFileSync(join(dir, ".factory", "hooks.json"), "{ broken");
    let checks = await collectDoctorChecks({ dir });
    expect(checks.find((c) => c.name === "factory-config")?.status).toBe("fail");

    writeFileSync(join(dir, ".factory", "hooks.json"), "{}");
    checks = await collectDoctorChecks({ dir });
    const factory = checks.find((c) => c.name === "factory-config");
    expect(factory?.status).toBe("fail");
    expect(factory?.detail).toContain("not both installed");
  });
});

describe("hooksCommand wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dosu-hooks-wire-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches the install action through Commander", async () => {
    await hooksCommand().parseAsync(["install", "claude-code", "--dir", dir], { from: "user" });
    expect(stdout()).toContain("Installed Dosu hooks");
  });

  it("dispatches the uninstall action through Commander", async () => {
    await hooksCommand().parseAsync(["install", "claude-code", "--dir", dir], { from: "user" });
    logSpy.mockClear();
    await hooksCommand().parseAsync(["uninstall", "claude-code", "--dir", dir], { from: "user" });
    expect(stdout()).toContain("Removed Dosu hooks");
  });

  it("dispatches the doctor action through Commander", async () => {
    await hooksCommand().parseAsync(["install", "claude-code", "--dir", dir], { from: "user" });
    logSpy.mockClear();
    await hooksCommand().parseAsync(["doctor", "--dir", dir, "--json"], { from: "user" });
    const steps = logSpy.mock.calls.map((c) => JSON.parse(c[0]).step);
    expect(steps).toEqual(expect.arrayContaining(["doctor-config"]));
  });
});

describe("collectDoctorChecks deployment detail", () => {
  it("defaults the project dir to cwd when none is passed (read-only inspection)", async () => {
    // No `dir` → resolveDir falls back to process.cwd(); the repo cwd has no
    // agent hook files, so this just inspects and reports without writing.
    const checks = await collectDoctorChecks({});
    expect(checks.some((c) => c.name === "config")).toBe(true);
  });

  it("falls back to deployment_id when no deployment_name is set", async () => {
    vi.mocked(loadConfig).mockReturnValue({ ...AUTHED, deployment_name: undefined });
    const checks = await collectDoctorChecks({});
    const deployment = checks.find((c) => c.name === "deployment");
    expect(deployment?.status).toBe("ok");
    expect(deployment?.detail).toBe("dep-1"); // deployment_id fallback
  });

  it("reports 'oss' for an OSS-mode config with no deployment id or name", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3_600_000,
      mode: MODE_OSS,
    });
    const checks = await collectDoctorChecks({});
    const deployment = checks.find((c) => c.name === "deployment");
    expect(deployment?.status).toBe("ok");
    expect(deployment?.detail).toBe("oss"); // final fallback
  });
});
