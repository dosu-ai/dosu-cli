import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeAgent {
  id: string;
  hookEnabled: boolean;
  commandInstalled: boolean;
  enableError?: unknown;
}

const state = vi.hoisted(() => ({
  configDir: "",
  agents: [] as FakeAgent[],
  hookOnlyIds: [] as string[],
  enableCalls: [] as string[],
}));

vi.mock("../config/config", () => ({ getConfigDir: () => state.configDir }));
vi.mock("../hooks/agents", () => ({
  allHookAgents: () => [
    ...state.agents.map((agent) => ({ id: () => agent.id, isEnabled: () => agent.hookEnabled })),
    ...state.hookOnlyIds.map((id) => ({ id: () => id, isEnabled: () => true })),
  ],
}));
vi.mock("../incognito/agents", () => ({
  getIncognitoAgent: (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return undefined;
    return {
      id: () => agent.id,
      name: () => `Agent ${agent.id}`,
      isEnabled: () => agent.commandInstalled,
      enable: () => {
        if (agent.enableError) throw agent.enableError;
        state.enableCalls.push(agent.id);
        agent.commandInstalled = true;
        return "created";
      },
    };
  },
}));

import { checkForIncognitoBackfill } from "./incognito-backfill-check";

let errorSpy: ReturnType<typeof vi.spyOn>;
let tmpRoot: string;
const marker = () => join(state.configDir, "incognito-backfill.json");

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "dosu-incognito-"));
  state.configDir = join(tmpRoot, "config");
  state.agents = [];
  state.hookOnlyIds = [];
  state.enableCalls = [];
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("checkForIncognitoBackfill", () => {
  it("installs the command only for agents whose studying hook is enabled", () => {
    state.agents = [
      { id: "claude", hookEnabled: true, commandInstalled: false },
      { id: "cursor", hookEnabled: false, commandInstalled: false },
      { id: "codex", hookEnabled: true, commandInstalled: true },
    ];

    checkForIncognitoBackfill();

    expect(state.enableCalls).toEqual(["claude"]);
    expect(existsSync(marker())).toBe(true);
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain("added the /dosu-incognito command to Agent claude");
  });

  it("runs once per install", () => {
    state.agents = [{ id: "claude", hookEnabled: true, commandInstalled: false }];
    checkForIncognitoBackfill();
    state.agents[0].commandInstalled = false;

    checkForIncognitoBackfill();

    expect(state.enableCalls).toEqual(["claude"]);
  });

  it("writes the marker silently when there is nothing to install", () => {
    state.agents = [{ id: "cursor", hookEnabled: false, commandInstalled: false }];

    checkForIncognitoBackfill();

    expect(existsSync(marker())).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips hook agents that have no slash command", () => {
    state.hookOnlyIds = ["opencode"];

    checkForIncognitoBackfill();

    expect(state.enableCalls).toEqual([]);
    expect(existsSync(marker())).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("leaves the marker unwritten after a failure so the next run retries", () => {
    state.agents = [
      {
        id: "claude",
        hookEnabled: true,
        commandInstalled: false,
        enableError: new Error("EACCES"),
      },
      { id: "cursor", hookEnabled: true, commandInstalled: false },
    ];

    checkForIncognitoBackfill({ notify: false });

    expect(state.enableCalls).toEqual(["cursor"]);
    expect(existsSync(marker())).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws out of the pre-action hook", () => {
    state.configDir = "\0invalid";
    expect(() => checkForIncognitoBackfill()).not.toThrow();
  });
});
