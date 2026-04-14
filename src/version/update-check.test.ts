import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdates, fetchLatestVersion, isNewerVersion } from "./update-check";

describe("isNewerVersion", () => {
  it("returns true when latest is a higher major", () => {
    expect(isNewerVersion("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns true when latest is a higher minor", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
  });

  it("returns true when latest is a higher patch", () => {
    expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when current is newer", () => {
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(false);
  });

  it("handles different segment counts", () => {
    expect(isNewerVersion("1.0.0.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0.1")).toBe(false);
  });

  it("strips pre-release and build metadata before comparing", () => {
    expect(isNewerVersion("2.0.0-beta.1", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.1-rc.1+build.123", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0+build.456", "1.0.0")).toBe(false);
  });
});

describe("fetchLatestVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns latest version from registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ latest: "9.9.9" }),
      }),
    );
    const result = await fetchLatestVersion();
    expect(result).toBe("9.9.9");
  });

  it("returns null on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await fetchLatestVersion();
    expect(result).toBeNull();
  });

  it("returns null when response has no latest field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ next: "1.0.0" }),
      }),
    );
    const result = await fetchLatestVersion();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network failure")));
    const result = await fetchLatestVersion();
    expect(result).toBeNull();
  });
});

describe("checkForUpdates", () => {
  let tempDir: string;
  let origXDG: string | undefined;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-update-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;

    // Stub fetch to prevent real network calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ latest: "0.0.1" }),
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

  it("does not print when no cache exists", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    checkForUpdates();
    expect(spy).not.toHaveBeenCalled();
  });

  it("prints notice when cached version is newer", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cachePath = join(tempDir, "dosu-cli", "update-check.json");
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion: "99.0.0" }));

    checkForUpdates();
    expect(spy).toHaveBeenCalled();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("Update available");
    expect(output).toContain("99.0.0");
  });

  it("does not print when cached version is current or older", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cachePath = join(tempDir, "dosu-cli", "update-check.json");
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion: "0.0.1" }));

    checkForUpdates();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fires background fetch when cache is stale", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: "1.2.3" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    const cachePath = join(tempDir, "dosu-cli", "update-check.json");
    // Cache from 2 days ago
    writeFileSync(
      cachePath,
      JSON.stringify({ lastCheck: Date.now() - 2 * 24 * 60 * 60 * 1000, latestVersion: "0.0.1" }),
    );

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForUpdates();

    // Wait for the background promise chain to settle (fetch + cache write)
    await vi.waitFor(() => {
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.latestVersion).toBe("1.2.3");
    });
  });

  it("does not fetch when cache is fresh", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    const cachePath = join(tempDir, "dosu-cli", "update-check.json");
    writeFileSync(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion: "0.0.1" }));

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForUpdates();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes lastCheck even when fetch returns null", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForUpdates();

    const cachePath = join(tempDir, "dosu-cli", "update-check.json");
    await vi.waitFor(() => {
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.lastCheck).toBeGreaterThan(0);
    });
  });

  it("creates config directory if it does not exist when writing cache", async () => {
    const { existsSync } = require("node:fs");
    const configDir = join(tempDir, "dosu-cli");
    // Ensure the dir does NOT exist before checkForUpdates
    expect(existsSync(configDir)).toBe(false);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ latest: "1.0.0" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "error").mockImplementation(() => {});
    checkForUpdates();

    const cachePath = join(configDir, "update-check.json");
    await vi.waitFor(() => {
      expect(existsSync(cachePath)).toBe(true);
      const updated = JSON.parse(readFileSync(cachePath, "utf-8"));
      expect(updated.latestVersion).toBe("1.0.0");
    });
  });

  it("handles corrupt cache file gracefully", () => {
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(join(tempDir, "dosu-cli", "update-check.json"), "NOT JSON{{{");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => checkForUpdates()).not.toThrow();
    // No notice displayed for corrupt cache
    expect(spy).not.toHaveBeenCalled();
  });
});
