import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
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
      expect.objectContaining({ stdio: "inherit" }),
    );
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

  it("soft-opens Cursor IDE when agent CLI is missing", () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" || cmd === "where") {
        const bin = args[0] ?? "";
        return { status: bin === "cursor" ? 0 : 1 };
      }
      return { status: 0 };
    });
    const soft = vi.fn();
    expect(launchKickoffAgent("cursor", "paste me", { onCursorSoftLaunch: soft })).toBe(true);
    expect(soft).toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "cursor",
      [process.cwd()],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });
});

describe("kickoffAgentLabel", () => {
  it("returns human labels", () => {
    expect(kickoffAgentLabel("cursor")).toBe("Cursor");
    expect(kickoffAgentLabel("claude")).toBe("Claude Code");
    expect(kickoffAgentLabel("codex")).toBe("Codex");
  });
});
