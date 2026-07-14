/**
 * Refresh self-healing tests.
 *
 * GoTrue rotates refresh tokens on every use, and replaying a stale token
 * outside the ~10s reuse interval can revoke the ENTIRE session (reuse
 * detection) — killing every client that shares it. Multiple CLI processes
 * (TUI, parallel commands, hooks-era installs) share one config file, so a
 * process holding a stale in-memory token can kill the session for all of
 * them. These tests pin the client's defenses:
 *
 * 1. adopt-before-refresh — refresh with the newest on-disk token, never a
 *    stale in-memory copy (long-lived TUI scenario).
 * 2. retry-after-rotation — when a refresh fails because a sibling rotated
 *    the token mid-flight, re-read the config and retry once with the newer
 *    token before declaring the session dead.
 * 3. two-client relay — a stale client adopts its sibling's rotation instead
 *    of replaying the dead token (which, against real GoTrue, would revoke
 *    the session for BOTH).
 *
 * The fake GoTrue mirrors hosted behavior outside the reuse interval: only
 * the CURRENT refresh token succeeds; anything else gets a 400
 * (refresh_token_already_used).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, loadConfig, saveConfig } from "../config/config";
import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { Client } from "./client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Stateful fake GoTrue: strict rotation with reuse detection. */
class FakeGoTrue {
  current: string;
  /** Every refresh_token value presented to the endpoint, in order. */
  presented: string[] = [];
  /** Number of rejected (stale-token) refresh attempts. */
  rejections = 0;
  private rotations = 0;

  constructor(initial: string) {
    this.current = initial;
  }

  handle = async (_url: unknown, options?: { body?: string }): Promise<Response> => {
    const body = JSON.parse(options?.body ?? "{}") as { refresh_token?: string };
    const presented = body.refresh_token ?? "";
    this.presented.push(presented);
    if (presented !== this.current) {
      this.rejections += 1;
      return new Response(JSON.stringify({ error_code: "refresh_token_already_used" }), {
        status: 400,
      });
    }
    this.rotations += 1;
    this.current = `rt-${this.rotations}`;
    return new Response(
      JSON.stringify({
        access_token: `at-${this.rotations}`,
        refresh_token: this.current,
        expires_in: 3600,
      }),
      { status: 200 },
    );
  };
}

function makeConfig(overrides: Partial<FlatTestConfig> = {}): Config {
  return makeTestConfig({
    access_token: "at-stale",
    refresh_token: "rt-stale",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

function makeAccountConfig(userID: string, overrides: Partial<FlatTestConfig> = {}): Config {
  return makeConfig({ ...overrides, user_id: userID });
}

describe("refresh self-healing", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tempDir: string;

  beforeAll(() => {
    for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
  });

  afterAll(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  beforeEach(() => {
    mockFetch.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "dosu-refresh-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refreshes with the newest on-disk token, not a stale in-memory copy", async () => {
    // A sibling process already rotated the token and saved it.
    saveConfig(makeConfig({ access_token: "at-disk", refresh_token: "rt-disk" }));
    const gotrue = new FakeGoTrue("rt-disk");
    mockFetch.mockImplementation(gotrue.handle);

    // This process still holds the pre-rotation tokens in memory (e.g. a
    // TUI that has been open for a while).
    const cfg = makeConfig({ refresh_token: "rt-stale" });
    await new Client(cfg).refreshToken();

    expect(gotrue.presented).toEqual(["rt-disk"]); // never "rt-stale"
    expect(gotrue.rejections).toBe(0);
    expect(cfg.active_account?.session.refresh_token).toBe("rt-1");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-1"); // rotation persisted
  });

  it("retries once with the on-disk token when a sibling rotates mid-flight", async () => {
    // Memory and disk agree when the refresh starts...
    saveConfig(makeConfig({ refresh_token: "rt-a" }));
    const cfg = loadConfig();

    // ...but a sibling has ALREADY rotated rt-a -> rt-b server-side; its
    // save lands while our (stale) request is in flight.
    const gotrue = new FakeGoTrue("rt-b");
    let siblingSaved = false;
    mockFetch.mockImplementation(async (url: unknown, options?: { body?: string }) => {
      const resp = await gotrue.handle(url, options);
      if (!siblingSaved) {
        siblingSaved = true;
        saveConfig(makeConfig({ access_token: "at-b", refresh_token: "rt-b" }));
      }
      return resp;
    });

    await new Client(cfg).refreshToken();

    expect(gotrue.presented).toEqual(["rt-a", "rt-b"]); // failed once, healed
    expect(cfg.active_account?.session.refresh_token).toBe("rt-1");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-1");
  });

  it("two clients sharing one config file relay the rotation instead of killing it", async () => {
    saveConfig(makeConfig({ refresh_token: "rt-0" }));
    const gotrue = new FakeGoTrue("rt-0");
    mockFetch.mockImplementation(gotrue.handle);

    // Both processes load the same config...
    const a = loadConfig();
    const b = loadConfig();

    // ...A refreshes first (rt-0 -> rt-1), then B — whose in-memory token is
    // now stale — must adopt A's rotation (rt-1 -> rt-2), not replay rt-0.
    await new Client(a).refreshToken();
    await new Client(b).refreshToken();

    expect(gotrue.presented).toEqual(["rt-0", "rt-1"]);
    expect(gotrue.rejections).toBe(0); // a replayed token would kill the session
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-2");

    // The config dir contains exactly the config file — no stray tmp files.
    expect(readdirSync(join(tempDir, "dosu-cli"))).toEqual(["config.json"]);
  });

  it("still fails cleanly when the session is truly dead (no newer token on disk)", async () => {
    saveConfig(makeConfig({ refresh_token: "rt-dead" }));
    const cfg = loadConfig();
    const gotrue = new FakeGoTrue("rt-elsewhere"); // nothing we hold will work
    mockFetch.mockImplementation(gotrue.handle);

    await expect(new Client(cfg).refreshToken()).rejects.toThrow("refresh failed with status 400");
    // One attempt only — disk has nothing newer to retry with.
    expect(gotrue.presented).toEqual(["rt-dead"]);
  });

  it("does not adopt tokens from a different account on disk", async () => {
    saveConfig(makeAccountConfig("account-b", { refresh_token: "rt-b" }));
    const cfg = makeAccountConfig("account-a", { refresh_token: "rt-a" });

    await expect(new Client(cfg).refreshToken()).rejects.toThrow(
      "authenticated account changed while this command was running",
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(loadConfig().active_account?.user_id).toBe("account-b");
  });

  it("does not overwrite a different account that logs in during refresh", async () => {
    saveConfig(makeAccountConfig("account-a", { refresh_token: "rt-a" }));
    const cfg = loadConfig();
    mockFetch.mockImplementation(async () => {
      saveConfig(makeAccountConfig("account-b", { refresh_token: "rt-b" }));
      return new Response(
        JSON.stringify({
          access_token: "at-a-refreshed",
          refresh_token: "rt-a-refreshed",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    await expect(new Client(cfg).refreshToken()).rejects.toThrow(
      "authenticated account changed while this command was running",
    );

    expect(loadConfig().active_account?.user_id).toBe("account-b");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-b");
  });
});
