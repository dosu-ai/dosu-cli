import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDefines, normalizeNodeBundle } from "./build-npm";

describe("build-npm script", () => {
  it("script file exists", () => {
    expect(existsSync("scripts/build-npm.ts")).toBe(true);
  });

  it("normalizeNodeBundle rewrites the shebang and strips bun directive", () => {
    const output = normalizeNodeBundle("#!/usr/bin/env bun\n// @bun\nconsole.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\nconsole.log('hi')\n");
  });

  it("normalizeNodeBundle prepends a node shebang when missing", () => {
    const output = normalizeNodeBundle("console.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\nconsole.log('hi')\n");
  });

  it("buildDefines defaults to the package version", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    const defines = buildDefines();
    expect(defines).toContain(`process.env.DOSU_VERSION=${JSON.stringify(packageVersion)}`);
    expect(defines).toContain(`process.env.DOSU_COMMIT=${JSON.stringify("none")}`);
    expect(defines).toContain(`process.env.DOSU_DATE=${JSON.stringify("unknown")}`);
    expect(defines).toContain('process.env.DOSU_WEB_APP_URL=""');
    expect(defines).toContain('process.env.DOSU_BACKEND_URL=""');
    expect(defines).toContain('process.env.SUPABASE_URL=""');
    expect(defines).toContain('process.env.SUPABASE_ANON_KEY=""');
  });

  it("buildDefines prefers explicit environment overrides", () => {
    process.env.DOSU_VERSION = "9.9.9";
    process.env.DOSU_COMMIT = "abc123";
    process.env.DOSU_DATE = "2026-03-30T00:00:00Z";
    process.env.DOSU_WEB_APP_URL = "https://app.test.dev";
    process.env.DOSU_BACKEND_URL = "https://api.test.dev";
    process.env.SUPABASE_URL = "https://db.test.dev";
    process.env.SUPABASE_ANON_KEY = "anon-test-key";

    const defines = buildDefines();

    expect(defines).toContain(`process.env.DOSU_VERSION=${JSON.stringify("9.9.9")}`);
    expect(defines).toContain(`process.env.DOSU_COMMIT=${JSON.stringify("abc123")}`);
    expect(defines).toContain(`process.env.DOSU_DATE=${JSON.stringify("2026-03-30T00:00:00Z")}`);
    expect(defines).toContain(`process.env.DOSU_WEB_APP_URL=${JSON.stringify("https://app.test.dev")}`);
    expect(defines).toContain(`process.env.DOSU_BACKEND_URL=${JSON.stringify("https://api.test.dev")}`);
    expect(defines).toContain(`process.env.SUPABASE_URL=${JSON.stringify("https://db.test.dev")}`);
    expect(defines).toContain(`process.env.SUPABASE_ANON_KEY=${JSON.stringify("anon-test-key")}`);

    delete process.env.DOSU_VERSION;
    delete process.env.DOSU_COMMIT;
    delete process.env.DOSU_DATE;
    delete process.env.DOSU_WEB_APP_URL;
    delete process.env.DOSU_BACKEND_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  it("inlines Dosu and Supabase environment variables into the bundle", () => {
    const content = readFileSync("scripts/build-npm.ts", "utf8");
    expect(content).toContain("--env=DOSU_*");
    expect(content).toContain("--env=SUPABASE_*");
  });
});
