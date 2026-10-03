import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
  delete process.env.CLAUDE_CONFIG_DIR;
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

  it("honors CLAUDE_CONFIG_DIR", () => {
    const altDir = join(fakeHome, "claude-alt");
    process.env.CLAUDE_CONFIG_DIR = altDir;

    const claude = getHookAgent("claude");
    expect(claude?.isInstalled()).toBe(false);
    expect(claude?.configPath()).toBe(join(altDir, "settings.json"));
    claude?.enable();
    expect(claude?.isInstalled()).toBe(true);
    expect(existsSync(join(altDir, "settings.json"))).toBe(true);
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

/** Hashes `codex app-server` hooks/list reported for these exact entries (0.140 and 0.160 agree). */
const STOP_SYNC_HASH = "sha256:9af26319d88670f7b9a7975077980ca88ce25d1763e0ac3a92510b982f5d78a0";
const SESSION_END_SYNC_HASH =
  "sha256:3573ceb3bf9bc6f8a2924a03a6027d8fa36a8df2b072d1429f219ce26f86a4f4";
const PROMPT_HASH = "sha256:95aa250e19c568a288e6718b4e4034c4bc480f93e53d1bc14f325793af8be070";

describe("codex agent", () => {
  let bin: string;

  beforeEach(() => {
    // `codex --version` is the boundary: a script on an otherwise empty PATH answers for it.
    bin = join(fakeHome, "bin");
    mkdirSync(bin);
    vi.stubEnv("PATH", bin);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function installCodex(version: string): void {
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  }

  function hooksJson(): { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> } {
    return readJSON(join(fakeHome, ".codex", "hooks.json")) as never;
  }

  function trusted(): Record<string, Record<string, unknown>> {
    const config = parseToml(readFileSync(join(fakeHome, ".codex", "config.toml"), "utf-8"));
    return ((config.hooks as Record<string, unknown>)?.state ?? {}) as never;
  }

  const key = (event: string, group = 0, handler = 0) =>
    `${join(fakeHome, ".codex", "hooks.json")}:${event}:${group}:${handler}`;

  it("on Codex before 0.160 installs a per-turn Stop trigger and the prompt hook, trusted", () => {
    installCodex("0.140.0");
    const codex = getHookAgent("codex");
    codex?.enable();

    expect(hooksJson().hooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }],
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "dosu knowledge context --agent codex --format codex" },
          ],
        },
      ],
    });
    expect(trusted()).toEqual({
      [key("stop")]: { trusted_hash: STOP_SYNC_HASH },
      [key("user_prompt_submit")]: { trusted_hash: PROMPT_HASH },
    });
    expect(codex?.isEnabled()).toBe(true);
    expect(codex?.enableNote?.()).toMatch(/trust/i);
  });

  it("on Codex 0.160 adds SessionEnd and keeps Stop for older Codex builds sharing the home", () => {
    installCodex("0.160.0");
    getHookAgent("codex")?.enable();

    expect(hooksJson().hooks.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 3 }] },
    ]);
    expect(hooksJson().hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: HOOK_COMMAND }] },
    ]);
    expect(trusted()).toEqual({
      [key("stop")]: { trusted_hash: STOP_SYNC_HASH },
      [key("session_end")]: { trusted_hash: SESSION_END_SYNC_HASH },
      [key("user_prompt_submit")]: { trusted_hash: PROMPT_HASH },
    });
  });

  it("without a codex on PATH falls back to the Stop trigger", () => {
    getHookAgent("codex")?.enable();
    expect(Object.keys(hooksJson().hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
  });

  it("keys trust by CODEX_HOME's real path, as Codex resolves it", () => {
    installCodex("0.160.0");
    const real = join(fakeHome, "real-codex");
    mkdirSync(real);
    symlinkSync(real, join(fakeHome, "codex-link"));
    vi.stubEnv("CODEX_HOME", join(fakeHome, "codex-link"));

    const codex = getHookAgent("codex");
    expect(codex?.configPath()).toBe(join(fakeHome, "codex-link", "hooks.json"));
    codex?.enable();

    const config = parseToml(readFileSync(join(real, "config.toml"), "utf-8"));
    expect(Object.keys((config.hooks as { state: object }).state)).toContain(
      `${realpathSync(real)}/hooks.json:session_end:0:0`,
    );
  });

  it("converges when the installed Codex changes, carrying the user's own hook trust along", () => {
    installCodex("0.160.0");
    const codex = getHookAgent("codex");
    codex?.enable();
    // The user's own SessionEnd hook, after Dosu's, which they trusted in Codex.
    const config = hooksJson();
    config.hooks.SessionEnd.push({ hooks: [{ type: "command", command: "my-notifier" }] });
    writeFileSync(join(fakeHome, ".codex", "hooks.json"), JSON.stringify(config));
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    writeFileSync(
      tomlPath,
      `${readFileSync(tomlPath, "utf-8")}\n[hooks.state.${JSON.stringify(key("session_end", 1))}]\ntrusted_hash = "sha256:mine"\n`,
    );

    // Back to a Codex without SessionEnd: Dosu's goes, and the user's moves up with its trust.
    installCodex("0.140.0");
    codex?.enable();

    expect(hooksJson().hooks.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: "my-notifier" }] },
    ]);
    expect(trusted()).toEqual({
      [key("stop")]: { trusted_hash: STOP_SYNC_HASH },
      [key("session_end")]: { trusted_hash: "sha256:mine" },
      [key("user_prompt_submit")]: { trusted_hash: PROMPT_HASH },
    });

    installCodex("0.160.0");
    codex?.enable();

    expect(trusted()).toEqual({
      [key("stop")]: { trusted_hash: STOP_SYNC_HASH },
      [key("session_end")]: { trusted_hash: "sha256:mine" },
      [key("session_end", 1)]: { trusted_hash: SESSION_END_SYNC_HASH },
      [key("user_prompt_submit")]: { trusted_hash: PROMPT_HASH },
    });
  });

  it("disable removes exactly what enable added, leaving the rest of config.toml as it was", () => {
    installCodex("0.160.0");
    mkdirSync(join(fakeHome, ".codex"));
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    const original = [
      "# my settings",
      'model = "gpt-5"',
      "",
      '[projects."/work/app"]',
      'trust_level = "trusted" # reviewed',
      "",
    ].join("\n");
    writeFileSync(tomlPath, original);

    const codex = getHookAgent("codex");
    codex?.enable();
    expect(readFileSync(tomlPath, "utf-8")).toContain('trust_level = "trusted" # reviewed');
    codex?.disable();

    expect(readFileSync(tomlPath, "utf-8")).toBe(original);
    expect(hooksJson().hooks).toEqual({});
    expect(codex?.isEnabled()).toBe(false);
  });

  it("re-enabling keeps a Dosu hook the user switched off in Codex switched off", () => {
    installCodex("0.160.0");
    const codex = getHookAgent("codex");
    codex?.enable();
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    const promptKey = JSON.stringify(key("user_prompt_submit"));
    writeFileSync(
      tomlPath,
      readFileSync(tomlPath, "utf-8").replace(
        `[hooks.state.${promptKey}]\n`,
        `[hooks.state.${promptKey}]\nenabled = false\n`,
      ),
    );

    codex?.enable();

    expect(trusted()[key("user_prompt_submit")]).toEqual({
      enabled: false,
      trusted_hash: PROMPT_HASH,
    });
  });

  it("trusts a Dosu hook installed before trust was recorded, keeping the user's switch", () => {
    installCodex("0.160.0");
    mkdirSync(join(fakeHome, ".codex"));
    // An older install: the hook is in hooks.json, and the user switched it off in Codex.
    writeFileSync(
      join(fakeHome, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 3 }] }],
        },
      }),
    );
    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      `[hooks.state.${JSON.stringify(key("session_end"))}] # set in /hooks\nenabled = false\n`,
    );

    getHookAgent("codex")?.enable();

    expect(trusted()[key("session_end")]).toEqual({
      enabled: false,
      trusted_hash: SESSION_END_SYNC_HASH,
    });
  });

  it("an unparseable config.toml leaves both files alone, and the error says why", () => {
    installCodex("0.160.0");
    mkdirSync(join(fakeHome, ".codex"));
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    writeFileSync(tomlPath, "model = [unclosed");

    const codex = getHookAgent("codex");
    expect(() => codex?.enable()).toThrow(/trust/);
    expect(readFileSync(tomlPath, "utf-8")).toBe("model = [unclosed");
    // Hooks Codex would not run are not installed: hooks.json is untouched too.
    expect(existsSync(join(fakeHome, ".codex", "hooks.json"))).toBe(false);
    expect(codex?.isEnabled()).toBe(false);
  });

  it("refuses hook state kept as an inline table instead of rewriting it", () => {
    installCodex("0.160.0");
    mkdirSync(join(fakeHome, ".codex"));
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    const inline = `[hooks.state]\n${JSON.stringify(key("session_end"))} = { enabled = true }\n`;
    writeFileSync(tomlPath, inline);

    expect(() => getHookAgent("codex")?.enable()).toThrow(HookConfigError);
    expect(readFileSync(tomlPath, "utf-8")).toBe(inline);
    expect(existsSync(join(fakeHome, ".codex", "hooks.json"))).toBe(false);
  });

  it("is not enabled while Dosu's hook sits in hooks.json untrusted, until enable trusts it", () => {
    installCodex("0.140.0");
    mkdirSync(join(fakeHome, ".codex"));
    // What an older CLI left: the Stop hook, with no trust recorded, so `codex exec` skips it.
    writeFileSync(
      join(fakeHome, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
      }),
    );
    const codex = getHookAgent("codex");
    expect(codex?.isEnabled()).toBe(false);

    codex?.enable();
    expect(codex?.isEnabled()).toBe(true);

    // A hash that no longer matches the hook (edited by hand) is not trust either.
    const tomlPath = join(fakeHome, ".codex", "config.toml");
    writeFileSync(tomlPath, readFileSync(tomlPath, "utf-8").replace(STOP_SYNC_HASH, "sha256:old"));
    expect(codex?.isEnabled()).toBe(false);
  });
});
