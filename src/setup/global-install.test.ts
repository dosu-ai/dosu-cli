import { describe, expect, it } from "vitest";
import { setupNeedsGlobalInstall } from "./global-install";

describe("setupNeedsGlobalInstall", () => {
  it("recognizes @dosu/cli launched ephemerally by npm exec", () => {
    expect(
      setupNeedsGlobalInstall(
        "npm",
        {
          npm_command: "exec",
          npm_execpath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
        },
        "/home/user/.npm/_npx/abc123/node_modules/.bin/dosu",
      ),
    ).toBe(true);
  });

  it("ignores inherited npm exec variables from a parent process", () => {
    expect(
      setupNeedsGlobalInstall(
        "npm",
        {
          npm_command: "exec",
          npm_execpath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
        },
        "/usr/local/lib/node_modules/@dosu/cli/bin/dosu.js",
      ),
    ).toBe(false);
  });

  it("blocks a project-local @dosu/cli even when launched from a subdirectory", () => {
    expect(
      setupNeedsGlobalInstall(
        "npm",
        {},
        "/workspace/node_modules/@dosu/cli/bin/dosu.js",
        "/workspace/packages/app",
      ),
    ).toBe(true);
  });

  it.each([
    "/home/user/.cache/pnpm/dlx-123/node_modules/@dosu/cli/bin/dosu.js",
    "/home/user/.bun/install/cache/@dosu/cli@0.49.4/bin/dosu.js",
    "C:\\repo\\node_modules\\.bin\\dosu.cmd",
  ])("blocks a temporary package runner entrypoint at %s", (entrypoint) => {
    expect(setupNeedsGlobalInstall("npm", {}, entrypoint, "/repo")).toBe(true);
  });

  it("does not mistake a global nvm package for a local install when run from home", () => {
    expect(
      setupNeedsGlobalInstall(
        "npm",
        {},
        "/home/user/.nvm/versions/node/v22/lib/node_modules/@dosu/cli/bin/dosu.js",
        "/home/user",
      ),
    ).toBe(false);
  });

  it("does not mistake bunx test execution for an npx Dosu invocation", () => {
    expect(
      setupNeedsGlobalInstall(
        "npm",
        {
          npm_lifecycle_event: "npx",
          npm_execpath: "/opt/homebrew/bin/bun",
        },
        "/workspace/node_modules/vitest/vitest.mjs",
      ),
    ).toBe(false);
  });

  it("never treats non-npm builds as temporary npx installs", () => {
    expect(
      setupNeedsGlobalInstall(
        "homebrew",
        {
          npm_command: "exec",
          npm_execpath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
        },
        "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\dosu.cmd",
      ),
    ).toBe(false);
  });
});
