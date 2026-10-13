import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => fakeHome };
});

import { setShipTranscripts } from "../sync/state";
import { getHookAgent } from "./agents";
import { HOOK_COMMAND, HookConfigError } from "./formats";
import { geminiConfigDir, geminiHookAgent, geminiInstalled } from "./gemini";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "dosu-gemini-hooks-test-"));
  mkdirSync(join(fakeHome, "bin"));
  vi.stubEnv("PATH", join(fakeHome, "bin"));
  vi.stubEnv("XDG_CONFIG_HOME", join(fakeHome, ".config"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

interface Settings {
  theme?: string;
  hooks?: Record<string, { hooks: { command: string }[] }[]>;
}

function settings(): Settings {
  return JSON.parse(readFileSync(join(fakeHome, ".gemini", "settings.json"), "utf-8"));
}

function commandsOf(event: string): string[] {
  return (settings().hooks?.[event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
}

describe("gemini hook agent", () => {
  it("is the registry's `gemini`, keyed to Gemini CLI's settings.json", () => {
    const gemini = getHookAgent("gemini");
    expect(gemini?.name()).toBe("Gemini CLI");
    expect(gemini?.configPath()).toBe(join(fakeHome, ".gemini", "settings.json"));
    expect(geminiConfigDir()).toBe(join(fakeHome, ".gemini"));
  });

  it("counts as installed with its config dir, or only `gemini` on PATH, or GEMINI_CLI_HOME", () => {
    expect(geminiInstalled()).toBe(false);
    writeFileSync(join(fakeHome, "bin", "gemini"), "#!/bin/sh\n", { mode: 0o755 });
    expect(geminiInstalled()).toBe(true);
    rmSync(join(fakeHome, "bin", "gemini"));
    mkdirSync(join(fakeHome, ".gemini"));
    expect(geminiInstalled()).toBe(true);

    const relocated = join(fakeHome, "elsewhere");
    vi.stubEnv("GEMINI_CLI_HOME", relocated);
    expect(geminiConfigDir()).toBe(join(relocated, ".gemini"));
    expect(geminiInstalled()).toBe(false);
    expect(geminiHookAgent().configPath()).toBe(join(relocated, ".gemini", "settings.json"));
  });

  it("enables SessionEnd and AfterAgent syncs plus the BeforeAgent memory hook, keeping other settings", () => {
    mkdirSync(join(fakeHome, ".gemini"));
    writeFileSync(
      join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({
        theme: "Default",
        hooks: { BeforeTool: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
      }),
    );

    const gemini = getHookAgent("gemini");
    expect(gemini?.isEnabled()).toBe(false);
    expect(gemini?.promptMemory?.()).toBe(false);
    gemini?.enable();

    expect(settings()).toMatchObject({ theme: "Default" });
    expect(commandsOf("BeforeTool")).toEqual(["other-tool"]);
    expect(commandsOf("SessionEnd")).toEqual([HOOK_COMMAND]);
    expect(commandsOf("AfterAgent")).toEqual([HOOK_COMMAND]);
    expect(commandsOf("BeforeAgent")).toEqual([
      "dosu knowledge context --agent gemini-cli --format gemini",
    ]);
    expect(gemini?.isEnabled()).toBe(true);
    expect(gemini?.promptMemory?.()).toBe(true);
    expect(gemini?.enableNote?.()).toBe("");
    expect(gemini?.statusNote?.()).toBe("");

    // Idempotent: a second enable adds nothing.
    gemini?.enable();
    expect(commandsOf("SessionEnd")).toEqual([HOOK_COMMAND]);
    expect(commandsOf("BeforeAgent")).toHaveLength(1);
  });

  it("disables everything it added and leaves the rest", () => {
    mkdirSync(join(fakeHome, ".gemini"));
    writeFileSync(
      join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({
        hooks: { AfterAgent: [{ hooks: [{ type: "command", command: "mine" }] }] },
      }),
    );
    const gemini = getHookAgent("gemini");
    gemini?.enable();
    gemini?.disable();

    expect(gemini?.isEnabled()).toBe(false);
    expect(gemini?.promptMemory?.()).toBe(false);
    expect(settings().hooks).toEqual({
      AfterAgent: [{ hooks: [{ type: "command", command: "mine" }] }],
    });
  });

  it("leaves the memory hook out while transcript shipping is off, and says so", () => {
    setShipTranscripts(false);
    const gemini = getHookAgent("gemini");
    gemini?.enable();

    expect(commandsOf("SessionEnd")).toEqual([HOOK_COMMAND]);
    expect(settings().hooks?.BeforeAgent).toBeUndefined();
    expect(gemini?.promptMemory?.()).toBe(false);
    expect(gemini?.enableNote?.()).toContain("transcript shipping is disabled");
    expect(gemini?.statusNote?.()).toBe("");

    // Shipping back on: the end hook alone counts as enabled, and status says what is missing.
    setShipTranscripts(true);
    expect(gemini?.isEnabled()).toBe(true);
    expect(gemini?.statusNote?.()).toContain("BeforeAgent");
    gemini?.enable();
    expect(gemini?.statusNote?.()).toBe("");
  });

  it("refuses to touch an unparseable settings.json", () => {
    mkdirSync(join(fakeHome, ".gemini"));
    const path = join(fakeHome, ".gemini", "settings.json");
    writeFileSync(path, "{broken");
    expect(() => getHookAgent("gemini")?.enable()).toThrow(HookConfigError);
    expect(readFileSync(path, "utf-8")).toBe("{broken");
  });

  it("installs /dosu-incognito as a TOML command with the hooks, removed once nothing ships", () => {
    const gemini = getHookAgent("gemini");
    const command = join(fakeHome, ".gemini", "commands", "dosu-incognito.toml");

    gemini?.enable();
    const parsed = parseToml(readFileSync(command, "utf-8")) as Record<string, string>;
    expect(parsed.prompt).toContain("dosu:incognito:v1");
    expect(parsed.description).toContain("Turn Dosu off");

    gemini?.disable();
    expect(existsSync(command)).toBe(true);
    expect(gemini?.disableNote?.()).toContain("Kept /dosu-incognito");

    gemini?.enable();
    setShipTranscripts(false);
    gemini?.disable();
    expect(existsSync(command)).toBe(false);
  });
});
