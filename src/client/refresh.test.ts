/**
 * Refresh self-healing tests.
 *
 * GoTrue rotates refresh tokens on every use, and replaying a stale token
 * outside the ~10s reuse interval can revoke the ENTIRE session (reuse
 * detection) — killing every client that shares it. Multiple CLI processes
 * (TUI and parallel commands) share one config file, so a
 * process holding a stale in-memory token can kill the session for all of
 * them. These tests pin the client's lock-based defenses:
 *
 * 1. acquire a config-directory lock before contacting GoTrue;
 * 2. adopt a valid session persisted by the lock holder instead of rotating
 *    again; and
 * 3. persist a candidate session before updating the caller's in-memory copy.
 *
 * The fake GoTrue mirrors hosted behavior outside the reuse interval: only
 * the CURRENT refresh token succeeds; anything else gets a 400
 * (refresh_token_already_used).
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Config,
  emptyConfig,
  getConfigDir,
  getConfigPath,
  loadConfig,
  saveConfig,
} from "../config/config";
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

function oauthAccessToken(clientID: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: "oauth-user", client_id: clientID })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
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

  it("adopts a newer valid on-disk session without another remote refresh", async () => {
    // A sibling process already rotated the token and saved it.
    saveConfig(makeConfig({ access_token: "at-disk", refresh_token: "rt-disk" }));
    const gotrue = new FakeGoTrue("rt-disk");
    mockFetch.mockImplementation(gotrue.handle);

    // This process still holds the pre-rotation tokens in memory (e.g. a
    // TUI that has been open for a while).
    const cfg = makeConfig({ refresh_token: "rt-stale" });
    await new Client(cfg).refreshToken();

    expect(gotrue.presented).toEqual([]);
    expect(gotrue.rejections).toBe(0);
    expect(cfg.active_account?.session.refresh_token).toBe("rt-disk");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-disk");
  });

  it("refreshes OAuth 2.1 sessions through the OAuth token endpoint", async () => {
    const accessToken = oauthAccessToken("cli-client-id");
    saveConfig(makeConfig({ access_token: accessToken, refresh_token: "oauth-refresh" }));
    const cfg = loadConfig();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: oauthAccessToken("cli-client-id"),
          refresh_token: "oauth-refresh-2",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    await new Client(cfg).refreshToken();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test.supabase.co/auth/v1/oauth/token");
    expect(init.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(new URLSearchParams(init.body as string).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(init.body as string).get("refresh_token")).toBe("oauth-refresh");
    expect(new URLSearchParams(init.body as string).get("client_id")).toBe("cli-client-id");
  });

  it("serializes two concurrent clients so only one rotates and both adopt it", async () => {
    saveConfig(makeConfig({ refresh_token: "rt-0", expires_at: 1 }));
    const gotrue = new FakeGoTrue("rt-0");
    mockFetch.mockImplementation(gotrue.handle);

    // Both processes load the same config...
    const a = loadConfig();
    const b = loadConfig();

    await Promise.all([new Client(a).refreshToken(), new Client(b).refreshToken()]);

    expect(gotrue.presented).toEqual(["rt-0"]);
    expect(gotrue.rejections).toBe(0);
    expect(a.active_account?.session.refresh_token).toBe("rt-1");
    expect(b.active_account?.session.refresh_token).toBe("rt-1");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-1");

    // The config dir contains exactly the config file — no stale lock or temp files.
    expect(readdirSync(join(tempDir, "dosu-cli"))).toEqual(["config.json"]);
  });

  it("coalesces concurrent refresh calls that share one in-memory config", async () => {
    saveConfig(makeConfig({ refresh_token: "rt-0", expires_at: 1 }));
    const gotrue = new FakeGoTrue("rt-0");
    mockFetch.mockImplementation(gotrue.handle);
    const cfg = loadConfig();
    const client = new Client(cfg);

    await Promise.all([client.refreshToken(), client.refreshToken()]);

    expect(gotrue.presented).toEqual(["rt-0"]);
    expect(cfg.active_account?.session.refresh_token).toBe("rt-1");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-1");
  });

  it("returns SessionExpiredError when the auth server rejects the refresh", async () => {
    saveConfig(makeConfig({ refresh_token: "rt-dead" }));
    const cfg = loadConfig();
    const gotrue = new FakeGoTrue("rt-elsewhere"); // nothing we hold will work
    mockFetch.mockImplementation(gotrue.handle);

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionExpiredError",
      code: "SESSION_EXPIRED",
      message: expect.stringContaining("dosu login"),
    });
    expect(gotrue.presented).toEqual(["rt-dead"]);
    expect(readdirSync(getConfigDir())).toEqual(["config.json"]);
  });

  it("keeps unexpected auth server failures observable and does not mutate credentials", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error_code: "unexpected_failure" }), { status: 503 }),
    );

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionRefreshError",
      code: "SESSION_REFRESH_ERROR",
      status: 503,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-old");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-old");
    expect(readdirSync(getConfigDir())).toEqual(["config.json"]);
  });

  it("does not classify an unknown auth-server 401 as an expired session", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error_code: "invalid_api_key" }), { status: 401 }),
    );

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionRefreshError",
      code: "SESSION_REFRESH_ERROR",
      status: 401,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-old");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-old");
  });

  it("keeps network refresh failures observable with their cause", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    const cause = Object.assign(new Error("private network detail"), { code: "ECONNRESET" });
    mockFetch.mockRejectedValue(cause);

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionRefreshError",
      code: "SESSION_REFRESH_ERROR",
      cause,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-old");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-old");
  });

  it("aborts a hung refresh request and releases the config lock", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        async (_url: unknown, options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = options?.signal;
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );

      const refresh = new Client(cfg).refreshToken();
      const rejection = expect(refresh).rejects.toMatchObject({
        name: "SessionRefreshError",
        code: "SESSION_REFRESH_ERROR",
        cause: { name: "AbortError" },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      expect(cfg.active_account?.session.refresh_token).toBe("rt-old");
      expect(loadConfig().active_account?.session.refresh_token).toBe("rt-old");
      expect(readdirSync(getConfigDir())).toEqual(["config.json"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry or mutate memory when refreshed credentials cannot be persisted", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    mkdirSync(`${getConfigPath()}.${process.pid}.tmp`);
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const failure = await new Client(cfg).refreshToken().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "SessionPersistenceError",
      code: "SESSION_PERSISTENCE_ERROR",
      message: expect.stringContaining("writable"),
      cause: { code: "EISDIR" },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(cfg.active_account?.session).toMatchObject({
      access_token: "at-old",
      refresh_token: "rt-old",
      expires_at: 1,
    });
    expect(loadConfig().active_account?.session).toMatchObject({
      access_token: "at-old",
      refresh_token: "rt-old",
      expires_at: 1,
    });
    expect(readdirSync(getConfigDir())).not.toContain("session-refresh.lock");
  });

  it("fails before contacting Supabase when the config directory is unwritable", async () => {
    saveConfig(makeConfig({ access_token: "at-old", refresh_token: "rt-old", expires_at: 1 }));
    const cfg = loadConfig();
    chmodSync(getConfigDir(), 0o500);

    try {
      const failure = await new Client(cfg).refreshToken().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "SessionPersistenceError",
        code: "SESSION_PERSISTENCE_ERROR",
        message: expect.stringContaining("writable"),
        cause: { code: expect.stringMatching(/^(?:EACCES|EPERM)$/) },
      });
    } finally {
      chmodSync(getConfigDir(), 0o700);
    }

    expect(mockFetch).not.toHaveBeenCalled();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-old");
    expect(loadConfig().active_account?.session.refresh_token).toBe("rt-old");
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

  it("does not resurrect a session removed before refresh acquires the lock", async () => {
    saveConfig(makeAccountConfig("account-a", { refresh_token: "rt-a" }));
    const cfg = loadConfig();
    saveConfig(emptyConfig());
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-resurrected",
          refresh_token: "rt-resurrected",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionExpiredError",
      code: "SESSION_EXPIRED",
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-a");
    expect(loadConfig().active_account).toBeUndefined();
  });

  it("does not restore a session removed while the refresh request is in flight", async () => {
    saveConfig(makeAccountConfig("account-a", { refresh_token: "rt-a" }));
    const cfg = loadConfig();
    mockFetch.mockImplementation(async () => {
      saveConfig(emptyConfig());
      return new Response(
        JSON.stringify({
          access_token: "at-resurrected",
          refresh_token: "rt-resurrected",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });

    await expect(new Client(cfg).refreshToken()).rejects.toMatchObject({
      name: "SessionExpiredError",
      code: "SESSION_EXPIRED",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(cfg.active_account?.session.refresh_token).toBe("rt-a");
    expect(loadConfig().active_account).toBeUndefined();
    expect(readdirSync(getConfigDir())).toEqual(["config.json"]);
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
