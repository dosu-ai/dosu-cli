/** `dosu knowledge incognito` on a temporary home, config dir and PATH: the agents' real command
 * files and the real sync state are written; nothing else is faked. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Set to make the sessions on disk unreadable, as a failing scan would. */
const scan = vi.hoisted(() => ({ fails: false }));
vi.mock("../sync/backlog", async (importOriginal) => {
  const original = await importOriginal<typeof import("../sync/backlog")>();
  return {
    ...original,
    scanWindowSessions: (...args: Parameters<typeof original.scanWindowSessions>) => {
      if (scan.fails) throw new Error("EACCES: permission denied");
      return original.scanWindowSessions(...args);
    },
  };
});

import { piHookAgent } from "../hooks/pi";
import { emptySyncState, loadSyncState, saveSyncState } from "../sync/state";
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
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("PATH", bin);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  scan.fails = false;
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI colors before matching output.
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, "");

async function run(...args: string[]): Promise<string> {
  logSpy.mockClear();
  const cmd = incognitoCommand();
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  await cmd.parseAsync(["node", "test", ...args]);
  return stripAnsi(logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
}

const errors = () => errorSpy.mock.calls.join(" ");
const saved = () => loadSyncState().incognito_agents;
const claudeCommand = () => join(home, ".claude", "commands", "dosu-incognito.md");
const codexSkill = () => join(home, ".codex", "skills", "dosu-incognito", "SKILL.md");

describe("knowledge incognito status", () => {
  it("lists every agent with its switch, and how each runs the command", async () => {
    installBinary("claude");
    installBinary("codex");
    await run("on", "claude");

    const said = await run("status");

    expect(said).toMatch(/claude\s+Claude Code\s+👻 incognito \(not shipped\)/);
    expect(said).toMatch(/codex\s+Codex\s+📚 shipped\s+\(\$dosu-incognito missing\)/);
    expect(said).toMatch(/cursor\s+Cursor\s+agent not found/);
    expect(said).toContain("incognito on|off");
    expect(said).toContain("$dosu-incognito in Codex");
  });

  it("--json emits rows with the switch, the command path and its invocation", async () => {
    installBinary("codex");
    await run("on", "codex");

    const rows = JSON.parse(await run("status", "--json")) as Record<string, unknown>[];

    expect(rows.find((row) => row.agent === "codex")).toEqual({
      agent: "codex",
      name: "Codex",
      installed: true,
      incognito: true,
      command_installed: true,
      invocation: "$dosu-incognito",
      command_path: codexSkill(),
    });
  });
});

describe("knowledge incognito on", () => {
  it("saves named agents as incognito and installs their command", async () => {
    const said = await run("on", "claude", "codex");

    expect(saved()).toEqual(["claude", "codex"]);
    expect(existsSync(claudeCommand())).toBe(true);
    expect(existsSync(codexSkill())).toBe(true);
    expect(said).toContain("Claude Code is incognito");
  });

  it("defaults to detected agents", async () => {
    installBinary("claude");
    await run("on");
    expect(saved()).toEqual(["claude"]);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  it("does nothing when no agent is detected", async () => {
    expect(await run("on")).toContain("No supported agents detected");
    expect(saved()).toBeUndefined();
  });

  it("rejects unknown agents and saves nothing", async () => {
    await run("on", "zed");
    expect(errors()).toContain("unknown agent 'zed'");
    expect(process.exitCode).toBe(1);
    expect(saved()).toBeUndefined();
  });

  it("reports a failed save and installs nothing", async () => {
    // A file where the config directory should be: the state cannot be written.
    mkdirSync(join(home, ".config"));
    writeFileSync(join(home, ".config", "dosu-cli"), "not a directory");

    await run("on", "claude");

    expect(errors()).toContain("could not save the setting");
    expect(process.exitCode).toBe(1);
    expect(existsSync(claudeCommand())).toBe(false);
  });

  it("still switches when the command cannot be written", async () => {
    // A file where the commands directory should be: the command cannot be written.
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "commands"), "not a directory");

    const said = await run("on", "claude", "codex");

    expect(saved()).toEqual(["claude", "codex"]);
    expect(errors()).toContain("✗ Claude Code: could not install /dosu-incognito");
    expect(said).toContain("Claude Code is incognito");
    expect(existsSync(codexSkill())).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("no longer accepts the old enable and disable names", async () => {
    await expect(run("enable", "claude")).rejects.toThrow();
    await expect(run("disable", "claude")).rejects.toThrow();
    expect(saved()).toBeUndefined();
  });
});

/** A Claude Code transcript on the temporary home, last written `minutesAgo`. */
function claudeSession(id: string, minutesAgo = 1): string {
  const project = join(home, ".claude", "projects", "-work-app");
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  const at = new Date(Date.now() - minutesAgo * 60 * 1000);
  utimesSync(path, at, at);
  return path;
}

describe("knowledge incognito off", () => {
  it("ships named agents again, keeps their command, and says past sessions stay out", async () => {
    await run("on", "claude", "codex");
    rmSync(claudeCommand());

    const said = await run("off", "claude");

    expect(saved()).toEqual(["codex"]);
    expect(existsSync(claudeCommand())).toBe(true);
    expect(said).toContain("Claude Code sessions ship to Dosu memory again");
    expect(said).toContain("stay off the record");
  });

  it("seals the sessions that ran while incognito, even ones no sync has settled", async () => {
    // Claude Code went in two hours ago.
    saveSyncState({
      ...emptySyncState(),
      incognito_agents: ["claude"],
      incognito_since: { claude: new Date(Date.now() - 120 * 60 * 1000).toISOString() },
    });
    // Still inside the quiet period, so no sync would have settled it yet.
    claudeSession("open-one");
    claudeSession("quiet-one", 60);
    // Quiet since before it went in, and on the record.
    claudeSession("before-on", 180);

    await run("off", "claude");

    expect(saved()).toBeUndefined();
    const ledger = loadSyncState().sessions;
    expect(ledger["claude/open-one"]).toMatchObject({ outcome: "incognito", by_agent: true });
    expect(ledger["claude/quiet-one"]).toMatchObject({ outcome: "incognito", by_agent: true });
    expect(ledger["claude/before-on"]).toBeUndefined();
  });

  it("seals nothing when the agent was not incognito", async () => {
    claudeSession("on-the-record", 60);

    await run("off", "claude");

    expect(loadSyncState().sessions).toEqual({});
  });

  it("keeps the agent incognito when its sessions cannot be read, and says so", async () => {
    await run("on", "claude", "codex");
    scan.fails = true;

    const said = await run("off", "claude", "codex");

    expect(saved()).toEqual(["claude", "codex"]);
    expect(errors()).toContain("could not save the setting; Claude Code, Codex stay incognito");
    expect(errors()).toContain("EACCES");
    expect(said).not.toContain("ship to Dosu memory again");
    expect(process.exitCode).toBe(1);
  });

  it("names only the agents a failure leaves incognito", async () => {
    await run("on", "codex");
    scan.fails = true;

    await run("off", "codex", "claude");

    expect(errors()).toContain("could not save the setting; Codex stays incognito");
    expect(saved()).toEqual(["codex"]);
  });

  it("needs no scan for agents that were not incognito", async () => {
    scan.fails = true;

    expect(await run("off", "claude")).toContain("Claude Code sessions ship to Dosu memory again");
    expect(errors()).toBe("");
  });
});

describe("knowledge incognito for pi", () => {
  const extension = () => join(home, ".pi", "agent", "extensions", "dosu.ts");

  beforeEach(() => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  });

  it("switches pi without installing its extension", async () => {
    const said = await run("on", "pi");

    expect(saved()).toEqual(["pi"]);
    expect(said).toContain("Pi is incognito");
    expect(existsSync(extension())).toBe(false);
    expect(errors()).toBe("");

    await run("off", "pi");
    expect(saved()).toBeUndefined();
    expect(existsSync(extension())).toBe(false);
  });

  it("counts as detected, so the default list switches it too", async () => {
    await run("on");
    expect(saved()).toEqual(["pi"]);
  });

  it("brings the Dosu extension up to date, and never touches a user's own dosu.ts", async () => {
    piHookAgent().enable();
    const current = readFileSync(extension(), "utf-8");
    writeFileSync(extension(), `${current}// stale\n`);

    await run("on", "pi");
    expect(readFileSync(extension(), "utf-8")).toBe(current);

    writeFileSync(extension(), "export default function mine() {}\n");
    await run("off", "pi");
    expect(readFileSync(extension(), "utf-8")).toBe("export default function mine() {}\n");
    expect(errors()).toBe("");
  });

  it("reports its command with the extension, and how to get it", async () => {
    await run("on", "pi");

    let said = await run("status");
    expect(said).toMatch(/pi\s+Pi\s+👻 incognito \(not shipped\)/);
    expect(said).toContain("(/dosu-incognito missing; 'dosu knowledge hooks enable pi' adds it)");

    piHookAgent().enable();
    said = await run("status");
    expect(said).not.toContain("missing");
    const rows = JSON.parse(await run("status", "--json")) as Record<string, unknown>[];
    expect(rows.filter((row) => row.agent === "pi")).toEqual([
      {
        agent: "pi",
        name: "Pi",
        installed: true,
        incognito: true,
        command_installed: true,
        invocation: "/dosu-incognito",
        command_path: extension(),
      },
    ]);
  });
});

describe("knowledge incognito with a state file it cannot read", () => {
  it("keeps the agents a newer schema had incognito", async () => {
    installBinary("claude");
    const dir = join(home, ".config", "dosu-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "knowledge-sync.json"),
      JSON.stringify({ schema_version: 99, incognito_agents: ["claude"] }),
    );

    expect(await run("status")).toMatch(/claude\s+Claude Code\s+👻 incognito/);
    await run("on", "codex");

    expect(saved()).toEqual(["claude", "codex"]);
  });
});
