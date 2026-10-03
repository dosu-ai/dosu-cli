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

import { piHookAgent } from "../hooks/pi";
import { INCOGNITO_MARKER, textHasIncognitoMarker } from "../sync/incognito";
import {
  allIncognitoAgents,
  getIncognitoAgent,
  INCOGNITO_COMMAND_BODY,
  installedIncognitoCommands,
} from "./agents";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "dosu-incognito-agents-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
});

describe("registry", () => {
  it("exposes claude, cursor, codex, and opencode", () => {
    expect(allIncognitoAgents().map((a) => a.id())).toEqual([
      "claude",
      "cursor",
      "codex",
      "opencode",
    ]);
    expect(getIncognitoAgent("cursor")?.name()).toBe("Cursor");
    expect(getIncognitoAgent("zed")).toBeUndefined();
  });

  it("reports installation from the agent's home dir", () => {
    vi.stubEnv("PATH", "");
    expect(getIncognitoAgent("claude")?.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".claude"));
    expect(getIncognitoAgent("claude")?.isInstalled()).toBe(true);
  });

  it("reports Claude Code installed from `claude` on PATH before its first run", () => {
    const bin = join(fakeHome, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    expect(getIncognitoAgent("claude")?.isInstalled()).toBe(true);
    expect(getIncognitoAgent("cursor")?.isInstalled()).toBe(false);
  });

  it("names how each agent runs the command: Codex's is a skill mention", () => {
    expect(Object.fromEntries(allIncognitoAgents().map((a) => [a.id(), a.invocation()]))).toEqual({
      claude: "/dosu-incognito",
      cursor: "/dosu-incognito",
      codex: "$dosu-incognito",
      opencode: "/dosu-incognito",
    });
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

  it("keeps the command out of the model's own choosing: only the user runs it", () => {
    getIncognitoAgent("claude")?.enable();
    // Claude Code offers every other command to the model through its Skill tool, and a session
    // whose model ran this one would carry the marker the user never set.
    const content = readFileSync(
      join(fakeHome, ".claude", "commands", "dosu-incognito.md"),
      "utf-8",
    );
    const frontmatter = content.split("\n---\n")[0];
    expect(frontmatter).toContain("\ndisable-model-invocation: true");
    // The user still sees what it does in the / menu.
    expect(frontmatter).toContain("\ndescription: Turn Dosu off for this session");
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
  // Codex 0.140 and 0.160 load no custom prompts or user slash commands: what a user can invoke
  // is a skill, as `$dosu-incognito`, and Codex hands the model the skill's text as a user turn.
  const skillPath = (codexHome: string) => join(codexHome, "skills", "dosu-incognito", "SKILL.md");

  it("installs a $dosu-incognito skill under $CODEX_HOME/skills", () => {
    process.env.CODEX_HOME = join(fakeHome, "codex-home");
    const agent = getIncognitoAgent("codex");
    if (!agent) throw new Error("missing agent");
    expect(agent.invocation()).toBe("$dosu-incognito");
    expect(agent.isEnabled()).toBe(false);

    expect(agent.enable()).toBe("created");

    const path = skillPath(join(fakeHome, "codex-home"));
    expect(agent.commandPath()).toBe(path);
    const content = readFileSync(path, "utf-8");
    // Codex parses frontmatter as strict YAML: the description's colon must be quoted.
    expect(content).toMatch(/^---\nname: dosu-incognito\ndescription: "[^"\n]+"\n---\n/);
    expect(textHasIncognitoMarker(content)).toBe(true);
    expect(agent.isEnabled()).toBe(true);
    expect(agent.enable()).toBe("unchanged");
  });

  it("keeps the skill out of the model's own choosing: only the user invokes it", () => {
    const agent = getIncognitoAgent("codex");
    agent?.enable();
    // An implicitly invocable skill is listed to the model, which could open it and carry the
    // marker into a session the user never took off the record.
    const metadata = join(fakeHome, ".codex", "skills", "dosu-incognito", "agents", "openai.yaml");
    expect(readFileSync(metadata, "utf-8")).toContain("allow_implicit_invocation: false");
  });

  it("replaces the custom prompt an older CLI installed, which no current Codex loads", () => {
    const prompts = join(fakeHome, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "dosu-incognito.md"), `---\n---\n\n${INCOGNITO_COMMAND_BODY}`);

    expect(getIncognitoAgent("codex")?.enable()).toBe("created");

    expect(existsSync(prompts)).toBe(false);
  });

  it("leaves the user's own prompts alone", () => {
    const prompts = join(fakeHome, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "dosu-incognito.md"), "my own prompt\n");
    writeFileSync(join(prompts, "review.md"), "review this\n");
    const agent = getIncognitoAgent("codex");

    agent?.enable();
    agent?.disable();

    expect(readFileSync(join(prompts, "dosu-incognito.md"), "utf-8")).toBe("my own prompt\n");
    expect(existsSync(join(prompts, "review.md"))).toBe(true);
  });

  it("disable removes the skill and nothing of Codex's own", () => {
    // Codex keeps its bundled skills in the same directory.
    const system = join(fakeHome, ".codex", "skills", ".system");
    mkdirSync(system, { recursive: true });
    const agent = getIncognitoAgent("codex");
    if (!agent) throw new Error("missing agent");
    expect(agent.disable()).toBe("not_found");
    agent.enable();

    expect(agent.disable()).toBe("removed");

    expect(existsSync(join(fakeHome, ".codex", "skills", "dosu-incognito"))).toBe(false);
    expect(existsSync(system)).toBe(true);
    expect(agent.isEnabled()).toBe(false);
  });

  it("disable leaves none of the directories enable made behind", () => {
    const agent = getIncognitoAgent("codex");
    agent?.enable();
    agent?.disable();
    expect(existsSync(join(fakeHome, ".codex", "skills"))).toBe(false);
  });

  it("defaults to ~/.codex", () => {
    expect(getIncognitoAgent("codex")?.commandPath()).toBe(skillPath(join(fakeHome, ".codex")));
  });
});

describe("opencode agent", () => {
  it("writes a custom command under opencode's config dir and detects OpenCode from it", () => {
    const agent = getIncognitoAgent("opencode");
    if (!agent) throw new Error("missing agent");
    expect(agent.isInstalled()).toBe(false);
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
    expect(agent.isInstalled()).toBe(true);

    expect(agent.enable()).toBe("created");

    const path = join(fakeHome, ".config", "opencode", "command", "dosu-incognito.md");
    expect(agent.commandPath()).toBe(path);
    const content = readFileSync(path, "utf-8");
    // opencode reads a command's description from frontmatter and sends the rest as the prompt.
    expect(content.startsWith("---\ndescription: ")).toBe(true);
    expect(textHasIncognitoMarker(content)).toBe(true);
    expect(agent.isEnabled()).toBe(true);
  });

  it("follows XDG_CONFIG_HOME, as opencode does", () => {
    process.env.XDG_CONFIG_HOME = join(fakeHome, "xdg");
    expect(getIncognitoAgent("opencode")?.commandPath()).toBe(
      join(fakeHome, "xdg", "opencode", "command", "dosu-incognito.md"),
    );
  });
});

describe("installedIncognitoCommands", () => {
  it("names only the agents that have the command, by how each runs it", () => {
    expect(installedIncognitoCommands()).toBeNull();

    getIncognitoAgent("codex")?.enable();
    expect(installedIncognitoCommands()).toBe("$dosu-incognito (Codex)");

    getIncognitoAgent("claude")?.enable();
    // Pi's comes with the Dosu pi extension.
    piHookAgent().enable();
    expect(installedIncognitoCommands()).toBe(
      "/dosu-incognito (Claude Code, Pi) or $dosu-incognito (Codex)",
    );
  });
});
