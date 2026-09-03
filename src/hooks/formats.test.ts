import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCursorHook,
  addGroupedHook,
  HOOK_COMMAND,
  HookConfigError,
  hasCursorHook,
  hasGroupedHook,
  hookCommand,
  isDosuHookCommand,
  readHookConfig,
  removeCursorHook,
  removeGroupedHook,
  writeHookConfig,
} from "./formats";

let dir: string;
const ORIG_DOSU_DEV = process.env.DOSU_DEV;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-hooks-test-"));
  // Hermetic default: the add/remove suites assert the stable prod command.
  delete process.env.DOSU_DEV;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DOSU_DEV === undefined) delete process.env.DOSU_DEV;
  else process.env.DOSU_DEV = ORIG_DOSU_DEV;
});

describe("readHookConfig", () => {
  it("returns an empty object for a missing file", () => {
    expect(readHookConfig(join(dir, "nope.json"))).toEqual({});
  });

  it("returns an empty object for an empty file", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "  \n");
    expect(readHookConfig(path)).toEqual({});
  });

  it("throws instead of clobbering an unparseable file", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{not json");
    expect(() => readHookConfig(path)).toThrow(HookConfigError);
  });

  it("throws on a non-object root", () => {
    const path = join(dir, "array.json");
    writeFileSync(path, "[1,2]");
    expect(() => readHookConfig(path)).toThrow(HookConfigError);
  });

  it("round-trips through writeHookConfig", () => {
    const path = join(dir, "cfg.json");
    writeHookConfig(path, { hooks: { Stop: [] } });
    expect(readHookConfig(path)).toEqual({ hooks: { Stop: [] } });
    expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
  });
});

describe("isDosuHookCommand", () => {
  it("matches the canonical command and flag variants", () => {
    expect(isDosuHookCommand(HOOK_COMMAND)).toBe(true);
    expect(isDosuHookCommand("dosu knowledge sync --quiet")).toBe(true);
  });

  it("matches dev-mode commands that pin an absolute path instead of `dosu`", () => {
    expect(
      isDosuHookCommand(
        "DOSU_DEV=true '/opt/bun' '/repo/src/index.ts' knowledge sync --quiet --detach",
      ),
    ).toBe(true);
  });

  it("rejects other commands and non-strings", () => {
    expect(isDosuHookCommand("subq hook invoke")).toBe(false);
    expect(isDosuHookCommand(undefined)).toBe(false);
    expect(isDosuHookCommand(42)).toBe(false);
  });
});

describe("hookCommand", () => {
  // Every env var the dev command's URL baking reads, cleared per test so the
  // suite is hermetic even when bun auto-loads .env files into the test env.
  const URL_ENV_VARS = [
    "DOSU_WEB_APP_URL",
    "DOSU_WEB_APP_URL_OVERRIDE",
    "DOSU_BACKEND_URL",
    "DOSU_BACKEND_URL_OVERRIDE",
    "DOSU_LLM_GATEWAY_URL_OVERRIDE",
    "SUPABASE_URL",
    "SUPABASE_URL_OVERRIDE",
    "SUPABASE_ANON_KEY",
    "SUPABASE_ANON_KEY_OVERRIDE",
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const name of URL_ENV_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of URL_ENV_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it("returns the stable PATH-resolved command outside dev mode", () => {
    expect(hookCommand()).toBe(HOOK_COMMAND);
  });

  it("pins the current working copy with the dev env inline in dev mode", () => {
    process.env.DOSU_DEV = "true";
    const command = hookCommand();
    expect(command.startsWith("DOSU_DEV=true '")).toBe(true);
    expect(command.endsWith("knowledge sync --quiet --detach")).toBe(true);
    expect(command).toContain(process.execPath);
    expect(isDosuHookCommand(command)).toBe(true);
  });

  it("writes the dev command into hook configs in dev mode", () => {
    process.env.DOSU_DEV = "true";
    const config = addCursorHook({}, "stop");
    expect(config.hooks.stop).toEqual([{ command: hookCommand() }]);
    expect(hasCursorHook(config, "stop")).toBe(true);
  });

  it("bakes the resolved dev URLs into the command, not just explicit overrides", () => {
    // The common dev case: URLs arrive via .env.development under their
    // build-time names. Hooks fire from other repos where that file is not
    // loaded, so the resolved values must ride along as *_OVERRIDE vars.
    process.env.DOSU_DEV = "true";
    process.env.DOSU_BACKEND_URL = "http://localhost:7001";
    process.env.DOSU_WEB_APP_URL = "http://localhost:3001";
    const command = hookCommand();
    expect(command).toContain("DOSU_BACKEND_URL_OVERRIDE='http://localhost:7001'");
    expect(command).toContain("DOSU_WEB_APP_URL_OVERRIDE='http://localhost:3001'");
    // Unset URLs stay out of the command.
    expect(command).not.toContain("SUPABASE_URL_OVERRIDE");
    expect(isDosuHookCommand(command)).toBe(true);
  });

  it("prefers an explicit *_OVERRIDE over the build-time name", () => {
    process.env.DOSU_DEV = "true";
    process.env.DOSU_BACKEND_URL = "http://localhost:7001";
    process.env.DOSU_BACKEND_URL_OVERRIDE = "http://localhost:7002";
    expect(hookCommand()).toContain("DOSU_BACKEND_URL_OVERRIDE='http://localhost:7002'");
  });

  it("bakes the gateway URL only when explicitly overridden", () => {
    // Unset: derived from the backend URL at hook runtime, so baking it would
    // be redundant (and wrong when the backend URL itself is empty).
    process.env.DOSU_DEV = "true";
    process.env.DOSU_BACKEND_URL = "http://localhost:7001";
    expect(hookCommand()).not.toContain("DOSU_LLM_GATEWAY_URL_OVERRIDE");

    process.env.DOSU_LLM_GATEWAY_URL_OVERRIDE = "http://localhost:9000/gateway";
    expect(hookCommand()).toContain(
      "DOSU_LLM_GATEWAY_URL_OVERRIDE='http://localhost:9000/gateway'",
    );
  });
});

describe("grouped hooks (Claude Code / Codex format)", () => {
  const OTHER_GROUP = {
    hooks: [{ type: "command", command: "some-other-tool notify" }],
  };

  it("adds our hook group to an empty config", () => {
    const config = addGroupedHook({}, "SessionEnd");
    expect(config.hooks.SessionEnd).toEqual([
      { hooks: [{ type: "command", command: HOOK_COMMAND }] },
    ]);
    expect(hasGroupedHook(config, "SessionEnd")).toBe(true);
  });

  it("preserves existing groups from other tools", () => {
    const config = addGroupedHook({ hooks: { SessionEnd: [OTHER_GROUP] } }, "SessionEnd");
    expect(config.hooks.SessionEnd).toHaveLength(2);
    expect(config.hooks.SessionEnd[0]).toEqual(OTHER_GROUP);
  });

  it("is idempotent", () => {
    const config = addGroupedHook(addGroupedHook({}, "SessionEnd"), "SessionEnd");
    expect(config.hooks.SessionEnd).toHaveLength(1);
  });

  it("refreshes a stale dosu command in place instead of keeping it", () => {
    const config = {
      hooks: {
        SessionEnd: [
          OTHER_GROUP,
          {
            hooks: [
              { type: "command", command: "'/old/bin/dosu' knowledge sync --quiet --detach" },
            ],
          },
        ],
      },
    };
    addGroupedHook(config, "SessionEnd");
    expect(config.hooks.SessionEnd).toHaveLength(2);
    expect(config.hooks.SessionEnd[0]).toEqual(OTHER_GROUP);
    expect(config.hooks.SessionEnd[1].hooks).toEqual([{ type: "command", command: HOOK_COMMAND }]);
  });

  it("preserves unrelated settings keys", () => {
    const config = addGroupedHook({ theme: "auto", hooks: { Stop: [OTHER_GROUP] } }, "SessionEnd");
    expect(config.theme).toBe("auto");
    expect(config.hooks.Stop).toEqual([OTHER_GROUP]);
  });

  it("removes only our entries, keeping other tools' groups", () => {
    const config = addGroupedHook({ hooks: { SessionEnd: [OTHER_GROUP] } }, "SessionEnd");
    removeGroupedHook(config, "SessionEnd");
    expect(config.hooks.SessionEnd).toEqual([OTHER_GROUP]);
    expect(hasGroupedHook(config, "SessionEnd")).toBe(false);
  });

  it("removes our command from a shared group without dropping the group's other hooks", () => {
    const config = {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              { type: "command", command: "other" },
              { type: "command", command: HOOK_COMMAND },
            ],
          },
        ],
      },
    };
    removeGroupedHook(config, "SessionEnd");
    expect(config.hooks.SessionEnd[0].hooks).toEqual([{ type: "command", command: "other" }]);
  });

  it("drops the event key when our group was the only one", () => {
    const config = addGroupedHook({}, "SessionEnd");
    removeGroupedHook(config, "SessionEnd");
    expect(config.hooks.SessionEnd).toBeUndefined();
  });

  it("remove is a no-op on configs without hooks", () => {
    expect(removeGroupedHook({}, "SessionEnd")).toEqual({});
  });
});

describe("cursor hooks", () => {
  const OTHER_ENTRY = { command: "/Users/x/other-hook.sh Stop" };

  it("adds our hook with version 1 to an empty config", () => {
    const config = addCursorHook({}, "stop");
    expect(config).toEqual({
      version: 1,
      hooks: { stop: [{ command: HOOK_COMMAND }] },
    });
    expect(hasCursorHook(config, "stop")).toBe(true);
  });

  it("does not overwrite an existing version field", () => {
    const config = addCursorHook({ version: 2 }, "stop");
    expect(config.version).toBe(2);
  });

  it("preserves other tools' entries and is idempotent", () => {
    const base = { version: 1, hooks: { stop: [OTHER_ENTRY] } };
    const config = addCursorHook(addCursorHook(base, "stop"), "stop");
    expect(config.hooks.stop).toEqual([OTHER_ENTRY, { command: HOOK_COMMAND }]);
  });

  it("refreshes a stale dosu command in place instead of keeping it", () => {
    const config = {
      version: 1,
      hooks: {
        stop: [
          OTHER_ENTRY,
          { command: "DOSU_DEV=true '/old/bin/dosu' knowledge sync --quiet --detach" },
        ],
      },
    };
    addCursorHook(config, "stop");
    expect(config.hooks.stop).toEqual([OTHER_ENTRY, { command: HOOK_COMMAND }]);
  });

  it("removes only our entry", () => {
    const config = addCursorHook({ version: 1, hooks: { stop: [OTHER_ENTRY] } }, "stop");
    removeCursorHook(config, "stop");
    expect(config.hooks.stop).toEqual([OTHER_ENTRY]);
  });

  it("drops the event key when ours was the only entry", () => {
    const config = addCursorHook({}, "stop");
    removeCursorHook(config, "stop");
    expect(config.hooks.stop).toBeUndefined();
  });

  it("remove is a no-op on configs without hooks", () => {
    expect(removeCursorHook({}, "stop")).toEqual({});
  });
});
