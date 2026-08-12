import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  binOnPath,
  cursorAgentBin,
  kickoffAgentLabel,
  launchKickoffAgent,
  listAvailableKickoffAgents,
  resolveKickoffAgent,
} from "./agent-kickoff";

function mockWhich(present: Record<string, boolean>): void {
  mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "which" || cmd === "where") {
      const bin = args[0] ?? "";
      return { status: present[bin] ? 0 : 1 };
    }
    return { status: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawn.mockReturnValue({ unref: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("binOnPath", () => {
  it("detects binaries via which/where", () => {
    mockWhich({ dosu: true });
    expect(binOnPath("dosu")).toBe(true);
  });

  it("returns false when missing", () => {
    mockWhich({ dosu: false });
    expect(binOnPath("dosu")).toBe(false);
  });

  it("returns false when which throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(binOnPath("dosu")).toBe(false);
  });

  it("uses where on Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    mockWhich({ dosu: true });
    expect(binOnPath("dosu")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith("where", ["dosu"], expect.anything());
  });
});

describe("listAvailableKickoffAgents / resolveKickoffAgent", () => {
  it("includes cursor when the IDE binary is present", () => {
    mockWhich({ cursor: true, claude: false, codex: false, agent: false, "cursor-agent": false });
    expect(listAvailableKickoffAgents()).toEqual(["cursor"]);
    expect(resolveKickoffAgent()).toBe("cursor");
  });

  it("prefers configured providers in order", () => {
    mockWhich({ cursor: true, claude: true, codex: true, agent: true });
    expect(resolveKickoffAgent(["codex", "cursor"])).toBe("codex");
    expect(resolveKickoffAgent(["claude"])).toBe("claude");
  });

  it("maps claude-desktop to claude", () => {
    mockWhich({ cursor: true, claude: true, agent: true });
    expect(resolveKickoffAgent(["claude-desktop"])).toBe("claude");
  });

  it("skips unknown preferred ids and falls back", () => {
    mockWhich({ cursor: false, claude: true, codex: false, agent: false, "cursor-agent": false });
    expect(resolveKickoffAgent(["opencode", "claude-desktop"])).toBe("claude");
  });

  it("falls back when preferred agent is unavailable", () => {
    mockWhich({ cursor: true, claude: false, codex: false, agent: false, "cursor-agent": false });
    expect(resolveKickoffAgent(["claude", "cursor"])).toBe("cursor");
  });

  it("returns null when nothing is available", () => {
    mockWhich({});
    expect(resolveKickoffAgent(["cursor"])).toBeNull();
  });
});

describe("cursorAgentBin", () => {
  it("prefers agent over cursor-agent", () => {
    mockWhich({ agent: true, "cursor-agent": true });
    expect(cursorAgentBin()).toBe("agent");
  });

  it("uses cursor-agent when agent is missing", () => {
    mockWhich({ agent: false, "cursor-agent": true });
    expect(cursorAgentBin()).toBe("cursor-agent");
  });

  it("returns null when neither CLI is present", () => {
    mockWhich({ agent: false, "cursor-agent": false });
    expect(cursorAgentBin()).toBeNull();
  });
});

describe("launchKickoffAgent", () => {
  it("launches claude with extra args", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(launchKickoffAgent("claude", "do the thing", { extraArgs: ["--model", "haiku"] })).toBe(
      true,
    );
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      ["--model", "haiku", "do the thing"],
      expect.objectContaining({ stdio: "inherit", shell: false }),
    );
  });

  it("returns false when claude spawn fails", () => {
    mockSpawnSync.mockReturnValue({ error: new Error("not found") });
    expect(launchKickoffAgent("claude", "do the thing")).toBe(false);
  });

  it("launches codex with the prompt", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(launchKickoffAgent("codex", "mine logs")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "codex",
      ["mine logs"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("returns false when codex spawn fails", () => {
    mockSpawnSync.mockReturnValue({ error: new Error("not found") });
    expect(launchKickoffAgent("codex", "mine logs")).toBe(false);
  });

  it("launches the Cursor agent CLI when present", () => {
    mockWhich({ agent: true, cursor: true });
    expect(launchKickoffAgent("cursor", "mine logs")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "agent",
      ["mine logs"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("launches cursor-agent when agent is missing", () => {
    mockWhich({ agent: false, "cursor-agent": true, cursor: true });
    expect(launchKickoffAgent("cursor", "mine logs")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "cursor-agent",
      ["mine logs"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("returns false when Cursor agent spawn fails", () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" || cmd === "where") {
        return { status: args[0] === "agent" ? 0 : 1 };
      }
      return { error: new Error("spawn failed") };
    });
    expect(launchKickoffAgent("cursor", "mine logs")).toBe(false);
  });

  it("does not spawn a new Cursor window when agent CLI is missing", () => {
    mockWhich({ cursor: true, agent: false, "cursor-agent": false });
    const soft = vi.fn();
    expect(launchKickoffAgent("cursor", "paste me", { onCursorSoftLaunch: soft })).toBe(true);
    expect(soft).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("uses shell: true on Windows for interactive launches", () => {
    vi.stubGlobal("process", { ...process, platform: "win32", cwd: process.cwd });
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(launchKickoffAgent("claude", "do the thing")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "claude",
      ["do the thing"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("returns false when no Cursor binary is available", () => {
    mockWhich({});
    expect(launchKickoffAgent("cursor", "mine logs")).toBe(false);
  });
});

describe("kickoffAgentLabel", () => {
  it("returns human labels", () => {
    expect(kickoffAgentLabel("cursor")).toBe("Cursor");
    expect(kickoffAgentLabel("claude")).toBe("Claude Code");
    expect(kickoffAgentLabel("codex")).toBe("Codex");
  });
});
