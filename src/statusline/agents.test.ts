import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => fakeHome,
  };
});

import { HookConfigError } from "../hooks/formats";
import {
  allStatuslineAgents,
  getStatuslineAgent,
  isDosuStatuslineCommand,
  StatuslineConflictError,
  statuslineCommand,
} from "./agents";

const ORIG_DOSU_DEV = process.env.DOSU_DEV;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "dosu-statusline-agents-"));
  delete process.env.DOSU_DEV;
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  if (ORIG_DOSU_DEV === undefined) delete process.env.DOSU_DEV;
  else process.env.DOSU_DEV = ORIG_DOSU_DEV;
});

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function agent(id: string) {
  const found = getStatuslineAgent(id);
  if (!found) throw new Error(`missing agent ${id}`);
  return found;
}

describe("statuslineCommand", () => {
  it("is the stable PATH-resolved command outside dev mode", () => {
    expect(statuslineCommand("claude")).toBe("dosu knowledge statusline render --agent claude");
    expect(isDosuStatuslineCommand(statuslineCommand("cursor"))).toBe(true);
  });

  it("pins the working copy behind `env` in dev mode, so a shell-less spawn still works", () => {
    process.env.DOSU_DEV = "true";
    const command = statuslineCommand("cursor");
    expect(command.startsWith("env DOSU_DEV=true ")).toBe(true);
    expect(command).toContain(`'${process.execPath}'`);
    expect(command.endsWith("knowledge statusline render --agent cursor")).toBe(true);
    expect(isDosuStatuslineCommand(command)).toBe(true);
  });

  it("recognizes only our render command", () => {
    expect(isDosuStatuslineCommand("~/.claude/statusline.sh")).toBe(false);
    expect(isDosuStatuslineCommand(undefined)).toBe(false);
  });
});

describe("registry", () => {
  it("covers the two harnesses with a status line", () => {
    expect(allStatuslineAgents().map((a) => a.id())).toEqual(["claude", "cursor"]);
    expect(getStatuslineAgent("codex")).toBeUndefined();
  });

  it("detects the agents from their home dirs", () => {
    expect(agent("cursor").isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".cursor"));
    expect(agent("cursor").isInstalled()).toBe(true);
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = join(fakeHome, "claude-alt");
    expect(agent("claude").configPath()).toBe(join(fakeHome, "claude-alt", "settings.json"));
    expect(agent("cursor").configPath()).toBe(join(fakeHome, ".cursor", "cli-config.json"));
  });
});

describe("enable", () => {
  it("writes statusLine into settings.json, preserving other settings", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const path = join(fakeHome, ".claude", "settings.json");
    writeFileSync(path, JSON.stringify({ theme: "auto" }));

    const claude = agent("claude");
    expect(claude.isEnabled()).toBe(false);
    claude.enable();

    expect(readJSON(path)).toEqual({
      theme: "auto",
      statusLine: { type: "command", command: statuslineCommand("claude") },
    });
    expect(claude.isEnabled()).toBe(true);
  });

  it("creates the Cursor CLI config when absent", () => {
    agent("cursor").enable();
    expect(readJSON(join(fakeHome, ".cursor", "cli-config.json"))).toEqual({
      statusLine: { type: "command", command: statuslineCommand("cursor") },
    });
  });

  it("is idempotent and keeps the user's padding while refreshing a stale Dosu command", () => {
    mkdirSync(join(fakeHome, ".cursor"));
    const path = join(fakeHome, ".cursor", "cli-config.json");
    writeFileSync(
      path,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "env DOSU_DEV=true '/old/bun' knowledge statusline render --agent cursor",
          padding: 2,
        },
      }),
    );

    agent("cursor").enable();
    agent("cursor").enable();

    expect(readJSON(path)).toEqual({
      statusLine: { type: "command", command: statuslineCommand("cursor"), padding: 2 },
    });
  });

  it("refuses to clobber a foreign status line and explains how to chain it", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const path = join(fakeHome, ".claude", "settings.json");
    const before = JSON.stringify({
      statusLine: { type: "command", command: "~/.claude/statusline.sh" },
    });
    writeFileSync(path, before);

    let caught: unknown;
    try {
      agent("claude").enable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StatuslineConflictError);
    const conflict = caught as StatuslineConflictError;
    expect(conflict.existingCommand).toBe("~/.claude/statusline.sh");
    expect(conflict.suggestion).toBe(
      `printf '%s' "$input" | dosu knowledge statusline render --agent claude`,
    );
    expect(conflict.message).toContain("already has a status line");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(agent("claude").isEnabled()).toBe(false);
  });

  it("describes a command-less foreign status line by its JSON", () => {
    mkdirSync(join(fakeHome, ".claude"));
    writeFileSync(
      join(fakeHome, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "mystery" } }),
    );
    expect(() => agent("claude").enable()).toThrow('{"type":"mystery"}');
  });

  it("aborts on an unparseable config rather than rewriting it", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const path = join(fakeHome, ".claude", "settings.json");
    writeFileSync(path, "{broken");
    expect(() => agent("claude").enable()).toThrow(HookConfigError);
    expect(() => agent("claude").isEnabled()).toThrow(HookConfigError);
    expect(readFileSync(path, "utf-8")).toBe("{broken");
  });
});

describe("disable", () => {
  it("removes our status line and reports the change", () => {
    const claude = agent("claude");
    claude.enable();
    expect(claude.disable()).toBe(true);
    expect(readJSON(claude.configPath())).toEqual({});
    expect(claude.isEnabled()).toBe(false);
  });

  it("leaves a foreign status line alone and reports no change", () => {
    mkdirSync(join(fakeHome, ".claude"));
    const path = join(fakeHome, ".claude", "settings.json");
    const before = JSON.stringify({ statusLine: { type: "command", command: "other.sh" } });
    writeFileSync(path, before);
    expect(agent("claude").disable()).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("is a no-op when nothing is configured", () => {
    expect(agent("cursor").disable()).toBe(false);
  });
});
