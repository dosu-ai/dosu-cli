import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkForSkillUpdates,
  fetchLatestSha,
  readSkillCache,
  refreshInstalledSha,
  writeSkillCache,
} from "./skill-update-check";

const CACHE_FILENAME = "skill-update-check.json";

describe("fetchLatestSha", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns latest sha from GitHub API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sha: "abc123" }),
      }),
    );
    const result = await fetchLatestSha();
    expect(result).toBe("abc123");
  });

  it("sends a User-Agent header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "abc123" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchLatestSha();
    const call = fetchMock.mock.calls[0];
    const opts = call[1] as { headers: Record<string, string> };
    expect(opts.headers["User-Agent"]).toMatch(/^dosu-cli\//);
  });

  it("returns null on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await fetchLatestSha();
    expect(result).toBeNull();
  });

  it("returns null when response has no sha field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ other: "value" }),
      }),
    );
    const result = await fetchLatestSha();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
    const result = await fetchLatestSha();
    expect(result).toBeNull();
  });
});

describe("readSkillCache / writeSkillCache", () => {
  let tempDir: string;
  let origXDG: string | undefined;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-cache-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    if (origXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = origXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when cache file does not exist", () => {
    expect(readSkillCache()).toBeNull();
  });

  it("round-trips a cache object", () => {
    writeSkillCache({ lastCheck: 1, latestSha: "abc", installedSha: "def" });
    expect(readSkillCache()).toEqual({ lastCheck: 1, latestSha: "abc", installedSha: "def" });
  });

  it("returns null when cache has wrong shape", () => {
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(join(tempDir, "dosu-cli", CACHE_FILENAME), JSON.stringify({ foo: "bar" }));
    expect(readSkillCache()).toBeNull();
  });

  it("returns null when cache file is corrupt JSON", () => {
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(join(tempDir, "dosu-cli", CACHE_FILENAME), "NOT JSON{{{");
    expect(readSkillCache()).toBeNull();
  });

  it("creates config directory when writing cache", () => {
    writeSkillCache({ lastCheck: 1, latestSha: "abc", installedSha: "def" });
    expect(readSkillCache()).not.toBeNull();
  });
});

describe("refreshInstalledSha", () => {
  let tempDir: string;
  let origXDG: string | undefined;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-refresh-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    if (origXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = origXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes cache with installedSha === latestSha on fetch success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sha: "newsha" }),
      }),
    );
    await refreshInstalledSha();
    const cache = readSkillCache();
    expect(cache).not.toBeNull();
    expect(cache?.latestSha).toBe("newsha");
    expect(cache?.installedSha).toBe("newsha");
  });

  it("does not overwrite cache on fetch failure", async () => {
    writeSkillCache({ lastCheck: 123, latestSha: "old", installedSha: "old" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await refreshInstalledSha();
    const cache = readSkillCache();
    expect(cache?.lastCheck).toBe(123);
    expect(cache?.latestSha).toBe("old");
    expect(cache?.installedSha).toBe("old");
  });
});

describe("checkForSkillUpdates", () => {
  let tempDir: string;
  let origXDG: string | undefined;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-update-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;

    // Stub fetch to prevent real network calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sha: "default-sha" }),
      }),
    );
  });

  afterEach(() => {
    if (origXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = origXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not print when no cache exists, but triggers a background fetch", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    checkForSkillUpdates();
    expect(spy).not.toHaveBeenCalled();

    // Background fetch should populate the cache
    const cachePath = join(tempDir, "dosu-cli", CACHE_FILENAME);
    await vi.waitFor(() => {
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.latestSha).toBe("default-sha");
      expect(updated.installedSha).toBe("");
    });
  });

  it("prints notice when cached latestSha differs from installedSha", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(
      join(tempDir, "dosu-cli", CACHE_FILENAME),
      JSON.stringify({ lastCheck: Date.now(), latestSha: "new", installedSha: "old" }),
    );

    checkForSkillUpdates();
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Dosu skill update available");
    expect(output).toContain("dosu skill update");
  });

  it("does not print when SHAs match", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(
      join(tempDir, "dosu-cli", CACHE_FILENAME),
      JSON.stringify({ lastCheck: Date.now(), latestSha: "same", installedSha: "same" }),
    );

    checkForSkillUpdates();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not fetch when cache is fresh", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(
      join(tempDir, "dosu-cli", CACHE_FILENAME),
      JSON.stringify({ lastCheck: Date.now(), latestSha: "a", installedSha: "a" }),
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForSkillUpdates();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fires background fetch when cache is stale and updates latestSha", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "fresh-sha" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    const cachePath = join(tempDir, "dosu-cli", CACHE_FILENAME);
    // Cache from 2 days ago
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastCheck: Date.now() - 2 * 24 * 60 * 60 * 1000,
        latestSha: "stale-sha",
        installedSha: "stale-sha",
      }),
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForSkillUpdates();

    await vi.waitFor(() => {
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.latestSha).toBe("fresh-sha");
      // installedSha preserved — user hasn't reinstalled
      expect(updated.installedSha).toBe("stale-sha");
    });
  });

  it("fetch failure retains stale cache latestSha but still bumps lastCheck", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    const cachePath = join(tempDir, "dosu-cli", CACHE_FILENAME);
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastCheck: twoDaysAgo,
        latestSha: "prev-sha",
        installedSha: "inst-sha",
      }),
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForSkillUpdates();

    await vi.waitFor(() => {
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.lastCheck).toBeGreaterThan(twoDaysAgo);
      // latestSha falls back to cached value when fetch returns null
      expect(updated.latestSha).toBe("prev-sha");
      expect(updated.installedSha).toBe("inst-sha");
    });
  });

  it("does not show notice when installedSha is empty (pre-existing install)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(
      join(tempDir, "dosu-cli", CACHE_FILENAME),
      JSON.stringify({ lastCheck: Date.now(), latestSha: "new-sha", installedSha: "" }),
    );

    checkForSkillUpdates();
    // Even though latestSha is non-empty and differs from "", no notice — user
    // pre-dates this feature and we don't know what they have installed.
    expect(spy).not.toHaveBeenCalled();
  });

  it("handles corrupt cache file gracefully", () => {
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(join(tempDir, "dosu-cli", CACHE_FILENAME), "NOT JSON{{{");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => checkForSkillUpdates()).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
