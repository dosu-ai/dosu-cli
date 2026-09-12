import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installJSONServer,
  isJSONKeyConfigured,
  loadJSONConfig,
  mcpHeaders,
  mcpURL,
  readJSONConfig,
  removeJSONServer,
  saveJSONConfig,
  stripJSONComments,
  stripTrailingCommas,
  writeSecureFile,
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

  it("drops an unterminated block comment to end of input", () => {
    expect(stripJSONComments('{"a": 1} /* open')).toBe('{"a": 1} ');
  });

  it("handles empty input", () => {
    expect(stripJSONComments("")).toBe("");
  });
});

describe("stripTrailingCommas", () => {
  it("drops trailing commas before } and ] across whitespace", () => {
    const input = '{\n  "a": [1, 2,\n  ],\n  "b": {"c": 1,},\n}';
    expect(JSON.parse(stripTrailingCommas(input))).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it("leaves commas inside strings alone", () => {
    const input = '{"a": ",}", "b": ",]", "c": "x\\",}"}';
    expect(stripTrailingCommas(input)).toBe(input);
  });

  it("does not touch separating commas", () => {
    const input = '{"a": 1, "b": [1, 2]}';
    expect(stripTrailingCommas(input)).toBe(input);
  });

  it("passes through an unterminated string ending in a backslash", () => {
    const input = '{"a": "abc\\';
    expect(stripTrailingCommas(input)).toBe(input);
  });

  it("handles empty input", () => {
    expect(stripTrailingCommas("")).toBe("");
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

    it("tolerates comments and trailing commas in a .json file (Zed/VS Code style)", () => {
      const path = join(tempDir, "settings.json");
      writeFileSync(
        path,
        '// Zed settings\n// documentation: https://zed.dev/docs/configuring-zed\n{\n  "ui_font_size": 16, /* px */\n  "theme": { "mode": "system", },\n}',
      );
      expect(loadJSONConfig(path)).toEqual({ ui_font_size: 16, theme: { mode: "system" } });
    });

    it("returns empty object for an unparseable file", () => {
      const path = join(tempDir, "broken.json");
      writeFileSync(path, "{ not json");
      expect(loadJSONConfig(path)).toEqual({});
    });
  });

  describe("readJSONConfig", () => {
    it("returns empty object for a missing or blank file", () => {
      expect(readJSONConfig(join(tempDir, "missing.json"))).toEqual({});
      const blank = join(tempDir, "blank.json");
      writeFileSync(blank, "  \n");
      expect(readJSONConfig(blank)).toEqual({});
    });

    it("throws a descriptive error for an unparseable file", () => {
      const path = join(tempDir, "broken.json");
      writeFileSync(path, "{ not json");
      expect(() => readJSONConfig(path)).toThrow(/Could not parse .*broken\.json as JSON/);
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

    it("replaces existing loose-permission files with owner-only permissions", () => {
      const path = join(tempDir, "secret.json");
      writeFileSync(path, "old secret", { mode: 0o644 });

      writeSecureFile(path, "new secret");

      expect(readFileSync(path, "utf-8")).toBe("new secret");
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

    it("preserves the rest of a commented settings file (Zed's default template)", () => {
      const path = join(tempDir, "settings.json");
      writeFileSync(
        path,
        '// Zed settings\n{\n  "ui_font_size": 16,\n  "theme": { "mode": "system", "light": "One Light", "dark": "One Dark" },\n}',
      );
      installJSONServer(path, "context_servers", { url: "http://dosu" });
      const result = loadJSONConfig(path);
      expect(result.ui_font_size).toBe(16);
      expect(result.theme).toEqual({ mode: "system", light: "One Light", dark: "One Dark" });
      expect(result.context_servers.dosu).toEqual({ url: "http://dosu" });
    });

    it("refuses to overwrite a file it cannot parse", () => {
      const path = join(tempDir, "broken.json");
      const original = '{"mcpServers": { "other": ';
      writeFileSync(path, original);
      expect(() => installJSONServer(path, "mcpServers", { url: "x" })).toThrow(/Could not parse/);
      expect(readFileSync(path, "utf-8")).toBe(original);
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

    it("does not create the file when it is missing", () => {
      const path = join(tempDir, "nope.json");
      removeJSONServer(path, "mcpServers");
      expect(existsSync(path)).toBe(false);
    });

    it("leaves an unparseable file untouched", () => {
      const path = join(tempDir, "broken.json");
      const original = "{ definitely not json";
      writeFileSync(path, original);
      removeJSONServer(path, "mcpServers");
      expect(readFileSync(path, "utf-8")).toBe(original);
    });

    it("does not rewrite a file that has no dosu entry", () => {
      const path = join(tempDir, "untouched.json");
      const original = '// keep my comment\n{"mcpServers": {"other": {"url": "y"}}}';
      writeFileSync(path, original);
      removeJSONServer(path, "mcpServers");
      expect(readFileSync(path, "utf-8")).toBe(original);
    });
  });
});
