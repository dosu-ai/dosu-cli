import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatuslineAgent } from "../statusline/agents";

interface FakeAgent {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  enabledError?: Error;
  enableError?: Error;
  disableResult?: boolean;
  disableError?: Error;
}

let fakeAgents: FakeAgent[] = [];
const enableCalls: string[] = [];
const disableCalls: string[] = [];

function toAgent(agent: FakeAgent): StatuslineAgent {
  return {
    id: () => agent.id,
    name: () => agent.name,
    isInstalled: () => agent.installed,
    configPath: () => `/home/u/.${agent.id}/settings.json`,
    isEnabled: () => {
      if (agent.enabledError) throw agent.enabledError;
      return agent.enabled;
    },
    enable: () => {
      if (agent.enableError) throw agent.enableError;
      enableCalls.push(agent.id);
    },
    disable: () => {
      if (agent.disableError) throw agent.disableError;
      disableCalls.push(agent.id);
      return agent.disableResult ?? true;
    },
  };
}

vi.mock("../statusline/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../statusline/agents")>()),
  allStatuslineAgents: () => fakeAgents.map(toAgent),
  getStatuslineAgent: (id: string) => {
    const found = fakeAgents.find((a) => a.id === id);
    return found ? toAgent(found) : undefined;
  },
}));

import { HookConfigError } from "../hooks/formats";
import { StatuslineConflictError } from "../statusline/agents";
import { statuslineCommand } from "./knowledge-statusline";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const ORIG_DOSU_DEV = process.env.DOSU_DEV;

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = statuslineCommand();
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
  name: "Cursor CLI",
  installed: false,
  enabled: false,
});

beforeEach(() => {
  fakeAgents = [];
  enableCalls.length = 0;
  disableCalls.length = 0;
  delete process.env.DOSU_DEV;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
  if (ORIG_DOSU_DEV === undefined) delete process.env.DOSU_DEV;
  else process.env.DOSU_DEV = ORIG_DOSU_DEV;
});

describe("knowledge statusline status", () => {
  it("lists agents, their state, and the state legend", async () => {
    fakeAgents = [{ ...claude(), enabled: true }, cursor()];
    await run("status");
    const output = allOutput();
    expect(output).toContain("claude");
    expect(output).toContain("enabled");
    expect(output).toContain("not installed");
    expect(output).toContain("Dosu incognito");
  });

  it("--json emits rows", async () => {
    fakeAgents = [claude()];
    await run("status", "--json");
    expect(JSON.parse(allOutput())).toEqual([
      expect.objectContaining({ agent: "claude", installed: true, enabled: false }),
    ]);
  });

  it("surfaces config errors as notes", async () => {
    fakeAgents = [
      { ...claude(), enabledError: new HookConfigError("settings.json is not valid JSON") },
    ];
    await run("status");
    expect(allOutput()).toContain("not valid JSON");
    expect(process.exitCode).toBeUndefined();
  });
});

describe("knowledge statusline enable", () => {
  it("installs for named agents", async () => {
    fakeAgents = [claude(), cursor()];
    await run("enable", "claude");
    expect(enableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("status line enabled");
  });

  it("shows the dev command in dev mode", async () => {
    process.env.DOSU_DEV = "true";
    fakeAgents = [claude()];
    await run("enable");
    expect(allOutput()).toContain("Dev mode: the status line will run env DOSU_DEV=true");
  });

  it("leaves a foreign status line alone and prints the one-liner to chain ours", async () => {
    fakeAgents = [
      {
        ...claude(),
        enableError: new StatuslineConflictError("Claude Code", "claude", "~/.claude/bar.sh"),
      },
    ];
    await run("enable", "claude");
    const output = allOutput();
    expect(output).toContain("already has a status line (~/.claude/bar.sh)");
    expect(output).toContain(
      `printf '%s' "$input" | dosu knowledge statusline render --agent claude`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("reports hard failures", async () => {
    fakeAgents = [
      { ...claude(), enableError: new HookConfigError("settings.json is not valid JSON") },
    ];
    await run("enable", "claude");
    expect(errorSpy.mock.calls.join(" ")).toContain("not valid JSON");
    expect(process.exitCode).toBe(1);
  });

  it("rejects unknown agents", async () => {
    fakeAgents = [claude()];
    await run("enable", "codex");
    expect(errorSpy.mock.calls.join(" ")).toContain("unknown agent 'codex'");
    expect(enableCalls).toEqual([]);
  });
});

describe("knowledge statusline disable", () => {
  it("removes ours", async () => {
    fakeAgents = [claude()];
    await run("disable", "claude");
    expect(disableCalls).toEqual(["claude"]);
    expect(allOutput()).toContain("status line disabled");
  });

  it("says when the configured line was not ours", async () => {
    fakeAgents = [{ ...claude(), disableResult: false }];
    await run("disable");
    expect(allOutput()).toContain("was not ours");
  });

  it("reports failures", async () => {
    fakeAgents = [{ ...claude(), disableError: new Error("EACCES") }];
    await run("disable", "claude");
    expect(errorSpy.mock.calls.join(" ")).toContain("EACCES");
    expect(process.exitCode).toBe(1);
  });
});

describe("knowledge statusline render", () => {
  it("renders the stdin payload for the given agent", async () => {
    const lines: string[] = [];
    const cmd = statuslineCommand({
      readStdin: async () => '{"cwd":"/w"}',
      render: (raw, agent) => `${agent}:${raw}`,
      write: (line) => lines.push(line),
    });
    cmd.exitOverride();
    await cmd.parseAsync(["node", "test", "render", "--agent", "cursor"]);
    expect(lines).toEqual(['cursor:{"cwd":"/w"}']);
  });

  it("requires --agent", async () => {
    const cmd = statuslineCommand({ readStdin: async () => "", write: () => {} });
    cmd.exitOverride();
    for (const sub of cmd.commands) {
      sub.exitOverride();
      sub.configureOutput({ writeErr: () => {} });
    }
    await expect(cmd.parseAsync(["node", "test", "render"])).rejects.toThrow();
  });
});
