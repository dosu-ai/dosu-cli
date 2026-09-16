import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncognitoAction, IncognitoAgent } from "../incognito/agents";

interface FakeAgent {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  enableResult?: IncognitoAction;
  disableResult?: IncognitoAction;
  enableError?: Error;
}

let fakeAgents: FakeAgent[] = [];
const enableCalls: string[] = [];
const disableCalls: string[] = [];

function toAgent(agent: FakeAgent): IncognitoAgent {
  return {
    id: () => agent.id,
    name: () => agent.name,
    isInstalled: () => agent.installed,
    commandPath: () => `/home/u/.${agent.id}/commands/dosu-incognito.md`,
    isEnabled: () => agent.enabled,
    enable: () => {
      if (agent.enableError) throw agent.enableError;
      enableCalls.push(agent.id);
      return agent.enableResult ?? "created";
    },
    disable: () => {
      disableCalls.push(agent.id);
      return agent.disableResult ?? "removed";
    },
  };
}

vi.mock("../incognito/agents", () => ({
  allIncognitoAgents: () => fakeAgents.map(toAgent),
  getIncognitoAgent: (id: string) => {
    const found = fakeAgents.find((a) => a.id === id);
    return found ? toAgent(found) : undefined;
  },
}));

import { incognitoCommand } from "./knowledge-incognito";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = incognitoCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

const claude = (): FakeAgent => ({
  id: "claude",
  name: "Claude Code",
  installed: true,
  enabled: false,
});
const cursor = (): FakeAgent => ({
  id: "cursor",
  name: "Cursor",
  installed: false,
  enabled: false,
});

beforeEach(() => {
  fakeAgents = [];
  enableCalls.length = 0;
  disableCalls.length = 0;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

describe("knowledge incognito status", () => {
  it("lists every agent with its state and the slash command hint", async () => {
    fakeAgents = [{ ...claude(), enabled: true }, cursor()];
    await run("status");
    const output = allOutput();
    expect(output).toContain("claude");
    expect(output).toContain("enabled");
    expect(output).toContain("not installed");
    expect(output).toContain("/dosu-incognito");
  });

  it("--json emits rows", async () => {
    fakeAgents = [claude()];
    await run("status", "--json");
    expect(JSON.parse(allOutput())).toEqual([
      expect.objectContaining({
        agent: "claude",
        installed: true,
        enabled: false,
        command_path: "/home/u/.claude/commands/dosu-incognito.md",
      }),
    ]);
  });
});

describe("knowledge incognito enable", () => {
  it("installs for named agents", async () => {
    fakeAgents = [claude(), cursor()];
    await run("enable", "claude");
    expect(enableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("/dosu-incognito installed");
  });

  it("defaults to detected agents and reports already-installed ones", async () => {
    fakeAgents = [{ ...claude(), enableResult: "unchanged" }, cursor()];
    await run("enable");
    expect(enableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("already installed");
  });

  it("rejects unknown agents", async () => {
    fakeAgents = [claude()];
    await run("enable", "zed");
    expect(errorSpy.mock.calls.join(" ")).toContain("unknown agent 'zed'");
    expect(process.exitCode).toBe(1);
    expect(enableCalls).toEqual([]);
  });

  it("reports write failures without aborting", async () => {
    fakeAgents = [{ ...claude(), enableError: new Error("EACCES") }];
    await run("enable", "claude");
    expect(errorSpy.mock.calls.join(" ")).toContain("EACCES");
    expect(process.exitCode).toBe(1);
  });
});

describe("knowledge incognito disable", () => {
  it("removes for named agents", async () => {
    fakeAgents = [claude(), cursor()];
    await run("disable", "claude");
    expect(disableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("/dosu-incognito removed");
  });

  it("says so when nothing was installed", async () => {
    fakeAgents = [{ ...claude(), disableResult: "not_found" }];
    await run("disable");
    expect(allOutput()).toContain("was not installed");
  });

  it("prints a hint when nothing is detected", async () => {
    fakeAgents = [cursor()];
    await run("disable");
    expect(allOutput()).toContain("No supported agents detected");
  });
});
