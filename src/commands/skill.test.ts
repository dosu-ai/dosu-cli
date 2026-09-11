import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TRPCClientError } from "@trpc/client";
import pc from "picocolors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
const mockExec = vi.fn();
vi.mock("node:child_process", () => ({
  exec: (...args: unknown[]) => mockExec(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockQuery = vi.fn();
const mockMutate = vi.fn();

function createMockProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
      if (prop === "mutate") return (input: unknown) => mockMutate(path.join("."), input);
      return createMockProxy([...path, prop]);
    },
  });
}

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn().mockImplementation(() => createMockProxy()),
}));

// Only `loadConfig` is faked: `skill-update-check` still needs the real
// `getConfigDir` so the install/update cache tests keep writing under XDG.
const mockLoadConfig = vi.fn();
vi.mock("../config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config")>()),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Wrap (not replace) `skillPathsFor` so one test can make the containment
// check fire; every other export stays real and hits a temp directory.
vi.mock("../skills/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/store")>();
  return { ...actual, skillPathsFor: vi.fn(actual.skillPathsFor) };
});

import { makeTestConfig } from "../config/config.test-utils";
import { CONFIG_SCHEMA_VERSION } from "../config/schema";
import { defaultSkillDescription, parseMarker, renderSkillMarkdown } from "../skills/binding";
import { skillPathsFor } from "../skills/store";
import { type LinkMarker, SKILL_LINK_TEMPLATE_VERSION } from "../skills/types";
import { VERSION } from "../version/version";
import {
  installSkill,
  skillAgentIDsForProviders,
  skillCommand,
  skillInstallTargetForProvider,
} from "./skill";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

let tempDir: string;
let origXDG: string | undefined;

function allOutput(): string {
  return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

function allErrors(): string {
  return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = skillCommand();
  // Commander copies exitOverride into subcommands only at creation time, so
  // usage errors raised inside `skill <sub>` need it applied per subcommand.
  for (const command of [cmd, ...cmd.commands]) {
    command.exitOverride();
    command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  }
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null) => void;
    callback(null);
  });
  mockExecSync.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);

  // Isolate cache writes to a temp dir so they don't pollute $HOME
  origXDG = process.env.XDG_CONFIG_HOME;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-skill-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;

  // Default: fetch returns a SHA
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "test-sha" }),
    }),
  );
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();

  if (origXDG !== undefined) {
    process.env.XDG_CONFIG_HOME = origXDG;
  } else {
    delete process.env.XDG_CONFIG_HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("skill install", () => {
  it("runs npx skills add with correct args", async () => {
    await run("install");
    expect(mockExecSync).toHaveBeenCalledWith(
      [
        "npx skills add dosu-ai/dosu-skill -g",
        "-a claude-code -a cursor -a gemini-cli -a codex -a windsurf",
        "-a zed -a cline -a github-copilot -a opencode -a antigravity",
        '-s "*" -y',
      ].join(" "),
      {
        stdio: "inherit",
      },
    );
  });

  it("does not let skills auto-target PromptScript", async () => {
    await run("install");
    const command = String(mockExecSync.mock.calls[0][0]);
    expect(command).toContain("-a claude-code");
    expect(command).not.toContain("promptscript");
  });

  it("prints success message", async () => {
    await run("install");
    expect(allOutput()).toContain("installed successfully");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("install")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to install skill");
  });
});

describe("skill remove", () => {
  /** Make `npx skills list -g --json` resolve to the given inventory. */
  function stubInventory(entries: unknown[]): void {
    mockExecSync.mockImplementation((command: string) =>
      command.includes("skills list") ? JSON.stringify(entries) : undefined,
    );
  }

  it("removes every skill installed from the Dosu repo", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "dosu-review", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu dosu-review -y", {
      stdio: "inherit",
    });
  });

  it("leaves skills from other sources alone", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "web-design", source: "vercel-labs/agent-skills" },
      { name: "local-skill", source: null },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("skips names that are unsafe to interpolate into a shell command", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "evil; rm -rf /", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  // `skills list` echoes the front-matter name without validating it, and
  // `skills remove --all` deletes every skill from every source.
  it("skips flag-shaped names so they cannot be re-parsed as options", async () => {
    stubInventory([
      { name: "dosu", source: "dosu-ai/dosu-skill" },
      { name: "--all", source: "dosu-ai/dosu-skill" },
    ]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("does nothing when the inventory holds no skills of ours", async () => {
    stubInventory([{ name: "web-design", source: "vercel-labs/agent-skills" }]);
    await run("remove");
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("skills remove"),
      expect.anything(),
    );
    expect(allOutput()).toContain("No skills from dosu-ai/dosu-skill are installed");
  });

  it("stops the update notice by forgetting the installed SHA", async () => {
    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ lastCheck: 1, latestSha: "new-sha", installedSha: "old-sha" }),
    );

    stubInventory([{ name: "dosu", source: "dosu-ai/dosu-skill" }]);
    await run("remove");

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("");
    expect(cache.latestSha).toBe("new-sha");
  });

  it("treats a non-array inventory as unreadable", async () => {
    stubInventory({ unexpected: "shape" } as unknown as unknown[]);
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("falls back to the known skill when the inventory is unreadable", async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes("skills list")) throw new Error("npx unavailable");
      return undefined;
    });
    await run("remove");
    expect(mockExecSync).toHaveBeenCalledWith("npx skills remove -g dosu -y", {
      stdio: "inherit",
    });
  });

  it("prints success message", async () => {
    await run("remove");
    expect(allOutput()).toContain("removed");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("remove")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to remove skill");
  });
});

describe("skill update", () => {
  it("reinstalls via npx skills add (update can't follow repo-layout moves)", async () => {
    await run("update");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("npx skills add dosu-ai/dosu-skill -g"),
      { stdio: "inherit" },
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("npx skills update"),
      expect.anything(),
    );
  });

  it("prints success message", async () => {
    await run("update");
    expect(allOutput()).toContain("updated");
  });

  it("exits with error when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    await expect(run("update")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Failed to update skill");
  });

  it("refreshes installedSha in cache after successful update", async () => {
    await run("update");

    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("test-sha");
    expect(cache.latestSha).toBe("test-sha");
  });

  it("does not write cache when fetch fails during refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await run("update");
    // npx command still succeeded, we just didn't learn a SHA
    expect(allOutput()).toContain("updated");
  });
});

describe("installSkill helper", () => {
  it("installs only for the selected MCP providers", async () => {
    const result = await installSkill(["claude", "codex"]);

    expect(result.success).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'npx skills add dosu-ai/dosu-skill -g -a claude-code -a codex -s "*" -y',
      { stdio: "inherit" },
    );
  });

  it("maps provider aliases and de-duplicates shared skill agents", () => {
    expect(
      skillAgentIDsForProviders(["vscode", "copilot", "cline", "cline-cli", "manual"]),
    ).toEqual(["github-copilot", "cline"]);
  });

  it("reports the Claude symlink target and respects CLAUDE_CONFIG_DIR", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/custom-claude");

    expect(skillInstallTargetForProvider("claude")).toEqual({
      path: "/tmp/custom-claude/skills/dosu",
      symlink: true,
    });
  });

  it("reports the universal skill target for Codex", () => {
    expect(skillInstallTargetForProvider("codex")).toEqual({
      path: join(homedir(), ".agents", "skills", "dosu"),
      symlink: false,
    });
  });

  it("reports the Windsurf symlink target", () => {
    expect(skillInstallTargetForProvider("windsurf")).toEqual({
      path: join(homedir(), ".codeium", "windsurf", "skills", "dosu"),
      symlink: true,
    });
  });

  it("returns null for a provider without skill support", () => {
    expect(skillInstallTargetForProvider("manual")).toBeNull();
  });

  it("keeps the installer quiet for agent-mediated setup", async () => {
    await installSkill(["claude"], { quiet: true });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      { windowsHide: true },
      expect.any(Function),
    );
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns failure when the async quiet installer fails", async () => {
    mockExec.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(new Error("command failed"));
    });

    const result = await installSkill(["claude"], { quiet: true });

    expect(result.success).toBe(false);
  });

  it("does not broaden an unsupported provider into an all-agent install", async () => {
    const result = await installSkill(["manual"]);

    expect(result.success).toBe(true);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("writes cache with SHA on success", async () => {
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBe("test-sha");

    const cachePath = join(tempDir, "dosu-cli", "skill-update-check.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cache.installedSha).toBe("test-sha");
    expect(cache.latestSha).toBe("test-sha");
    expect(typeof cache.lastCheck).toBe("number");
  });

  it("returns success without SHA when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it("returns success without SHA when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await installSkill();
    expect(result.success).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it("returns failure when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = await installSkill();
    expect(result.success).toBe(false);
    expect(result.sha).toBeUndefined();
  });
});

// ─── Live knowledge skills (`skill link|resolve|links|unlink`) ───────────────

const DOC = "879cbca9-2fbf-45be-9a3e-1b74303238be";
const OTHER_DOC = "5b1f0c0e-6f1a-4c2b-9d3e-0a1b2c3d4e5f";
const LIB = "11111111-1111-4111-8111-111111111111";
const OTHER_LIB = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const STORE = "66e1c189-0000-4000-8000-000000000000";
const TITLE = "DB Enum Widening Checklist";
const BODY = "# DB Enum Widening Checklist\n\n1. Confirm the enum is widened, never narrowed.\n";
/** Distinctive so a leak into the generated file cannot hide behind a short token. */
const SECRETS = {
  access_token: "tok-secret-123",
  refresh_token: "ref-secret-456",
  api_key: "sk_user_secret_789",
};
const linkedConfig = makeTestConfig({ ...SECRETS, expires_at: 0, space_id: LIB, org_id: ORG });

const FOREIGN_SKILL = "---\nname: mine\ndescription: hand written\n---\n\n# mine\n";
const CORRUPT_SKILL =
  "---\nname: broken\n---\n<!-- dosu:skill-link v1 {not json} -->\n\n# broken\n";

type Handler = (input: unknown) => unknown;

/** Script return values (or thrown errors) per procedure path. Unscripted paths reject loudly. */
function script(handlers: Record<string, Handler>): void {
  mockQuery.mockImplementation(async (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unscripted procedure: ${path}`);
    return handler(input);
  });
}

function version(v: number, published: boolean) {
  return { id: `pv-${v}`, version: v, published };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    title: TITLE,
    body: BODY,
    version: 2,
    page_version_id: "pv-2",
    published: true,
    archived: false,
    knowledge_store_id: STORE,
    updated_at: "2026-09-10T01:08:02.487426+00:00",
    ...overrides,
  };
}

/** Store found, the given revision inventory, and `page.get` echoing the requested version. */
function scriptDocument(versions: unknown[], extra: Record<string, Handler> = {}): void {
  script({
    "knowledgeStore.getBySpaceId": () => ({ id: STORE, space_id: LIB }),
    "page.listVersions": () => versions,
    "page.get": (input) => {
      const { version: v } = input as { version: number };
      return page({ version: v, page_version_id: `pv-${v}` });
    },
    ...extra,
  });
}

function trpcError(code: string) {
  return new TRPCClientError("upstream failure", {
    result: { error: { code: -32000, message: "upstream failure", data: { code } } },
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping for stable assertions
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function plainOutput(): string {
  return stripAnsi(allOutput());
}

/** JSON mode must print exactly one JSON document and nothing else on stdout. */
function singleJSON(): Record<string, unknown> {
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]).toHaveLength(1);
  return JSON.parse(String(logSpy.mock.calls[0][0]));
}

async function expectExit(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow("exit");
  expect(exitSpy).toHaveBeenCalledWith(1);
}

/** `inGitWorkTree` shells out to git; answer that one command and nothing else. */
function stubGitWorkTree(inside: boolean): void {
  mockExecSync.mockImplementation((command: unknown) =>
    String(command).startsWith("git rev-parse")
      ? Buffer.from(inside ? "true\n" : "false\n")
      : undefined,
  );
}

function marker(overrides: Partial<Omit<LinkMarker, "content_sha256">> = {}) {
  return {
    document_id: DOC,
    library_id: LIB,
    org_id: ORG,
    revision: null,
    template: SKILL_LINK_TEMPLATE_VERSION,
    cli_version: VERSION,
    ...overrides,
  };
}

/** Byte-identical to what `skill link` renders for the same inputs. */
function expectedRender(name: string, revision: number | null = null, description?: string) {
  return renderSkillMarkdown({
    name,
    description: description ?? defaultSkillDescription(TITLE, name, revision),
    marker: marker({ revision }),
  });
}

function seed(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe("live knowledge skills", () => {
  let claudeDir: string;
  let projectDir: string;

  function skillFile(name: string, root: string = join(claudeDir, "skills")): string {
    return join(root, name, "SKILL.md");
  }

  function projectSkillFile(name: string): string {
    return skillFile(name, join(projectDir, ".claude", "skills"));
  }

  beforeEach(() => {
    mockQuery.mockReset();
    mockMutate.mockReset();
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue(linkedConfig);
    claudeDir = join(tempDir, "claude");
    projectDir = join(tempDir, "repo");
    vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
  });

  it("describes the parent command's two jobs", () => {
    expect(skillCommand().description()).toBe(
      "Manage the Dosu agent skill and link Dosu documents as live skills",
    );
  });

  describe("skill link", () => {
    it("creates SKILL.md and reports the binding as one JSON object", async () => {
      scriptDocument([version(1, true), version(2, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude", "--json");

      const file = skillFile("migration-review");
      expect(singleJSON()).toEqual({
        step: "skill_link",
        status: "ok",
        action: "created",
        skill: { name: "migration-review", agent: "claude", scope: "user", path: file },
        source: {
          document_id: DOC,
          title: TITLE,
          library_id: LIB,
          tracking: "live",
          resolved_revision: 2,
        },
        agent_next_steps:
          "Invoke /migration-review in Claude Code. If the skill does not appear, start a new session.",
      });
      expect(errorSpy).not.toHaveBeenCalled();

      const content = readFileSync(file, "utf-8");
      expect(content).toBe(expectedRender("migration-review"));
      expect(parseMarker(content)).toMatchObject({ kind: "ok", edited: false, marker: marker() });
      expect(mockQuery).toHaveBeenCalledWith("page.get", { page_id: DOC, version: 2 });
    });

    it("prints a human summary with title, path and the new-session note", async () => {
      scriptDocument([version(1, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");

      const output = plainOutput();
      expect(output).toContain("✓ Linked skill 'migration-review' (created)");
      expect(output).toContain(TITLE);
      expect(output).toContain(DOC);
      expect(output).toContain(skillFile("migration-review"));
      expect(output).toMatch(/Tracking\s+live/);
      expect(output).toMatch(/Resolved\s+revision 1/);
      expect(output).toContain(
        "Invoke /migration-review in Claude Code. If the skill does not appear, start a new session.",
      );
    });

    it("pins to --revision and fetches only that revision", async () => {
      scriptDocument([version(1, true), version(2, true), version(3, true)]);
      await run("link", DOC, "--name", "pinned", "--agent", "claude", "--revision", "2", "--json");

      const out = singleJSON();
      expect(out.action).toBe("created");
      expect(out.source).toMatchObject({ tracking: "pinned", resolved_revision: 2 });
      expect(mockQuery).not.toHaveBeenCalledWith("page.listVersions", expect.anything());
      expect(mockQuery).toHaveBeenCalledWith("page.get", { page_id: DOC, version: 2 });

      const content = readFileSync(skillFile("pinned"), "utf-8");
      expect(content).toBe(expectedRender("pinned", 2));
      expect(content).toContain(`--library ${LIB} --revision 2 --json`);
      expect(content).toContain("(pinned to revision 2)");
    });

    it("shows pinned tracking in human mode", async () => {
      scriptDocument([]);
      await run("link", DOC, "--name", "pinned", "--agent", "claude", "--revision", "2");
      expect(plainOutput()).toMatch(/Tracking\s+pinned to revision 2/);
    });

    it("uses --description verbatim instead of the generated one", async () => {
      scriptDocument([version(1, true)]);
      await run(
        "link",
        DOC,
        "--name",
        "custom",
        "--agent",
        "claude",
        "--description",
        "Review enum migrations.",
      );
      const content = readFileSync(skillFile("custom"), "utf-8");
      expect(content).toContain('description: "Review enum migrations."');
      expect(content).toBe(expectedRender("custom", null, "Review enum migrations."));
    });

    it("treats re-linking an identical binding as unchanged without rewriting", async () => {
      scriptDocument([version(1, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");
      const file = skillFile("migration-review");
      const before = readFileSync(file, "utf-8");
      const past = new Date(Date.now() - 60_000);
      utimesSync(file, past, past);
      const mtime = statSync(file).mtimeMs;

      logSpy.mockClear();
      await run("link", DOC, "--name", "migration-review", "--agent", "claude", "--json");
      expect(singleJSON().action).toBe("unchanged");
      expect(readFileSync(file, "utf-8")).toBe(before);
      expect(statSync(file).mtimeMs).toBe(mtime);
    });

    it("rewrites an owned binding when --revision changes", async () => {
      scriptDocument([version(1, true), version(2, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");

      logSpy.mockClear();
      await run(
        "link",
        DOC,
        "--name",
        "migration-review",
        "--agent",
        "claude",
        "--revision",
        "2",
        "--json",
      );
      expect(singleJSON().action).toBe("updated");
      const content = readFileSync(skillFile("migration-review"), "utf-8");
      expect(content).toBe(expectedRender("migration-review", 2));
      expect(parseMarker(content)).toMatchObject({ kind: "ok", edited: false });
    });

    it("refuses to overwrite a hand-edited binding unless --force", async () => {
      scriptDocument([version(1, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");
      const file = skillFile("migration-review");
      const edited = `${readFileSync(file, "utf-8")}\nLocal note.\n`;
      writeFileSync(file, edited);

      logSpy.mockClear();
      await expectExit(
        run("link", DOC, "--name", "migration-review", "--agent", "claude", "--json"),
      );
      expect(singleJSON()).toMatchObject({
        step: "skill_link",
        status: "error",
        reason: "binding_modified",
        agent_next_steps: "Re-run with --force to overwrite your edits, or unlink and link again.",
      });
      expect(readFileSync(file, "utf-8")).toBe(edited);

      logSpy.mockClear();
      await run(
        "link",
        DOC,
        "--name",
        "migration-review",
        "--agent",
        "claude",
        "--force",
        "--json",
      );
      expect(singleJSON().action).toBe("updated");
      expect(readFileSync(file, "utf-8")).toBe(expectedRender("migration-review"));
    });

    it("refuses to repoint an owned binding at another document unless --force", async () => {
      scriptDocument([version(1, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");
      const file = skillFile("migration-review");
      const before = readFileSync(file, "utf-8");

      logSpy.mockClear();
      await expectExit(
        run("link", OTHER_DOC, "--name", "migration-review", "--agent", "claude", "--json"),
      );
      const out = singleJSON();
      expect(out).toMatchObject({
        status: "error",
        reason: "binding_points_elsewhere",
        details: { previous_document_id: DOC },
      });
      expect(String(out.message)).toContain(DOC);
      expect(String(out.agent_next_steps)).toContain(OTHER_DOC);
      expect(readFileSync(file, "utf-8")).toBe(before);

      logSpy.mockClear();
      await run(
        "link",
        OTHER_DOC,
        "--name",
        "migration-review",
        "--agent",
        "claude",
        "--force",
        "--json",
      );
      expect(singleJSON().action).toBe("updated");
      expect(parseMarker(readFileSync(file, "utf-8"))).toMatchObject({
        kind: "ok",
        marker: { document_id: OTHER_DOC },
      });
    });

    it("never overwrites a skill Dosu does not own, even with --force", async () => {
      scriptDocument([version(1, true)]);
      const file = skillFile("mine");
      seed(file, FOREIGN_SKILL);

      await expectExit(run("link", DOC, "--name", "mine", "--agent", "claude", "--json"));
      expect(singleJSON()).toMatchObject({ status: "error", reason: "name_taken" });
      expect(readFileSync(file, "utf-8")).toBe(FOREIGN_SKILL);

      logSpy.mockClear();
      await expectExit(run("link", DOC, "--name", "mine", "--agent", "claude", "--force"));
      expect(logSpy).not.toHaveBeenCalled();
      expect(allErrors()).toContain("Error [name_taken]:");
      expect(allErrors()).toContain("--force does not overwrite skills Dosu does not own.");
      expect(readFileSync(file, "utf-8")).toBe(FOREIGN_SKILL);
    });

    it("reports a corrupt marker and overwrites it only with --force", async () => {
      scriptDocument([version(1, true)]);
      const file = skillFile("broken");
      seed(file, CORRUPT_SKILL);

      await expectExit(run("link", DOC, "--name", "broken", "--agent", "claude", "--json"));
      const out = singleJSON();
      expect(out).toMatchObject({ status: "error", reason: "binding_corrupt" });
      expect(String(out.message)).toContain("Dosu skill-link marker");
      expect(readFileSync(file, "utf-8")).toBe(CORRUPT_SKILL);

      logSpy.mockClear();
      await run("link", DOC, "--name", "broken", "--agent", "claude", "--force", "--json");
      expect(singleJSON().action).toBe("updated");
      expect(parseMarker(readFileSync(file, "utf-8")).kind).toBe("ok");
    });

    it("writes nothing when the document cannot be resolved", async () => {
      scriptDocument([]);
      await expectExit(
        run("link", DOC, "--name", "migration-review", "--agent", "claude", "--json"),
      );
      const out = singleJSON();
      expect(out).toMatchObject({
        step: "skill_link",
        status: "error",
        reason: "document_not_found",
      });
      expect(out.message).toBeTypeOf("string");
      expect(out.agent_next_steps).toBeTypeOf("string");
      expect(existsSync(join(claudeDir, "skills"))).toBe(false);
    });

    it("surfaces an API access failure as access_denied in human mode", async () => {
      scriptDocument([], {
        "page.listVersions": () => {
          throw trpcError("FORBIDDEN");
        },
      });
      await expectExit(run("link", DOC, "--name", "migration-review", "--agent", "claude"));
      expect(logSpy).not.toHaveBeenCalled();
      expect(allErrors()).toContain("Error [access_denied]:");
      expect(existsSync(join(claudeDir, "skills"))).toBe(false);
    });

    it.each(["../x", "dosu", ".hidden"])("rejects the skill name %j", async (name) => {
      scriptDocument([version(1, true)]);
      await expectExit(run("link", DOC, "--name", name, "--agent", "claude", "--json"));
      expect(singleJSON()).toMatchObject({ status: "error", reason: "invalid_name" });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(existsSync(join(claudeDir, "skills"))).toBe(false);
    });

    it("fails closed when the containment check refuses the path", async () => {
      scriptDocument([version(1, true)]);
      vi.mocked(skillPathsFor).mockReturnValueOnce(null);
      await expectExit(run("link", DOC, "--name", "escapee", "--agent", "claude", "--json"));
      const out = singleJSON();
      expect(out).toMatchObject({ status: "error", reason: "invalid_name" });
      expect(String(out.message)).toContain("escapee");
      expect(existsSync(join(claudeDir, "skills"))).toBe(false);
    });

    it("rejects an unsupported --agent as a usage error", async () => {
      await expect(run("link", DOC, "--name", "x", "--agent", "cursor")).rejects.toMatchObject({
        code: "commander.invalidArgument",
      });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("requires --name and --agent", async () => {
      await expect(run("link", DOC, "--agent", "claude")).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
      await expect(run("link", DOC, "--name", "x")).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    });

    it("validates the document id and --revision", async () => {
      await expect(
        run("link", "not-a-uuid", "--name", "x", "--agent", "claude"),
      ).rejects.toMatchObject({
        code: "commander.invalidArgument",
      });
      await expect(
        run("link", DOC, "--name", "x", "--agent", "claude", "--revision", "0"),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });
    });

    it("refuses --project outside a git work tree", async () => {
      stubGitWorkTree(false);
      scriptDocument([version(1, true)]);
      await expectExit(run("link", DOC, "--name", "x", "--agent", "claude", "--project", "--json"));
      expect(singleJSON()).toMatchObject({
        status: "error",
        reason: "not_a_git_work_tree",
        message: "--project requires a git work tree.",
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(existsSync(join(projectDir, ".claude"))).toBe(false);
    });

    it("writes under <cwd>/.claude/skills with --project inside a work tree", async () => {
      mkdirSync(projectDir, { recursive: true });
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      stubGitWorkTree(true);
      scriptDocument([version(1, true)]);

      await run("link", DOC, "--name", "repo-skill", "--agent", "claude", "--project", "--json");
      const file = projectSkillFile("repo-skill");
      expect(singleJSON()).toMatchObject({
        action: "created",
        skill: { scope: "project", path: file },
      });
      expect(readFileSync(file, "utf-8")).toBe(expectedRender("repo-skill"));
      expect(existsSync(join(claudeDir, "skills"))).toBe(false);
      expect(mockExecSync).toHaveBeenCalledWith(
        "git rev-parse --is-inside-work-tree",
        expect.objectContaining({ cwd: projectDir }),
      );
    });

    it("requires login before resolving anything", async () => {
      mockLoadConfig.mockReturnValue({ schema_version: CONFIG_SCHEMA_VERSION });
      await expectExit(run("link", DOC, "--name", "x", "--agent", "claude"));
      expect(allErrors()).toContain("Not logged in. Run 'dosu login' first.");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("requires a selected Library", async () => {
      mockLoadConfig.mockReturnValue(makeTestConfig({ ...SECRETS, expires_at: 0, org_id: ORG }));
      await expectExit(run("link", DOC, "--name", "x", "--agent", "claude"));
      expect(allErrors()).toContain("Missing space config. Run 'dosu setup' to reconfigure.");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("never writes credentials into the generated file", async () => {
      scriptDocument([version(1, true)]);
      await run("link", DOC, "--name", "migration-review", "--agent", "claude");
      const content = readFileSync(skillFile("migration-review"), "utf-8");
      for (const secret of Object.values(SECRETS)) expect(content).not.toContain(secret);
      expect(content).toContain(LIB);
      expect(content).toContain(ORG);
    });
  });

  describe("skill resolve", () => {
    it("returns source and body as one JSON object", async () => {
      scriptDocument([version(1, true), version(2, true), version(3, false)]);
      await run("resolve", "--document", DOC, "--library", LIB, "--json");
      expect(singleJSON()).toMatchObject({
        step: "skill_resolve",
        status: "ok",
        source: {
          document_id: DOC,
          title: TITLE,
          revision: 2,
          page_version_id: "pv-2",
          published: true,
          tracking: "live",
          library_id: LIB,
          knowledge_store_id: STORE,
        },
        body: BODY,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("fetches only the pinned revision with --revision", async () => {
      scriptDocument([]);
      await run("resolve", "--document", DOC, "--library", LIB, "--revision", "1", "--json");
      expect(singleJSON().source).toMatchObject({ revision: 1, tracking: "pinned" });
      expect(mockQuery).not.toHaveBeenCalledWith("page.listVersions", expect.anything());
      expect(mockQuery).toHaveBeenCalledWith("page.get", { page_id: DOC, version: 1 });
    });

    it("prints a source header and the body verbatim in human mode", async () => {
      scriptDocument([version(2, true)]);
      await run("resolve", "--document", DOC, "--library", LIB);
      const output = plainOutput();
      expect(output).toContain(`Source: "${TITLE}" · document ${DOC} · revision 2 · live`);
      expect(output).toContain(BODY);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("emits a failure as one JSON object on stdout and exits 1", async () => {
      scriptDocument([version(1, true)]);
      await expectExit(run("resolve", "--document", DOC, "--library", OTHER_LIB, "--json"));
      const out = singleJSON();
      expect(out).toMatchObject({
        step: "skill_resolve",
        status: "error",
        reason: "library_mismatch",
        details: { linked_library_id: OTHER_LIB, active_library_id: LIB },
      });
      expect(out.message).toBeTypeOf("string");
      expect(out.agent_next_steps).toBeTypeOf("string");
      expect(errorSpy).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("prints failures in red on stderr with nothing on stdout in human mode", async () => {
      scriptDocument([version(1, false)]);
      await expectExit(run("resolve", "--document", DOC, "--library", LIB));
      expect(logSpy).not.toHaveBeenCalled();
      const [first, second] = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(first).toContain("Error [no_published_revision]:");
      expect(first).toBe(pc.red(stripAnsi(first)));
      expect(second).toContain("Publish a revision in Dosu");
    });

    it("maps a FORBIDDEN response to access_denied", async () => {
      scriptDocument([], {
        "page.listVersions": () => {
          throw trpcError("FORBIDDEN");
        },
      });
      await expectExit(run("resolve", "--document", DOC, "--library", LIB, "--json"));
      expect(singleJSON()).toMatchObject({ status: "error", reason: "access_denied" });
    });

    it("requires login", async () => {
      mockLoadConfig.mockReturnValue({ schema_version: CONFIG_SCHEMA_VERSION });
      await expectExit(run("resolve", "--document", DOC, "--library", LIB, "--json"));
      expect(allErrors()).toContain("Not logged in. Run 'dosu login' first.");
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("requires --document and --library as UUIDs", async () => {
      await expect(run("resolve", "--library", LIB)).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
      await expect(run("resolve", "--document", DOC)).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
      await expect(run("resolve", "--document", "nope", "--library", LIB)).rejects.toMatchObject({
        code: "commander.invalidArgument",
      });
    });
  });

  describe("skill links", () => {
    it("reports when nothing is linked", async () => {
      await run("links");
      expect(plainOutput()).toContain("No linked skills found.");

      logSpy.mockClear();
      await run("links", "--json");
      expect(singleJSON()).toEqual({ step: "skill_links", status: "ok", skills: [] });
    });

    it("lists bindings across user and project roots and ignores foreign skills", async () => {
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      seed(skillFile("alpha"), expectedRender("alpha"));
      seed(skillFile("mine"), FOREIGN_SKILL);
      const projectFile = projectSkillFile("beta");
      seed(
        projectFile,
        renderSkillMarkdown({
          name: "beta",
          description: "Pinned.",
          marker: marker({ document_id: OTHER_DOC, library_id: OTHER_LIB, revision: 3 }),
        }),
      );

      await run("links");
      const output = plainOutput();
      expect(output).toMatch(/^alpha\s+879cbca9\s+live\s+11111111\s+user\s+\S+alpha\/SKILL\.md/m);
      expect(output).toMatch(/^beta\s+5b1f0c0e\s+pinned \(r3\)\s+22222222\s+project\s+/m);
      expect(output).toContain(projectFile);
      expect(output).not.toContain("mine");
      expect(output).not.toContain("edited after");

      logSpy.mockClear();
      await run("links", "--json");
      const out = singleJSON();
      expect(out).toMatchObject({ step: "skill_links", status: "ok" });
      expect(out.skills).toEqual([
        expect.objectContaining({ name: "alpha", agent: "claude", scope: "user", edited: false }),
        expect.objectContaining({
          name: "beta",
          scope: "project",
          path: projectFile,
          marker: expect.objectContaining({ document_id: OTHER_DOC, revision: 3 }),
        }),
      ]);
    });

    it("marks edited bindings with an asterisk and explains it", async () => {
      seed(skillFile("alpha"), `${expectedRender("alpha")}\nLocal note.\n`);
      await run("links");
      const output = plainOutput();
      expect(output).toMatch(/^alpha \*\s/m);
      expect(output).toContain("* edited after it was generated");

      logSpy.mockClear();
      await run("links", "--json");
      expect(singleJSON().skills).toEqual([
        expect.objectContaining({ name: "alpha", edited: true }),
      ]);
    });

    it("accepts --project when the project root does not exist yet", async () => {
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      seed(skillFile("alpha"), expectedRender("alpha"));
      await run("links", "--project", "--json");
      expect(singleJSON().skills).toEqual([
        expect.objectContaining({ name: "alpha", scope: "user" }),
      ]);
    });

    it("does not require login", async () => {
      mockLoadConfig.mockReturnValue({ schema_version: CONFIG_SCHEMA_VERSION });
      await run("links", "--json");
      expect(singleJSON()).toMatchObject({ status: "ok" });
      expect(mockLoadConfig).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("rejects an unsupported --agent", async () => {
      await expect(run("links", "--agent", "cursor")).rejects.toMatchObject({
        code: "commander.invalidArgument",
      });
    });
  });

  describe("skill unlink", () => {
    it("removes an owned binding and its now-empty directory", async () => {
      const file = skillFile("alpha");
      seed(file, expectedRender("alpha"));
      await run("unlink", "alpha", "--agent", "claude", "--json");
      expect(singleJSON()).toEqual({
        step: "skill_unlink",
        status: "ok",
        skill: { name: "alpha", agent: "claude", scope: "user", path: file },
        directory_removed: true,
        leftover: [],
      });
      expect(existsSync(dirname(file))).toBe(false);
      expect(mockLoadConfig).not.toHaveBeenCalled();
    });

    it("keeps a directory that still holds other files and reports them", async () => {
      const file = skillFile("alpha");
      seed(file, expectedRender("alpha"));
      writeFileSync(join(dirname(file), "notes.txt"), "keep me");

      await run("unlink", "alpha", "--agent", "claude");
      const output = plainOutput();
      expect(output).toContain("✓ Unlinked skill 'alpha'");
      expect(output).toContain(`Left in place: ${dirname(file)} (notes.txt)`);
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(join(dirname(file), "notes.txt"), "utf-8")).toBe("keep me");
    });

    it("prints only the success line when the directory was removed", async () => {
      seed(skillFile("alpha"), expectedRender("alpha"));
      await run("unlink", "alpha", "--agent", "claude");
      expect(plainOutput()).toBe("✓ Unlinked skill 'alpha'");
    });

    it("refuses to remove a skill Dosu does not own", async () => {
      const file = skillFile("mine");
      seed(file, FOREIGN_SKILL);
      await expectExit(run("unlink", "mine", "--agent", "claude", "--json"));
      expect(singleJSON()).toMatchObject({
        step: "skill_unlink",
        status: "error",
        reason: "not_a_dosu_link",
        agent_next_steps:
          "This skill was not created by 'dosu skill link'; remove it manually if intended.",
      });
      expect(readFileSync(file, "utf-8")).toBe(FOREIGN_SKILL);
    });

    it("reports a missing skill as not_found", async () => {
      await expectExit(run("unlink", "ghost", "--agent", "claude"));
      expect(logSpy).not.toHaveBeenCalled();
      expect(allErrors()).toContain("Error [not_found]:");
      expect(allErrors()).toContain("Run 'dosu skill links' to see linked skills.");
    });

    it("leaves a corrupt marker in place", async () => {
      const file = skillFile("broken");
      seed(file, CORRUPT_SKILL);
      await expectExit(run("unlink", "broken", "--agent", "claude", "--json"));
      expect(singleJSON()).toMatchObject({
        reason: "corrupt",
        agent_next_steps: "Inspect the file and remove it manually if intended.",
      });
      expect(readFileSync(file, "utf-8")).toBe(CORRUPT_SKILL);
    });

    it("rejects the reserved official skill name before touching the filesystem", async () => {
      await expectExit(run("unlink", "dosu", "--agent", "claude", "--json"));
      const out = singleJSON();
      expect(out).toMatchObject({ step: "skill_unlink", status: "error", reason: "invalid_name" });
      expect(String(out.message)).toContain("reserved");
    });

    it("targets <cwd>/.claude/skills with --project without a git check", async () => {
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
      const file = projectSkillFile("beta");
      seed(file, expectedRender("beta"));
      await run("unlink", "beta", "--agent", "claude", "--project", "--json");
      expect(singleJSON()).toMatchObject({
        skill: { scope: "project", path: file },
        directory_removed: true,
      });
      expect(existsSync(file)).toBe(false);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("requires --agent", async () => {
      await expect(run("unlink", "alpha")).rejects.toMatchObject({
        code: "commander.missingMandatoryOptionValue",
      });
    });
  });
});
