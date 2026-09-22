import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

import { INCOGNITO_MARKER, textHasIncognitoMarker } from "../sync/incognito";
import { allIncognitoAgents, getIncognitoAgent, INCOGNITO_COMMAND_BODY } from "./agents";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "dosu-incognito-agents-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("registry", () => {
  it("exposes claude, cursor, and codex", () => {
    expect(allIncognitoAgents().map((a) => a.id())).toEqual(["claude", "cursor", "codex"]);
    expect(getIncognitoAgent("cursor")?.name()).toBe("Cursor");
    expect(getIncognitoAgent("zed")).toBeUndefined();
  });

  it("reports installation from the agent's home dir", () => {
    expect(getIncognitoAgent("claude")?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".claude"));
    expect(getIncognitoAgent("claude")?.isInstalled()).toBe(true);
  });

  it("the command body carries the marker the sync filter looks for", () => {
    expect(textHasIncognitoMarker(INCOGNITO_COMMAND_BODY)).toBe(true);
  });
});

describe("claude agent", () => {
  it("writes a frontmatter command file under ~/.claude/commands", () => {
    const agent = getIncognitoAgent("claude");
    if (!agent) throw new Error("missing agent");
    expect(agent.isEnabled()).toBe(false);

    expect(agent.enable()).toBe("created");

    const path = join(fakeHome, ".claude", "commands", "dosu-incognito.md");
    expect(agent.commandPath()).toBe(path);
    const content = readFileSync(path, "utf-8");
    expect(content.startsWith("---\ndescription: ")).toBe(true);
    expect(content).toContain(INCOGNITO_MARKER);
    expect(content).toContain("Do not call any Dosu MCP tools");
    expect(agent.isEnabled()).toBe(true);
  });

  it("is idempotent and refreshes a stale file", () => {
    const agent = getIncognitoAgent("claude");
    if (!agent) throw new Error("missing agent");
    agent.enable();
    expect(agent.enable()).toBe("unchanged");

    writeFileSync(agent.commandPath(), "old body without the token\n");
    expect(agent.isEnabled()).toBe(false);
    expect(agent.enable()).toBe("updated");
    expect(agent.isEnabled()).toBe(true);
  });

  it("reads an unreadable command path as disabled", () => {
    const agent = getIncognitoAgent("claude");
    if (!agent) throw new Error("missing agent");
    mkdirSync(agent.commandPath(), { recursive: true }); // a directory, not a file
    expect(agent.isEnabled()).toBe(false);
  });

  it("removes the file on disable and reports a missing one", () => {
    const agent = getIncognitoAgent("claude");
    if (!agent) throw new Error("missing agent");
    expect(agent.disable()).toBe("not_found");
    agent.enable();
    expect(agent.disable()).toBe("removed");
    expect(existsSync(agent.commandPath())).toBe(false);
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    process.env.CLAUDE_CONFIG_DIR = join(fakeHome, "claude-alt");
    const agent = getIncognitoAgent("claude");
    expect(agent?.commandPath()).toBe(
      join(fakeHome, "claude-alt", "commands", "dosu-incognito.md"),
    );
  });
});

describe("cursor agent", () => {
  it("detects Cursor from ~/.cursor", () => {
    expect(getIncognitoAgent("cursor")?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".cursor"));
    expect(getIncognitoAgent("cursor")?.isInstalled()).toBe(true);
  });

  it("writes plain markdown under ~/.cursor/commands", () => {
    const agent = getIncognitoAgent("cursor");
    if (!agent) throw new Error("missing agent");
    agent.enable();
    const content = readFileSync(
      join(fakeHome, ".cursor", "commands", "dosu-incognito.md"),
      "utf-8",
    );
    expect(content.startsWith("---")).toBe(false);
    expect(content).toBe(INCOGNITO_COMMAND_BODY);
  });
});

describe("codex agent", () => {
  it("writes to $CODEX_HOME/prompts", () => {
    process.env.CODEX_HOME = join(fakeHome, "codex-home");
    const agent = getIncognitoAgent("codex");
    if (!agent) throw new Error("missing agent");
    agent.enable();
    const path = join(fakeHome, "codex-home", "prompts", "dosu-incognito.md");
    expect(agent.commandPath()).toBe(path);
    expect(readFileSync(path, "utf-8")).toContain(INCOGNITO_MARKER);
  });

  it("defaults to ~/.codex", () => {
    expect(getIncognitoAgent("codex")?.commandPath()).toBe(
      join(fakeHome, ".codex", "prompts", "dosu-incognito.md"),
    );
  });
});
