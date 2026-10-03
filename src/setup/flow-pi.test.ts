/** `dosu setup` on a machine with pi: pi has no MCP config, so the agent setup offers is the Dosu
 * pi extension itself (memory tools, session-end trigger, prompt-time memory, /dosu-incognito). */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";
import { stepConfigureTools, stepDetectTools } from "./flow";

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-setup-pi-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const cfg = makeTestConfig({
  access_token: "tok",
  refresh_token: "ref",
  expires_at: 0,
  deployment_id: "dep-123",
  api_key: "key-abc",
});

describe("dosu setup with pi", () => {
  it("is not offered where pi is absent", () => {
    expect(stepDetectTools().map((p) => p.id())).not.toContain("pi");
  });

  it("offers pi once it is installed, installs the extension, and removes it again", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const extension = join(home, ".pi", "agent", "extensions", "dosu.ts");

    const pi = stepDetectTools().find((p) => p.id() === "pi");
    expect(pi?.name()).toBe("Pi");
    expect(pi?.isConfigured()).toBe(false);
    if (!pi) return;

    const [installed] = stepConfigureTools(cfg, { toInstall: [pi], toRemove: [], skipped: [] });
    expect(installed).toMatchObject({ action: "install", hook: { name: "Pi", path: extension } });
    expect(installed.error).toBeUndefined();
    expect(pi.isConfigured()).toBe(true);
    expect(pi.globalConfigPath()).toBe(extension);

    const [removed] = stepConfigureTools(cfg, { toInstall: [], toRemove: [pi], skipped: [] });
    expect(removed).toMatchObject({ action: "remove" });
    expect(removed.error).toBeUndefined();
    expect(existsSync(extension)).toBe(false);
  });

  it("has no project-local install", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const pi = stepDetectTools().find((p) => p.id() === "pi");

    expect(pi?.supportsLocal()).toBe(false);
    expect(() => pi?.install(cfg, false)).toThrow(/only globally/);
    expect(() => pi?.remove(false)).toThrow(/only globally/);
  });
});
