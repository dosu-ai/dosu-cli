/** Installing Dosu's Claude Code hooks on a fresh machine, the way a throwaway VM is provisioned:
 * `claude` is installed but has never run, so there is no ~/.claude yet. A temporary home and
 * PATH stand in for the machine; nothing else is faked. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeCommand } from "./knowledge";

let home: string;
let bin: string;
let out: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-hooks-claude-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("DOSU_DEV", undefined);
  vi.stubEnv("PATH", bin);
  out = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  out.mockRestore();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** An executable on the temporary PATH, as a package install leaves it. */
function installBinary(name: string): void {
  const path = join(bin, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

const incognitoCommand = () => join(home, ".claude", "commands", "dosu-incognito.md");

async function dosu(...args: string[]): Promise<string> {
  out.mockClear();
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
  return out.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

/** Every hook command installed for each Claude Code event. */
function claudeHooks(): Record<string, string[]> {
  const path = join(home, ".claude", "settings.json");
  if (!existsSync(path)) return {};
  const { hooks = {} } = JSON.parse(readFileSync(path, "utf-8")) as {
    hooks?: Record<string, { hooks: { command: string }[] }[]>;
  };
  return Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [
      event,
      groups.flatMap((g) => g.hooks.map((h) => h.command)),
    ]),
  );
}

describe("Claude Code installed but never run (no ~/.claude)", () => {
  beforeEach(() => {
    installBinary("claude");
    installBinary("dosu");
  });

  it("hooks enable installs the session-end and prompt-time hooks, and /dosu-incognito", async () => {
    const said = await dosu("hooks", "enable");

    expect(claudeHooks()).toEqual({
      SessionEnd: ["dosu knowledge sync --quiet --detach"],
      UserPromptSubmit: ["dosu knowledge context"],
      PreToolUse: ["dosu knowledge context"],
    });
    // The user's one opt-out, there before the first session needs it.
    expect(readFileSync(incognitoCommand(), "utf-8")).toContain("dosu:incognito:v1");
    expect(said).toContain("Claude Code · hook enabled");
    expect(said).toContain("Run /dosu-incognito in a session to keep it out of Dosu memory.");
    // Every agent not found is named, never passed over in silence.
    expect(said).toMatch(/Skipped Cursor, Codex(, [^:]+)?: not detected on this machine/);
  });

  it("transcripts enable installs the prompt-time hook", async () => {
    const said = await dosu("transcripts", "enable");

    expect(claudeHooks()).toEqual({
      UserPromptSubmit: ["dosu knowledge context"],
      PreToolUse: ["dosu knowledge context"],
    });
    expect(said).toContain("Claude Code will receive task memory");
  });

  it("transcripts enable names /dosu-incognito only once it is installed", async () => {
    // Before the hooks: no command exists yet, so none is offered, only where it comes from.
    const before = await dosu("transcripts", "enable");
    expect(before).not.toContain("/dosu-incognito");
    expect(before).toContain("dosu knowledge hooks enable");

    // The PoC recipe: hooks, then transcripts.
    await dosu("hooks", "enable", "claude");
    const after = await dosu("transcripts", "enable");
    expect(after).toContain("Use /dosu-incognito (Claude Code) in a session to keep it out.");
  });

  it("works in either order, and hooks status shows Claude Code installed", async () => {
    await dosu("transcripts", "enable");
    await dosu("hooks", "enable");

    expect(claudeHooks()).toEqual({
      SessionEnd: ["dosu knowledge sync --quiet --detach"],
      UserPromptSubmit: ["dosu knowledge context"],
      PreToolUse: ["dosu knowledge context"],
    });
    const status = JSON.parse(await dosu("hooks", "status", "--json")) as {
      agent: string;
      installed: boolean;
      enabled: boolean;
    }[];
    expect(status.find((row) => row.agent === "claude")).toMatchObject({
      installed: true,
      enabled: true,
    });
  });

  it("incognito enable and statusline enable set Claude Code up too", async () => {
    await dosu("incognito", "enable");
    await dosu("statusline", "enable");

    expect(existsSync(incognitoCommand())).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings.statusLine.command).toBe("dosu knowledge statusline render --agent claude");
  });

  it("hooks status says when the prompt-time hook is missing, until hooks enable adds it", async () => {
    // As an older CLI left it: the session-end hook only.
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionEnd: [
            { hooks: [{ type: "command", command: "dosu knowledge sync --quiet --detach" }] },
          ],
        },
      }),
    );
    const claudeRow = async () =>
      (JSON.parse(await dosu("hooks", "status", "--json")) as { agent: string }[]).find(
        (row) => row.agent === "claude",
      );

    expect(await claudeRow()).toMatchObject({
      enabled: true,
      note: expect.stringContaining("Memory hooks (UserPromptSubmit, PreToolUse) are missing"),
    });
    expect(await dosu("hooks", "status")).toContain("dosu knowledge hooks enable claude");

    await dosu("hooks", "enable", "claude");
    expect(await claudeRow()).not.toHaveProperty("note");
  });

  it("hooks status says when /dosu-incognito is missing, until hooks enable adds it", async () => {
    // As an older CLI left it: both hooks, but no command.
    await dosu("hooks", "enable", "claude");
    rmSync(incognitoCommand());
    const claudeRow = async () =>
      (JSON.parse(await dosu("hooks", "status", "--json")) as { agent: string }[]).find(
        (row) => row.agent === "claude",
      );

    expect(await claudeRow()).toMatchObject({
      enabled: true,
      note: "/dosu-incognito is missing; 'dosu knowledge hooks enable claude' adds it.",
    });

    await dosu("hooks", "enable", "claude");
    expect(await claudeRow()).not.toHaveProperty("note");
  });

  it("hooks disable removes both hooks and nothing else of the user's", async () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-linter" }] }] },
      }),
    );
    await dosu("hooks", "enable", "claude");

    await dosu("hooks", "disable", "claude");

    expect(claudeHooks()).toEqual({ UserPromptSubmit: ["my-linter"] });
  });

  it("hooks disable keeps /dosu-incognito while transcript shipping is on, and says why", async () => {
    // Any sync still ships Claude Code's sessions: another agent's hook, or a --flush.
    await dosu("hooks", "enable", "claude", "codex");

    const said = await dosu("hooks", "disable", "claude");

    expect(claudeHooks()).toEqual({});
    expect(readFileSync(incognitoCommand(), "utf-8")).toContain("dosu:incognito:v1");
    expect(said).toContain(
      "Kept /dosu-incognito: Claude Code sessions still ship with any 'dosu knowledge sync' while transcript shipping is on. 'dosu knowledge incognito disable claude' removes it.",
    );
  });

  it("hooks disable removes /dosu-incognito with the hooks once transcript shipping is off", async () => {
    await dosu("hooks", "enable", "claude");
    await dosu("transcripts", "disable");

    const said = await dosu("hooks", "disable", "claude");

    expect(existsSync(incognitoCommand())).toBe(false);
    expect(said).not.toContain("Kept");
  });

  it("hooks enable says so when shipping is off and leaves prompt-time memory out", async () => {
    await dosu("transcripts", "disable");

    const said = await dosu("hooks", "enable", "claude");

    expect(claudeHooks()).toEqual({ SessionEnd: ["dosu knowledge sync --quiet --detach"] });
    expect(said).toContain("Prompt-time memory stays off while transcript shipping is disabled");
  });
});

describe("Claude Code not on this machine at all", () => {
  it("hooks enable installs nothing and says which agents it skipped", async () => {
    const said = await dosu("hooks", "enable");

    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(said).toMatch(
      /Skipped Claude Code, Cursor, Codex(, [^:]+)?: not detected on this machine/,
    );
    expect(said).toContain("dosu knowledge hooks enable <agent>");
  });

  it("transcripts enable warns that prompt-time memory was not installed", async () => {
    const said = await dosu("transcripts", "enable");

    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(said).toContain("Prompt-time memory not installed: Claude Code was not found");
  });
});
