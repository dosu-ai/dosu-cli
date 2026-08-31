import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => fakeHome,
  };
});

import { allHookAgents, getHookAgent } from "./agents";
import { HOOK_COMMAND, HookConfigError } from "./formats";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "dosu-agents-test-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
});

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("registry", () => {
  it("exposes the v1 agents", () => {
    expect(allHookAgents().map((a) => a.id())).toEqual(["claude", "cursor", "codex"]);
  });

  it("looks up agents by id", () => {
    expect(getHookAgent("cursor")?.name()).toBe("Cursor");
    expect(getHookAgent("zed")).toBeUndefined();
  });

  it("reports installation from detect paths", () => {
    expect(getHookAgent("claude")?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".claude"));
    expect(getHookAgent("claude")?.isInstalled()).toBe(true);
  });
});

describe("claude agent", () => {
  it("enables a SessionEnd hook in settings.json, preserving existing settings", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: "auto",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
    );

    const claude = getHookAgent("claude");
    expect(claude?.isEnabled()).toBe(false);
    claude?.enable();

    const settings = readJSON(settingsPath) as {
      theme: string;
      hooks: Record<string, unknown[]>;
    };
    expect(settings.theme).toBe("auto");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: HOOK_COMMAND }] },
    ]);
    expect(claude?.isEnabled()).toBe(true);
  });

  it("disables cleanly", () => {
    const claude = getHookAgent("claude");
    claude?.enable();
    expect(claude?.isEnabled()).toBe(true);
    claude?.disable();
    expect(claude?.isEnabled()).toBe(false);
  });

  it("refuses to touch an unparseable settings.json", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const settingsPath = join(fakeHome, ".claude", "settings.json");
    writeFileSync(settingsPath, "{broken");

    expect(() => getHookAgent("claude")?.enable()).toThrow(HookConfigError);
    expect(readFileSync(settingsPath, "utf-8")).toBe("{broken");
  });
});

describe("cursor agent", () => {
  it("enables a stop hook in hooks.json", () => {
    const cursor = getHookAgent("cursor");
    cursor?.enable();

    const config = readJSON(join(fakeHome, ".cursor", "hooks.json")) as {
      version: number;
      hooks: { stop: unknown[] };
    };
    expect(config.version).toBe(1);
    expect(config.hooks.stop).toEqual([{ command: HOOK_COMMAND }]);
    expect(cursor?.isEnabled()).toBe(true);

    cursor?.disable();
    expect(cursor?.isEnabled()).toBe(false);
  });
});

describe("codex agent", () => {
  it("enables a Stop hook in hooks.json and surfaces the trust note", () => {
    const codex = getHookAgent("codex");
    codex?.enable();

    const config = readJSON(join(fakeHome, ".codex", "hooks.json")) as {
      hooks: { Stop: unknown[] };
    };
    expect(config.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: HOOK_COMMAND }] }]);
    expect(codex?.enableNote?.()).toMatch(/trust/i);
  });

  it("honors CODEX_HOME", () => {
    const altHome = join(fakeHome, "alt-codex");
    process.env.CODEX_HOME = altHome;

    const codex = getHookAgent("codex");
    expect(codex?.configPath()).toBe(join(altHome, "hooks.json"));
    codex?.enable();
    expect(existsSync(join(altHome, "hooks.json"))).toBe(true);
  });
});
