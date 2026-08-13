import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUNDLE_DEBUG_ID_PLACEHOLDER,
  buildDefines,
  finalizeSourceMapBundle,
  normalizeNodeBundle,
} from "./build-npm";

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

  it("embeds Bun's exact debug id in the bundle and source map", () => {
    const bunDebugId = "99FF1EFEB52E6F8F64756E2164756E21";
    const result = finalizeSourceMapBundle(
      `const debugId = "${BUNDLE_DEBUG_ID_PLACEHOLDER}";\n//# debugId=${bunDebugId}\n`,
      JSON.stringify({ version: 3, sources: ["../src/index.ts"], debugId: bunDebugId }),
    );

    expect(result.debugId).toBe("99ff1efe-b52e-6f8f-6475-6e2164756e21");
    expect(result.bundle).toContain(`"${result.debugId}"`);
    expect(result.bundle).toContain(`//# debugId=${result.debugId}`);
    expect(JSON.parse(result.sourceMap)).toMatchObject({
      debugId: result.debugId,
      sources: ["src/index.ts"],
    });
    expect(result.bundle).not.toContain(BUNDLE_DEBUG_ID_PLACEHOLDER);
  });

  it("rejects a source map whose debug id does not match the bundle", () => {
    expect(() =>
      finalizeSourceMapBundle(
        `const debugId = "${BUNDLE_DEBUG_ID_PLACEHOLDER}";\n//# debugId=99FF1EFEB52E6F8F64756E2164756E21\n`,
        JSON.stringify({
          version: 3,
          sources: ["../src/index.ts"],
          debugId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      ),
    ).toThrow("debug IDs do not match");
  });

  it("rejects source maps containing an absolute build path", () => {
    const debugId = "99FF1EFEB52E6F8F64756E2164756E21";
    expect(() =>
      finalizeSourceMapBundle(
        `const debugId = "${BUNDLE_DEBUG_ID_PLACEHOLDER}";\n//# debugId=${debugId}\n`,
        JSON.stringify({
          version: 3,
          sources: ["/Users/alice/private/src/index.ts"],
          debugId,
        }),
      ),
    ).toThrow("repository-owned source paths");
  });

  it("rejects relative source paths that escape the repository", () => {
    const debugId = "99FF1EFEB52E6F8F64756E2164756E21";
    expect(() =>
      finalizeSourceMapBundle(
        `const debugId = "${BUNDLE_DEBUG_ID_PLACEHOLDER}";\n//# debugId=${debugId}\n`,
        JSON.stringify({
          version: 3,
          sources: ["../../private/src/index.ts"],
          debugId,
        }),
      ),
    ).toThrow("repository-owned source paths");
  });

  it("uploads only the npm bundle artifacts with the pinned Sentry CLI", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      files: string[];
    };

    expect(packageJson.devDependencies["@sentry/cli"]).toBe("3.6.2");
    expect(packageJson.scripts["upload:sourcemaps"]).toBe(
      "sentry-cli sourcemaps upload --org dosu-ai --project dosu-cli --validate --wait --strict --url-prefix app:///bin bin/dosu.js bin/dosu.js.map",
    );
    expect(packageJson.files).toEqual(["bin/dosu.js"]);
  });

  it("uploads source maps during release with the CI-only auth token", () => {
    const releaseConfig = readFileSync("release.config.js", "utf8");
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    // Ordering: the upload runs against the freshly built npm bundle, before
    // the release tarballs are cut.
    expect(releaseConfig).toMatch(
      /bun run build:npm &&.*bun run upload:sourcemaps.*&& bash scripts\/build-release\.sh/,
    );
    // ...but fail-open. `sentry-cli --wait` gave up on Sentry's server-side
    // processing mid-release once and took the whole 0.48.0 publish down with
    // it, even though the upload had succeeded. Source maps are observability,
    // not a release artifact, so they must never gate shipping to npm.
    expect(releaseConfig).toContain("(bun run upload:sourcemaps ||");
    expect(workflow).toContain(`SENTRY_AUTH_TOKEN: \${{ secrets.DOSU_CLI_SENTRY_AUTH_TOKEN }}`);
    expect(workflow).toContain('NPM_CONFIG_IGNORE_SCRIPTS: "true"');
  });
});
