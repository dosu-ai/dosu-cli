/** Installing Dosu's Codex hooks on a fresh machine, the way a throwaway VM is provisioned: `codex`
 * is installed but has never run, so there is no ~/.codex yet. A temporary home and PATH stand in
 * for the machine, and a script answers `codex --version`; nothing else is faked. */

import {
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
let out: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-hooks-codex-")));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), '#!/bin/sh\necho "codex-cli 0.160.0"\n', { mode: 0o755 });
  writeFileSync(join(bin, "dosu"), "#!/bin/sh\n", { mode: 0o755 });
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

async function dosu(...args: string[]): Promise<string> {
  out.mockClear();
  const cmd = knowledgeCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "dosu", ...args]);
  return out.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

const skill = () => join(home, ".codex", "skills", "dosu-incognito", "SKILL.md");

describe("Codex installed but never run (no ~/.codex)", () => {
  it("hooks enable installs the hooks and the $dosu-incognito skill, and says how to run it", async () => {
    const said = await dosu("hooks", "enable", "codex");

    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(skill(), "utf-8")).toContain("dosu:incognito:v1");
    expect(said).toContain("Codex · hook enabled");
    expect(said).toContain("Run $dosu-incognito in a session to keep it out of Dosu memory.");
  });

  it("transcripts enable then names $dosu-incognito for Codex, not /dosu-incognito", async () => {
    await dosu("hooks", "enable", "codex");

    const said = await dosu("transcripts", "enable");

    expect(said).toContain("Use $dosu-incognito (Codex) in a session to keep it out.");
    expect(said).not.toContain("/dosu-incognito");
  });

  it("hooks status says when the skill is missing, until hooks enable adds it", async () => {
    await dosu("hooks", "enable", "codex");
    rmSync(skill());
    const codexRow = async () =>
      (JSON.parse(await dosu("hooks", "status", "--json")) as { agent: string }[]).find(
        (row) => row.agent === "codex",
      );

    expect(await codexRow()).toMatchObject({
      enabled: true,
      note: "$dosu-incognito is missing; 'dosu knowledge hooks enable codex' adds it.",
    });

    await dosu("hooks", "enable", "codex");
    expect(await codexRow()).not.toHaveProperty("note");
  });

  it("hooks disable removes the hooks and the skill, and nothing of Codex's own", async () => {
    await dosu("hooks", "enable", "codex");
    // What Codex's first run adds: its bundled skills.
    mkdirSync(join(home, ".codex", "skills", ".system"), { recursive: true });

    await dosu("hooks", "disable", "codex");

    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".codex", "skills", "dosu-incognito"))).toBe(false);
    expect(existsSync(join(home, ".codex", "skills", ".system"))).toBe(true);
  });
});
