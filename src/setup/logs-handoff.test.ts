import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
  spawn: mockSpawn,
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(),
  log: {
    message: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import {
  buildLogsHandoffPrompt,
  detectLogSources,
  formatLogSourceSummary,
  launchLogsAgent,
  offerLogsHandoff,
} from "./logs-handoff";

const tempHomes: string[] = [];

function mockWhich(present: Record<string, boolean>): void {
  mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "which" || cmd === "where") {
      const bin = args[0] ?? "";
      return { status: present[bin] ? 0 : 1 };
    }
    return { status: 0 };
  });
}

function makeHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  tempHomes.push(home);
  return home;
}

function seedLogs(home: string): void {
  const cursorDir = join(home, ".cursor", "projects", "demo", "agent-transcripts");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(join(cursorDir, "a.jsonl"), "{}\n");
  writeFileSync(join(cursorDir, "b.jsonl"), "{}\n");

  const claudeDir = join(home, ".claude", "projects", "demo");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "c.jsonl"), "{}\n");

  const codexDir = join(home, ".codex", "sessions", "2026", "08");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, "rollout.jsonl"), "{}\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(p.isCancel).mockReturnValue(false);
  mockSpawn.mockReturnValue({ unref: vi.fn() });
});

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("detectLogSources", () => {
  it("finds cursor, claude, and codex histories", () => {
    const home = makeHome("dosu-logs-");
    seedLogs(home);

    const hits = detectLogSources(home);
    expect(hits.map((h) => h.source)).toEqual(["cursor", "claude", "codex"]);
    expect(hits.find((h) => h.source === "cursor")?.sessionCount).toBe(2);
    expect(hits.find((h) => h.source === "claude")?.sessionCount).toBe(1);
    expect(hits.find((h) => h.source === "codex")?.sessionCount).toBe(1);
  });

  it("returns empty when no histories exist", () => {
    const home = makeHome("dosu-logs-empty-");
    expect(detectLogSources(home)).toEqual([]);
  });

  it("skips cursor projects without transcripts and caps large trees", () => {
    const home = makeHome("dosu-logs-cap-");
    const projects = join(home, ".cursor", "projects");
    mkdirSync(join(projects, "plain-file"), { recursive: true });
    writeFileSync(join(projects, "not-a-dir"), "nope");
    const transcripts = join(projects, "big", "agent-transcripts", "nested");
    mkdirSync(transcripts, { recursive: true });
    for (let i = 0; i < 500; i++) {
      writeFileSync(join(transcripts, `s${i}.jsonl`), "{}\n");
    }
    const hits = detectLogSources(home);
    expect(hits).toEqual([{ source: "cursor", sessionCount: 500, capped: true }]);
  });
});

describe("formatLogSourceSummary", () => {
  it("lists labels and session counts", () => {
    expect(
      formatLogSourceSummary([
        { source: "cursor", sessionCount: 2, capped: false },
        { source: "claude", sessionCount: 500, capped: true },
      ]),
    ).toBe("Cursor (2 sessions), Claude Code (500+ sessions)");
  });
});

describe("buildLogsHandoffPrompt", () => {
  it("is only the skill trigger", () => {
    expect(buildLogsHandoffPrompt()).toBe(
      "Please bootstrap my knowledge with Dosu from my local agent logs.",
    );
  });
});

describe("offerLogsHandoff", () => {
  it("returns null when no log sources are present", async () => {
    const home = makeHome("dosu-logs-none-");
    await expect(offerLogsHandoff({ home })).resolves.toBeNull();
    expect(p.confirm).not.toHaveBeenCalled();
  });

  it("mines all detected sources after a single continue", async () => {
    const home = makeHome("dosu-logs-offer-");
    seedLogs(home);
    mockWhich({ cursor: true, agent: true });
    vi.mocked(p.confirm).mockResolvedValue(true);

    await expect(offerLogsHandoff({ home, preferredAgents: ["cursor"] })).resolves.toEqual({
      agent: "cursor",
      sources: ["cursor", "claude", "codex"],
    });
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining("MCP setup successful! Found logs:"),
    );
    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /We'll hand off to Cursor to mine these into Dosu\..*remain local to your machine/,
        ),
        initialValue: true,
      }),
    );
  });

  it("warns that Cursor CLI is missing before a paste-only continue", async () => {
    const home = makeHome("dosu-logs-soft-");
    seedLogs(home);
    mockWhich({ cursor: true, agent: false, "cursor-agent": false });
    vi.mocked(p.confirm).mockResolvedValue(true);

    await expect(offerLogsHandoff({ home, preferredAgents: ["cursor"] })).resolves.toEqual({
      agent: "cursor",
      sources: ["cursor", "claude", "codex"],
    });
    expect(p.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Cursor CLI isn't on PATH"),
      }),
    );
  });

  it("prints a nudge when the user declines", async () => {
    const home = makeHome("dosu-logs-decline-");
    seedLogs(home);
    mockWhich({ claude: true });
    vi.mocked(p.confirm).mockResolvedValue(false);

    await expect(offerLogsHandoff({ home, preferredAgents: ["claude"] })).resolves.toBeNull();
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("bootstrap my knowledge"));
  });

  it("prints a nudge when the user cancels the continue prompt", async () => {
    const home = makeHome("dosu-logs-cancel-");
    seedLogs(home);
    mockWhich({ claude: true });
    vi.mocked(p.confirm).mockResolvedValue(true);
    vi.mocked(p.isCancel).mockReturnValue(true);

    await expect(offerLogsHandoff({ home, preferredAgents: ["claude"] })).resolves.toBeNull();
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("bootstrap my knowledge"));
  });

  it("prints a nudge when no kickoff agent is available", async () => {
    const home = makeHome("dosu-logs-noagent-");
    seedLogs(home);
    mockWhich({});

    await expect(offerLogsHandoff({ home })).resolves.toBeNull();
    expect(p.confirm).not.toHaveBeenCalled();
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("bootstrap my knowledge"));
  });
});

describe("launchLogsAgent", () => {
  it("hands off to the chosen agent with the scoped prompt", () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" || cmd === "where") {
        const bin = args[0] ?? "";
        return { status: bin === "agent" || bin === "cursor" ? 0 : 1 };
      }
      return { status: 0 };
    });

    launchLogsAgent({ agent: "cursor", sources: ["cursor", "claude"] });

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "agent",
      [buildLogsHandoffPrompt()],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("prints a nudge when launch fails", () => {
    mockWhich({});
    launchLogsAgent({ agent: "cursor", sources: ["cursor"] });
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("bootstrap my knowledge"));
  });

  it("prints the paste prompt without opening a new Cursor window", () => {
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "which" || cmd === "where") {
        const bin = args[0] ?? "";
        return { status: bin === "cursor" ? 0 : 1 };
      }
      return { status: 0 };
    });
    launchLogsAgent({ agent: "cursor", sources: ["claude"] });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("mining does not start on its own"),
    );
    expect(p.log.warn).toHaveBeenCalledWith(expect.not.stringContaining("Opened Cursor"));
    expect(p.log.message).toHaveBeenCalledWith(expect.stringContaining("bootstrap my knowledge"));
  });
});
