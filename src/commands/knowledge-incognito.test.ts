/** `dosu knowledge incognito` on a temporary home and PATH: the agents' real command files are
 * written and removed; nothing else is faked. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { incognitoCommand } from "./knowledge-incognito";

let home: string;
let bin: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-knowledge-incognito-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("PATH", bin);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** An executable on the temporary PATH, as a package install leaves it. */
function installBinary(name: string): void {
  writeFileSync(join(bin, name), "#!/bin/sh\n");
  chmodSync(join(bin, name), 0o755);
}

async function run(...args: string[]): Promise<string> {
  logSpy.mockClear();
  const cmd = incognitoCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

const errors = () => errorSpy.mock.calls.join(" ");
const claudeCommand = () => join(home, ".claude", "commands", "dosu-incognito.md");
const codexSkill = () => join(home, ".codex", "skills", "dosu-incognito", "SKILL.md");

describe("knowledge incognito status", () => {
  it("lists every agent with its state, and how each runs the command", async () => {
    installBinary("claude");
    installBinary("codex");
    await run("enable", "claude");

    const said = await run("status");

    expect(said).toMatch(/claude\s+Claude Code\s+enabled/);
    expect(said).toMatch(/codex\s+Codex\s+disabled/);
    expect(said).toMatch(/cursor\s+Cursor\s+not installed/);
    expect(said).toContain("/dosu-incognito");
    expect(said).toContain("$dosu-incognito in Codex");
  });

  it("--json emits rows with the command path and its invocation", async () => {
    installBinary("codex");
    await run("enable", "codex");

    const rows = JSON.parse(await run("status", "--json")) as Record<string, unknown>[];

    expect(rows.find((row) => row.agent === "codex")).toEqual({
      agent: "codex",
      name: "Codex",
      installed: true,
      enabled: true,
      invocation: "$dosu-incognito",
      command_path: codexSkill(),
    });
  });
});

describe("knowledge incognito enable", () => {
  it("installs for named agents, saying how each runs it", async () => {
    const said = await run("enable", "claude", "codex");

    expect(existsSync(claudeCommand())).toBe(true);
    expect(existsSync(codexSkill())).toBe(true);
    expect(said).toContain(`✓ Claude Code · /dosu-incognito installed (${claudeCommand()})`);
    expect(said).toContain(`✓ Codex · $dosu-incognito installed (${codexSkill()})`);
  });

  it("defaults to detected agents and reports already-installed ones", async () => {
    installBinary("claude");
    await run("enable");

    const said = await run("enable");

    expect(said).toContain("Claude Code · /dosu-incognito already installed");
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("rejects unknown agents", async () => {
    await run("enable", "zed");
    expect(errors()).toContain("unknown agent 'zed'");
    expect(process.exitCode).toBe(1);
  });

  it("reports a write failure and goes on to the next agent", async () => {
    // A file where the commands directory should be: the command cannot be written.
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "commands"), "not a directory");

    await run("enable", "claude", "codex");

    expect(errors()).toContain("✗ Claude Code:");
    expect(process.exitCode).toBe(1);
    expect(existsSync(codexSkill())).toBe(true);
  });
});

describe("knowledge incognito disable", () => {
  it("removes for named agents", async () => {
    await run("enable", "claude", "codex");

    const said = await run("disable", "claude", "codex");

    expect(existsSync(claudeCommand())).toBe(false);
    expect(existsSync(codexSkill())).toBe(false);
    expect(said).toContain("Claude Code · /dosu-incognito removed");
    expect(said).toContain("Codex · $dosu-incognito removed");
  });

  it("says so when nothing was installed", async () => {
    installBinary("claude");
    expect(await run("disable")).toContain("/dosu-incognito was not installed");
  });

  it("prints a hint when nothing is detected", async () => {
    expect(await run("disable")).toContain("No supported agents detected");
  });

  it("reports a removal failure and goes on to the next agent", async () => {
    await run("enable", "claude", "codex");
    // A directory where the command file should be: it cannot be unlinked.
    rmSync(claudeCommand());
    mkdirSync(join(claudeCommand(), "x"), { recursive: true });

    await run("disable", "claude", "codex");

    expect(errors()).toContain("✗ Claude Code:");
    expect(process.exitCode).toBe(1);
    expect(existsSync(codexSkill())).toBe(false);
  });
});
