/** What `dosu knowledge transcripts enable` says about prompt-time memory, per agent on the
 * machine: Claude Code's hook is installed by the command itself, Codex's comes with its hooks,
 * and OpenCode's plugin and pi's extension carry their own. A temporary home and PATH stand in for
 * the machine; nothing else is faked. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeCommand } from "./knowledge";

let home: string;
let bin: string;
let out: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-transcripts-enable-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  installBinary("dosu");
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("CODEX_HOME", undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
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

function installBinary(name: string, body = "#!/bin/sh\n"): void {
  writeFileSync(join(bin, name), body, { mode: 0o755 });
}

async function dosu(...args: string[]): Promise<string> {
  out.mockClear();
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
  return out.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

describe.each([
  { id: "opencode", name: "OpenCode", binary: "opencode" },
  { id: "pi", name: "Pi", binary: "pi" },
])("only $name on the machine", ({ id, name, binary }) => {
  beforeEach(() => installBinary(binary));

  it("says its prompts get memory once its Dosu hooks are on, and does not mention Claude Code", async () => {
    await dosu("hooks", "enable", id);

    const said = await dosu("transcripts", "enable");

    expect(said).toContain(`✓ ${name} will receive task memory when a prompt warrants it.`);
    expect(said).not.toContain("Claude Code");
    expect(said).not.toContain("not installed");
  });

  it("says how to add prompt-time memory before its Dosu hooks are on", async () => {
    const said = await dosu("transcripts", "enable");

    expect(said).toContain(
      `! Prompt-time memory not installed for ${name}: 'dosu knowledge hooks enable ${id}' adds it.`,
    );
    expect(said).not.toContain("Claude Code");
  });
});

describe("only Codex on the machine", () => {
  beforeEach(() => installBinary("codex", '#!/bin/sh\necho "codex-cli 0.160.0"\n'));

  it("says its prompts get memory once its hooks are on", async () => {
    await dosu("hooks", "enable", "codex");

    const said = await dosu("transcripts", "enable");

    expect(said).toContain("✓ Codex will receive task memory when a prompt warrants it.");
    expect(said).not.toContain("Claude Code");
  });

  it("does not claim memory for a Codex too old for the prompt hook", async () => {
    installBinary("codex", '#!/bin/sh\necho "codex-cli 0.100.0"\n');
    await dosu("hooks", "enable", "codex");

    const said = await dosu("transcripts", "enable");

    expect(said).toContain("! Prompt-time memory not installed for Codex");
  });
});

describe("Claude Code and pi on the machine", () => {
  beforeEach(() => {
    installBinary("claude");
    installBinary("pi");
  });

  it("reports each agent on its own line", async () => {
    await dosu("hooks", "enable", "pi");

    const said = await dosu("transcripts", "enable");

    expect(said).toContain("✓ Claude Code will receive task memory when a prompt warrants it.");
    expect(said).toContain("✓ Pi will receive task memory when a prompt warrants it.");
  });
});

describe("no agent with prompt-time memory on the machine", () => {
  it("warns that none was found, naming the ones that would get it", async () => {
    const said = await dosu("transcripts", "enable");

    expect(said).toContain(
      "! Prompt-time memory not installed: no agent that supports it was found (Claude Code, Codex, OpenCode, Pi). Once one is installed, run 'dosu knowledge hooks enable <agent>'.",
    );
  });
});
