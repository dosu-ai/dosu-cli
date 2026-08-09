import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDefines } from "./build-all";

describe("build-all script", () => {
  it("script file exists", () => {
    expect(existsSync(join(__dirname, "build-all.ts"))).toBe(true);
  });

  it("defines correct target platforms", () => {
    const content = readFileSync(join(__dirname, "build-all.ts"), "utf-8");
    expect(content).toContain("bun-darwin-arm64");
    expect(content).toContain("bun-darwin-x64");
    expect(content).toContain("bun-linux-x64-baseline");
    expect(content).toContain("bun-linux-arm64");
    expect(content).toContain("bun-linux-x64-musl");
    expect(content).toContain("bun-linux-arm64-musl");
    expect(content).toContain("bun-windows-x64-baseline");
  });
});

describe("buildDefines", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.DOSU_VERSION = process.env.DOSU_VERSION;
    envBackup.DOSU_WEB_APP_URL = process.env.DOSU_WEB_APP_URL;
    envBackup.DOSU_BACKEND_URL = process.env.DOSU_BACKEND_URL;
    envBackup.SUPABASE_URL = process.env.SUPABASE_URL;
    envBackup.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    envBackup.DOSU_INSTALL_CHANNEL = process.env.DOSU_INSTALL_CHANNEL;
    envBackup.DOSU_POSTHOG_PROJECT_TOKEN = process.env.DOSU_POSTHOG_PROJECT_TOKEN;
    envBackup.DOSU_SENTRY_DSN = process.env.DOSU_SENTRY_DSN;
    delete process.env.DOSU_VERSION;
    delete process.env.DOSU_WEB_APP_URL;
    delete process.env.DOSU_BACKEND_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.DOSU_INSTALL_CHANNEL;
    delete process.env.DOSU_POSTHOG_PROJECT_TOKEN;
    delete process.env.DOSU_SENTRY_DSN;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("should read version from package.json when DOSU_VERSION is unset", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    const defines = buildDefines();
    expect(defines).toContain(`process.env.DOSU_VERSION=${JSON.stringify(packageVersion)}`);
  });

  it("should return empty strings for URL vars when env vars are not set", () => {
    const defines = buildDefines();
    expect(defines).toContain('process.env.DOSU_WEB_APP_URL=""');
    expect(defines).toContain('process.env.DOSU_BACKEND_URL=""');
    expect(defines).toContain('process.env.SUPABASE_URL=""');
    expect(defines).toContain('process.env.SUPABASE_ANON_KEY=""');
    expect(defines).toContain('process.env.DOSU_POSTHOG_PROJECT_TOKEN=""');
    expect(defines).toContain('process.env.DOSU_SENTRY_DSN=""');
  });

  it("should use env vars when set", () => {
    process.env.DOSU_VERSION = "1.2.3";
    process.env.DOSU_WEB_APP_URL = "https://app.test.dev";
    process.env.DOSU_BACKEND_URL = "https://api.test.dev";
    process.env.SUPABASE_URL = "https://db.test.dev";
    process.env.SUPABASE_ANON_KEY = "anon-test-key";
    process.env.DOSU_INSTALL_CHANNEL = "homebrew";
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = "phc_test";
    process.env.DOSU_SENTRY_DSN = "https://public@sentry.test/1";

    const defines = buildDefines();
    expect(defines).toEqual([
      "--define",
      'process.env.DOSU_VERSION="1.2.3"',
      "--define",
      'process.env.DOSU_WEB_APP_URL="https://app.test.dev"',
      "--define",
      'process.env.DOSU_BACKEND_URL="https://api.test.dev"',
      "--define",
      'process.env.SUPABASE_URL="https://db.test.dev"',
      "--define",
      'process.env.SUPABASE_ANON_KEY="anon-test-key"',
      "--define",
      'process.env.DOSU_INSTALL_CHANNEL="homebrew"',
      "--define",
      'process.env.DOSU_POSTHOG_PROJECT_TOKEN="phc_test"',
      "--define",
      'process.env.DOSU_SENTRY_DSN="https://public@sentry.test/1"',
    ]);
  });

  it.each([
    "phx_personal_secret",
    "phs_project_secret",
    "pha_oauth_secret",
    "phr_restricted_secret",
    "arbitrary-secret",
  ])("refuses to bake a non-public PostHog credential", (token) => {
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = token;

    expect(() => buildDefines()).toThrow("must be empty or a public phc_ project token");
  });

  it.each([
    "sntrys_secret",
    "sntryu_secret",
  ])("refuses to bake Sentry auth token %s as a DSN", (token) => {
    process.env.DOSU_SENTRY_DSN = `https://${token}@sentry.test/1`;

    expect(() => buildDefines()).toThrow("must be empty or a public HTTPS client DSN");
  });

  it("should produce valid JSON-stringified values", () => {
    process.env.DOSU_VERSION = 'has"quotes';
    const defines = buildDefines();
    expect(defines[1]).toBe('process.env.DOSU_VERSION="has\\"quotes"');
  });

  it("should return exactly 16 elements (8 pairs of --define + value)", () => {
    const defines = buildDefines();
    expect(defines).toHaveLength(16);
    expect(defines.filter((_, i) => i % 2 === 0)).toEqual([
      "--define",
      "--define",
      "--define",
      "--define",
      "--define",
      "--define",
      "--define",
      "--define",
    ]);
  });

  it("should default INSTALL_CHANNEL to npm when env var is not set", () => {
    const defines = buildDefines();
    expect(defines).toContain('process.env.DOSU_INSTALL_CHANNEL="npm"');
  });
});
