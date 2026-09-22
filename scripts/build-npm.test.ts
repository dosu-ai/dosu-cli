import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDefines, normalizeNodeBundle, stripBunDebugId } from "./build-npm";

describe("build-npm script", () => {
  it("script file exists", () => {
    expect(existsSync("scripts/build-npm.ts")).toBe(true);
  });

  it("normalizeNodeBundle rewrites the shebang and strips bun directive", () => {
    const output = normalizeNodeBundle("#!/usr/bin/env bun\n// @bun\nconsole.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\n\nconsole.log('hi')\n");
  });

  it("normalizeNodeBundle prepends a node shebang when missing", () => {
    const output = normalizeNodeBundle("console.log('hi')\n");
    expect(output).toBe("#!/usr/bin/env node\nconsole.log('hi')\n");
  });

  it("re-exports buildDefines from build-all", () => {
    // buildDefines should be the same function from build-all.ts
    const defines = buildDefines();
    expect(defines).toContain("--define");
    expect(defines.some((d) => d.startsWith("process.env.DOSU_VERSION="))).toBe(true);
  });

  it("does not use redundant --env flags", () => {
    const content = readFileSync("scripts/build-npm.ts", "utf8");
    expect(content).not.toContain("--env=");
  });

  it("splits the bundle so lazily imported modules stay off the startup path", () => {
    const content = readFileSync("scripts/build-npm.ts", "utf8");
    expect(content).toContain('"--splitting"');
  });

  it("drops Bun's trailing debugId comment so sentry-cli can inject its own", () => {
    const bundle = "console.log('hi');\n\n//# debugId=99FF1EFEB52E6F8F64756E2164756E21\n";
    expect(stripBunDebugId(bundle)).toBe("console.log('hi');\n\n");
    expect(stripBunDebugId("console.log('hi');\n")).toBe("console.log('hi');\n");
  });

  it("injects debug ids after bundling and uploads every npm chunk with the pinned Sentry CLI", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      files: string[];
    };

    expect(packageJson.devDependencies["@sentry/cli"]).toBe("3.6.2");
    expect(packageJson.scripts["build:npm"]).toMatch(
      /scripts\/build-npm\.ts && sentry-cli sourcemaps inject bin$/,
    );
    expect(packageJson.scripts["upload:sourcemaps"]).toBe(
      "sentry-cli sourcemaps upload --org dosu-ai --project dosu-cli bin",
    );
    expect(packageJson.files).toEqual(["bin/*.js"]);
  });

  it("uploads source maps during release with the CI-only auth token", () => {
    const releaseConfig = readFileSync("release.config.js", "utf8");
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    // Ordering: the upload runs against the freshly built npm bundle, before
    // the release tarballs are cut.
    expect(releaseConfig).toMatch(
      /bun run build:npm &&.*bun run upload:sourcemaps.*&& bash scripts\/build-release\.sh/,
    );
    // ...but fail-open: a Sentry outage (0.48.0 hit a processing timeout) must never
    // gate shipping to npm.
    expect(releaseConfig).toContain("(bun run upload:sourcemaps ||");
    expect(workflow).toContain(`SENTRY_AUTH_TOKEN: \${{ secrets.DOSU_CLI_SENTRY_AUTH_TOKEN }}`);
    expect(workflow).toContain('NPM_CONFIG_IGNORE_SCRIPTS: "true"');
  });
});
