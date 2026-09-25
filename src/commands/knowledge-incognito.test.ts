import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncognitoAction, IncognitoAgent } from "../incognito/agents";

interface FakeAgent {
  id: string;
  name: string;
  installed: boolean;
  commandInstalled: boolean;
  enableError?: unknown;
}

const state = vi.hoisted(() => ({
  incognitoAgents: [] as string[],
  saveError: undefined as unknown,
  setCalls: [] as Array<{ ids: string[]; incognito: boolean }>,
}));

let fakeAgents: FakeAgent[] = [];
const enableCalls: string[] = [];

function toAgent(agent: FakeAgent): IncognitoAgent {
  return {
    id: () => agent.id,
    name: () => agent.name,
    isInstalled: () => agent.installed,
    commandPath: () => `/home/u/.${agent.id}/commands/dosu-incognito.md`,
    isEnabled: () => agent.commandInstalled,
    enable: (): IncognitoAction => {
      if (agent.enableError) throw agent.enableError;
      enableCalls.push(agent.id);
      return "created";
    },
    disable: (): IncognitoAction => "removed",
  };
}

vi.mock("../incognito/agents", () => ({
  allIncognitoAgents: () => fakeAgents.map(toAgent),
  getIncognitoAgent: (id: string) => {
    const found = fakeAgents.find((a) => a.id === id);
    return found ? toAgent(found) : undefined;
  },
}));

vi.mock("../sync/watermark", () => ({
  loadSyncState: () => ({ incognito_agents: state.incognitoAgents }),
  setAgentsIncognito: (ids: string[], incognito: boolean) => {
    if (state.saveError) throw state.saveError;
    state.setCalls.push({ ids, incognito });
  },
}));

import { incognitoCommand } from "./knowledge-incognito";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function allErrors(): string {
  return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = incognitoCommand();
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  await cmd.parseAsync(["node", "test", ...args]);
}

const claude = (): FakeAgent => ({
  id: "claude",
  name: "Claude Code",
  installed: true,
  commandInstalled: true,
});
const cursor = (): FakeAgent => ({
  id: "cursor",
  name: "Cursor",
  installed: false,
  commandInstalled: false,
});

beforeEach(() => {
  fakeAgents = [];
  enableCalls.length = 0;
  state.incognitoAgents = [];
  state.saveError = undefined;
  state.setCalls = [];
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

describe("knowledge incognito status", () => {
  it("shows studied, incognito, and missing agents with the switch hint", async () => {
    fakeAgents = [claude(), { ...cursor(), installed: true }, { ...cursor(), id: "codex" }];
    state.incognitoAgents = ["cursor"];
    await run("status");
    const output = allOutput();
    expect(output).toMatch(/claude\s+Claude Code\s+📚 studied/);
    expect(output).toMatch(
      /cursor\s+Cursor\s+👻 incognito \(not studied\)\s+\(\/dosu-incognito missing\)/,
    );
    expect(output).toMatch(/codex\s+Cursor\s+agent not found/);
    expect(output).toContain("incognito on|off");
    expect(output).toContain("type /dosu-incognito in it");
  });

  it("--json emits rows", async () => {
    fakeAgents = [claude()];
    state.incognitoAgents = ["claude"];
    await run("status", "--json");
    expect(JSON.parse(allOutput())).toEqual([
      {
        agent: "claude",
        name: "Claude Code",
        installed: true,
        incognito: true,
        command_installed: true,
        command_path: "/home/u/.claude/commands/dosu-incognito.md",
      },
    ]);
  });
});

describe("knowledge incognito on", () => {
  it("saves named agents as incognito and keeps the slash command installed", async () => {
    fakeAgents = [claude(), cursor()];
    await run("on", "claude");
    expect(state.setCalls).toEqual([{ ids: ["claude"], incognito: true }]);
    expect(enableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("Claude Code is incognito");
  });

  it("defaults to detected agents", async () => {
    fakeAgents = [claude(), cursor()];
    await run("on");
    expect(state.setCalls).toEqual([{ ids: ["claude"], incognito: true }]);
  });

  it("does nothing when no agent resolves", async () => {
    fakeAgents = [cursor()];
    await run("on");
    expect(state.setCalls).toEqual([]);
    expect(allOutput()).toContain("No supported agents detected");
  });

  it("rejects unknown agents", async () => {
    fakeAgents = [claude()];
    await run("on", "zed");
    expect(allErrors()).toContain("unknown agent 'zed'");
    expect(process.exitCode).toBe(1);
    expect(state.setCalls).toEqual([]);
  });

  it("reports a failed save and changes nothing else", async () => {
    fakeAgents = [claude()];
    state.saveError = new Error("EACCES");
    await run("on", "claude");
    expect(allErrors()).toContain("could not save the setting: EACCES");
    expect(process.exitCode).toBe(1);
    expect(enableCalls).toEqual([]);
  });

  it("still switches when the slash command cannot be written", async () => {
    fakeAgents = [{ ...claude(), enableError: "disk full" }];
    await run("on", "claude");
    expect(state.setCalls).toEqual([{ ids: ["claude"], incognito: true }]);
    expect(allErrors()).toContain("could not install /dosu-incognito: disk full");
    expect(allOutput()).toContain("Claude Code is incognito");
    expect(process.exitCode).toBe(1);
  });

  it("no longer accepts the old enable name", async () => {
    fakeAgents = [claude()];
    await expect(run("enable", "claude")).rejects.toThrow();
    expect(state.setCalls).toEqual([]);
  });
});

describe("knowledge incognito off", () => {
  it("studies named agents again and notes past sessions stay unstudied", async () => {
    fakeAgents = [claude()];
    await run("off", "claude");
    expect(state.setCalls).toEqual([{ ids: ["claude"], incognito: false }]);
    expect(enableCalls).toEqual(["claude"]);
    const output = allOutput();
    expect(output).toContain("Claude Code is studied again");
    expect(output).toContain("stay unstudied");
  });
});
