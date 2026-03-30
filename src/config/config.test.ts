import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Config,
  clearConfig,
  emptyConfig,
  getConfigPath,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  saveConfig,
} from "./config";

describe("config", () => {
  let origXDG: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-test-"));
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

  it("getConfigPath creates directory and returns path", () => {
    const path = getConfigPath();
    expect(path).toBe(join(tempDir, "dosu-cli", "config.json"));
    expect(existsSync(join(tempDir, "dosu-cli"))).toBe(true);
  });

  it("loadConfig returns empty config when file does not exist", () => {
    const cfg = loadConfig();
    expect(cfg.access_token).toBe("");
    expect(cfg.refresh_token).toBe("");
    expect(cfg.expires_at).toBe(0);
  });

  it("saveConfig and loadConfig round-trip", () => {
    const cfg: Config = {
      access_token: "tok_abc",
      refresh_token: "ref_xyz",
      expires_at: 1700000000,
      deployment_id: "dep-123",
      deployment_name: "My Deployment",
      api_key: "key-456",
    };
    saveConfig(cfg);
    const loaded = loadConfig();
    expect(loaded.access_token).toBe("tok_abc");
    expect(loaded.refresh_token).toBe("ref_xyz");
    expect(loaded.expires_at).toBe(1700000000);
    expect(loaded.deployment_id).toBe("dep-123");
    expect(loaded.deployment_name).toBe("My Deployment");
    expect(loaded.api_key).toBe("key-456");
  });

  it("isAuthenticated returns true when access_token is set", () => {
    expect(isAuthenticated({ access_token: "tok", refresh_token: "", expires_at: 0 })).toBe(true);
    expect(isAuthenticated({ access_token: "", refresh_token: "", expires_at: 0 })).toBe(false);
  });

  it("isTokenExpired returns false when expires_at is 0", () => {
    expect(isTokenExpired({ access_token: "", refresh_token: "", expires_at: 0 })).toBe(false);
  });

  it("isTokenExpired returns true when within 5 minutes of expiry", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Expires in 4 minutes (< 5 minute buffer)
    expect(isTokenExpired({ access_token: "", refresh_token: "", expires_at: nowSec + 240 })).toBe(
      true,
    );
    // Expires in 10 minutes (> 5 minute buffer)
    expect(isTokenExpired({ access_token: "", refresh_token: "", expires_at: nowSec + 600 })).toBe(
      false,
    );
  });

  it("clearConfig returns empty config", () => {
    const cfg: Config = {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 123,
      deployment_id: "dep",
      deployment_name: "name",
      api_key: "key",
    };
    const cleared = clearConfig(cfg);
    expect(cleared.access_token).toBe("");
    expect(cleared.refresh_token).toBe("");
    expect(cleared.expires_at).toBe(0);
    expect(cleared.deployment_id).toBeUndefined();
    expect(cleared.api_key).toBeUndefined();
  });

  it("emptyConfig returns exact default shape", () => {
    const cfg = emptyConfig();
    expect(cfg).toEqual({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
    });
    // Ensure optional fields are not present
    expect(cfg.deployment_id).toBeUndefined();
    expect(cfg.deployment_name).toBeUndefined();
    expect(cfg.api_key).toBeUndefined();
  });

  it("loadConfig returns emptyConfig on corrupt JSON file", () => {
    const { writeFileSync } = require("node:fs");
    const path = getConfigPath();
    writeFileSync(path, "NOT VALID JSON {{{{");
    const cfg = loadConfig();
    expect(cfg).toEqual({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
    });
  });

  it("clearConfig returns exact empty shape with undefined optional fields", () => {
    const cfg: Config = {
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 999,
      deployment_id: "dep",
      deployment_name: "name",
      api_key: "key",
    };
    const cleared = clearConfig(cfg);
    expect(cleared).toEqual({
      access_token: "",
      refresh_token: "",
      expires_at: 0,
      deployment_id: undefined,
      deployment_name: undefined,
      api_key: undefined,
    });
  });
});
