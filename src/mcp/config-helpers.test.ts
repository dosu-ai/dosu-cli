import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installJSONServer,
  isJSONKeyConfigured,
  loadJSONConfig,
  mcpHeaders,
  mcpURL,
  removeJSONServer,
  saveJSONConfig,
  stripJSONComments,
} from "./config-helpers";

describe("mcpURL", () => {
  const savedBackendURL = process.env.DOSU_BACKEND_URL;

  beforeEach(() => {
    process.env.DOSU_BACKEND_URL = "https://api.test.dev";
  });

  afterEach(() => {
    if (savedBackendURL !== undefined) {
      process.env.DOSU_BACKEND_URL = savedBackendURL;
    } else {
      delete process.env.DOSU_BACKEND_URL;
    }
  });

  it("builds correct URL with deployment ID", () => {
    const url = mcpURL("deploy-abc");
    expect(url).toContain("/v1/mcp/deployments/deploy-abc");
    expect(url).toMatch(/^https?:\/\//);
  });
});

describe("mcpHeaders", () => {
  it("returns correct header map", () => {
    const headers = mcpHeaders("my-api-key");
    expect(headers).toEqual({ "X-Dosu-API-Key": "my-api-key" });
  });

  it("throws instead of returning an empty header map when the API key is missing", () => {
    expect(() => mcpHeaders(undefined)).toThrow("API key is required");
    expect(() => mcpHeaders("")).toThrow("API key is required");
  });
});

describe("stripJSONComments", () => {
  it("strips line comments", () => {
    const input = '{"key": "value" // comment\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("strips block comments", () => {
    const input = '{"key": /* block */ "value"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("preserves strings containing comment-like sequences", () => {
    const input = '{"url": "http://example.com"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ url: "http://example.com" });
  });

  it("preserves strings with // inside", () => {
    const input = '{"url": "http://host:8080/path"}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ url: "http://host:8080/path" });
  });

  it("handles escaped quotes in strings", () => {
    const input = '{"key": "val\\"ue" // comment\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: 'val"ue' });
  });

  it("handles multiline block comments", () => {
    const input = '{\n/* multi\nline\ncomment */\n"key": "value"\n}';
    const result = stripJSONComments(input);
    expect(JSON.parse(result)).toEqual({ key: "value" });
  });

  it("handles empty input", () => {
    expect(stripJSONComments("")).toBe("");
  });
});

describe("JSON config file operations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadJSONConfig", () => {
    it("returns empty object for non-existent file", () => {
      const result = loadJSONConfig(join(tempDir, "nonexistent.json"));
      expect(result).toEqual({});
    });

    it("reads JSON file", () => {
      const path = join(tempDir, "test.json");
      writeFileSync(path, '{"foo": "bar"}');
      expect(loadJSONConfig(path)).toEqual({ foo: "bar" });
    });

    it("reads JSONC file with comments", () => {
      const path = join(tempDir, "test.jsonc");
      writeFileSync(path, '{\n// comment\n"foo": "bar"\n}');
      expect(loadJSONConfig(path)).toEqual({ foo: "bar" });
    });
  });

  describe("saveJSONConfig", () => {
    it("writes JSON file with indentation", () => {
      const path = join(tempDir, "out.json");
      saveJSONConfig(path, { hello: "world" });
      const raw = readFileSync(path, "utf-8");
      expect(JSON.parse(raw)).toEqual({ hello: "world" });
      expect(raw).toContain("  "); // indented
    });

    it("creates parent directories", () => {
      const path = join(tempDir, "deep", "nested", "out.json");
      saveJSONConfig(path, { x: 1 });
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ x: 1 });
    });

    it("writes config files with owner-only permissions", () => {
      const path = join(tempDir, "secret.json");
      saveJSONConfig(path, { headers: { "X-Dosu-API-Key": "key" } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  describe("isJSONKeyConfigured", () => {
    it("returns false for non-existent file", () => {
      expect(isJSONKeyConfigured(join(tempDir, "nope.json"), "mcpServers")).toBe(false);
    });

    it("returns false when key section is missing", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, "{}");
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(false);
    });

    it("returns false when dosu entry is missing", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, '{"mcpServers": {"other": {}}}');
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(false);
    });

    it("returns true when dosu entry exists", () => {
      const path = join(tempDir, "cfg.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "http://x"}}}');
      expect(isJSONKeyConfigured(path, "mcpServers")).toBe(true);
    });
  });

  describe("installJSONServer", () => {
    it("creates new file with server entry", () => {
      const path = join(tempDir, "new.json");
      installJSONServer(path, "mcpServers", { url: "http://test" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "http://test" });
    });

    it("adds to existing config without overwriting other entries", () => {
      const path = join(tempDir, "existing.json");
      writeFileSync(path, '{"mcpServers": {"other": {"url": "http://other"}}}');
      installJSONServer(path, "mcpServers", { url: "http://dosu" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "http://dosu" });
      expect(result.mcpServers.other).toEqual({ url: "http://other" });
    });

    it("overwrites existing dosu entry", () => {
      const path = join(tempDir, "overwrite.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "old"}}}');
      installJSONServer(path, "mcpServers", { url: "new" });
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toEqual({ url: "new" });
    });
  });

  describe("removeJSONServer", () => {
    it("does nothing for non-existent file", () => {
      // Should not throw
      removeJSONServer(join(tempDir, "nope.json"), "mcpServers");
    });

    it("removes dosu entry from config", () => {
      const path = join(tempDir, "remove.json");
      writeFileSync(path, '{"mcpServers": {"dosu": {"url": "x"}, "other": {"url": "y"}}}');
      removeJSONServer(path, "mcpServers");
      const result = loadJSONConfig(path);
      expect(result.mcpServers.dosu).toBeUndefined();
      expect(result.mcpServers.other).toEqual({ url: "y" });
    });
  });
});
