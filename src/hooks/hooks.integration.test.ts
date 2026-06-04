/**
 * Fake-API integration tests (plan §9.2).
 *
 * Exercises the REAL hook code path — real ticket-client, real authenticated
 * `Client`, real on-disk session state — against the contract-mirroring fake
 * server, reached exactly like production via `DOSU_BACKEND_URL_OVERRIDE`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), init: vi.fn() },
}));

import { runPostToolUse, runUserPromptSubmit } from "../commands/hooks";
import { type FakeTicketServer, startFakeTicketServer } from "./fake-server";
import { loadState } from "./state";

const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "DOSU_DEV",
  "DOSU_BACKEND_URL_OVERRIDE",
  "DOSU_HOOK_STATE_DIR",
  "DOSU_HOOK_CHECK_COOLDOWN_MS",
  "DOSU_HOOK_READY_DELAY_MS",
  "DOSU_HOOK_FAKE_STATUS",
] as const;

describe("hooks ⇄ fake ticket API (integration)", () => {
  let root: string;
  let server: FakeTicketServer;
  let saved: Record<string, string | undefined>;
  let logSpy: MockInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "dosu-hooks-int-"));
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

    process.env.XDG_CONFIG_HOME = join(root, "cfg");
    delete process.env.DOSU_DEV;
    process.env.DOSU_HOOK_STATE_DIR = join(root, "state");
    process.env.DOSU_HOOK_CHECK_COOLDOWN_MS = "0"; // disable throttle except where tested

    const cfgDir = join(root, "cfg", "dosu-cli");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        deployment_id: "dep-int",
        deployment_name: "Integration",
        api_key: "key-int",
      }),
    );

    server = await startFakeTicketServer();
    process.env.DOSU_BACKEND_URL_OVERRIDE = server.url;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await server.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("create → pending → ready delivers exactly once, then stays silent", async () => {
    process.env.DOSU_HOOK_READY_DELAY_MS = "100000"; // not ready by elapsed time
    await runUserPromptSubmit(
      { session_id: "s1", prompt: "investigate", cwd: "/x/myrepo" },
      Date.now(),
    );
    expect(server.counts.create).toBe(1);
    expect(loadState("s1")?.status).toBe("pending");

    await runPostToolUse({ session_id: "s1" });
    expect(loadState("s1")?.status).toBe("pending"); // still pending, no delivery

    process.env.DOSU_HOOK_FAKE_STATUS = "ready"; // retrieval finished
    logSpy.mockClear();
    await runPostToolUse({ session_id: "s1" });
    expect(loadState("s1")?.status).toBe("delivered");
    const printed = JSON.parse(logSpy.mock.calls[0][0]);
    expect(printed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(printed.hookSpecificOutput.additionalContext).toContain("Fake knowledge context");

    logSpy.mockClear();
    await runPostToolUse({ session_id: "s1" }); // already delivered
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it("a failed ticket injects nothing and exits cleanly", async () => {
    await runUserPromptSubmit({ session_id: "s2", prompt: "x" }, Date.now());
    process.env.DOSU_HOOK_FAKE_STATUS = "failed";
    logSpy.mockClear();
    await runPostToolUse({ session_id: "s2" });
    expect(loadState("s2")?.status).toBe("failed");
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it("an expired ticket is treated as terminal with no injection", async () => {
    await runUserPromptSubmit({ session_id: "s3", prompt: "x" }, Date.now());
    process.env.DOSU_HOOK_FAKE_STATUS = "expired";
    logSpy.mockClear();
    await runPostToolUse({ session_id: "s3" });
    expect(loadState("s3")?.status).toBe("expired");
    expect(logSpy.mock.calls).toHaveLength(0);
  });

  it("a small ready delay delivers well before the client TTL expires", async () => {
    process.env.DOSU_HOOK_READY_DELAY_MS = "0"; // ready immediately, ≪ 10-min client TTL
    await runUserPromptSubmit({ session_id: "s5", prompt: "x" }, Date.now());
    logSpy.mockClear();
    await runPostToolUse({ session_id: "s5" });
    expect(loadState("s5")?.status).toBe("delivered");
  });

  it("the PostToolUse cooldown bounds a 20-call burst to a single backend poll", async () => {
    process.env.DOSU_HOOK_CHECK_COOLDOWN_MS = "3000";
    process.env.DOSU_HOOK_READY_DELAY_MS = "100000";
    await runUserPromptSubmit({ session_id: "s4", prompt: "x" }, Date.now());
    const before = server.counts.poll;
    const fixedNow = Date.now();
    for (let i = 0; i < 20; i++) {
      await runPostToolUse({ session_id: "s4" }, fixedNow);
    }
    expect(server.counts.poll - before).toBe(1);
  });
});
