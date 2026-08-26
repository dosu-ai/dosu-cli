import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import type { Config } from "../config/config";
import { updateTarget } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { SetupProvider } from "../mcp/providers";
import { CursorProvider } from "../mcp/providers/cursor";
import { OpenCodeProvider } from "../mcp/providers/opencode";
import {
  type BulkProjectSetupDependencies,
  configureBulkRepository,
  runBulkProjectSetup,
} from "./bulk-flow";
import type { RepositoryBindingState } from "./project-inspection";
import { inspectRepositoryBindings } from "./project-inspection";

function provider(id = "cursor"): SetupProvider {
  return {
    id: () => id,
    name: () => id,
    configurationKind: () => "project",
    install: vi.fn(),
    remove: vi.fn(),
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => false,
    globalConfigPath: () => `/global/${id}`,
    projectConfigPath: (root) => `${root}/.${id}/mcp.json`,
    isProjectConfigured: () => true,
    priority: () => 0,
  };
}

function config(): Config {
  const cfg = makeTestConfig({
    access_token: "token",
    refresh_token: "refresh",
    expires_at: 4_102_444_800,
    user_id: "user",
    deployment_id: "dep-a",
    deployment_name: "Library A",
    api_key: "key-a",
  });
  updateTarget(cfg, {
    deployment_id: "dep-b",
    deployment_name: "Library B",
    api_key: "key-b",
  });
  return cfg;
}

function state(
  path: string,
  options: Partial<RepositoryBindingState> = {},
): RepositoryBindingState {
  return {
    projectRoot: path,
    inspections: [],
    blockers: [],
    targets: [],
    ownedProviderIDs: [],
    ...options,
  };
}

describe("bulk project setup flow", () => {
  const cursor = provider();
  const repositories = [
    { kind: "repository" as const, path: "/scan/one" },
    { kind: "worktree" as const, path: "/scan/two" },
  ];
  let dependencies: Required<BulkProjectSetupDependencies>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(p.isCancel).mockReturnValue(false);
    dependencies = {
      providers: vi.fn(() => [cursor]),
      validateDirectories: vi.fn(() => ["/scan"]),
      scanRepositories: vi.fn(() => repositories),
      inspectRepository: vi.fn((path: string) => state(path)),
      installSkills: vi.fn().mockResolvedValue(true),
      fetchInstruction: vi.fn().mockResolvedValue("canonical rule\n"),
      configureRepository: vi.fn(async ({ repository }) => ({
        projectRoot: repository.path,
        success: true,
      })),
      reconcileGlobal: vi.fn(() => ({ outcomes: [], removed: [], preserved: [] })),
      saveConfig: vi.fn(),
    };
    vi.mocked(p.select).mockResolvedValue("dep-b" as never);
    vi.mocked(p.text).mockResolvedValue("/scan" as never);
    vi.mocked(p.multiselect)
      .mockResolvedValueOnce(repositories.map((repo) => repo.path) as never)
      .mockResolvedValueOnce(["cursor"] as never);
    vi.mocked(p.confirm).mockResolvedValue(true as never);
  });

  it("uses the fixed Library → repositories → agents → preview → execute order", async () => {
    const cfg = config();

    const result = await runBulkProjectSetup(cfg, dependencies);

    expect(result.status).toBe("completed");
    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select Library" }));
    expect(vi.mocked(p.multiselect).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "Select projects" }),
    );
    expect(vi.mocked(p.multiselect).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ message: "Select agents" }),
    );
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("Library B"));
    expect(p.confirm).toHaveBeenLastCalledWith({ message: "Apply this plan?" });
    expect(dependencies.installSkills).toHaveBeenCalledWith([cursor]);
    expect(dependencies.fetchInstruction).toHaveBeenCalledOnce();
    expect(dependencies.configureRepository).toHaveBeenCalledTimes(2);
    expect(dependencies.configureRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          active_account: expect.objectContaining({
            target: expect.objectContaining({ deployment_id: "dep-b", api_key: "key-b" }),
          }),
        }),
      }),
    );
    expect(cfg.scan_directories).toEqual(["/scan"]);
    expect(dependencies.saveConfig).toHaveBeenCalledWith(cfg);
    expect(dependencies.reconcileGlobal).toHaveBeenCalledTimes(1);
  });

  it("asks for replacement separately per conflicting project and skips declines", async () => {
    vi.mocked(dependencies.inspectRepository).mockImplementation((path: string) =>
      state(path, {
        targets: [{ kind: "deployment", deploymentID: "dep-old" }],
        ownedProviderIDs: ["cursor"],
      }),
    );
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);

    const result = await runBulkProjectSetup(config(), dependencies);

    expect(result.status).toBe("completed");
    expect(p.confirm).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: expect.stringContaining("/scan/one") }),
    );
    expect(p.confirm).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: expect.stringContaining("/scan/two") }),
    );
    expect(dependencies.configureRepository).toHaveBeenCalledTimes(1);
    expect(dependencies.configureRepository).toHaveBeenCalledWith(
      expect.objectContaining({ repository: repositories[1], replaceExisting: true }),
    );
  });

  it("blocks foreign or malformed projects before any write to that project", async () => {
    vi.mocked(dependencies.inspectRepository).mockImplementation((path: string) =>
      path.endsWith("one")
        ? state(path, {
            blockers: [
              {
                providerID: "cursor",
                path: `${path}/.cursor/mcp.json`,
                status: "foreign",
              },
            ],
          })
        : state(path),
    );

    await runBulkProjectSetup(config(), dependencies);

    const repoOptions = vi.mocked(p.multiselect).mock.calls[0]?.[0]?.options as Array<{
      value: string;
      disabled?: boolean;
    }>;
    expect(repoOptions.find((option) => option.value === "/scan/one")?.disabled).toBe(true);
    expect(dependencies.configureRepository).toHaveBeenCalledTimes(1);
    expect(dependencies.configureRepository).toHaveBeenCalledWith(
      expect.objectContaining({ repository: repositories[1] }),
    );
  });

  it("continues after one repository fails but withholds global cleanup", async () => {
    vi.mocked(dependencies.configureRepository)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce({ projectRoot: "/scan/two", success: true });

    const result = await runBulkProjectSetup(config(), dependencies);

    expect(result.status).toBe("completed");
    expect(result.repositories).toEqual([
      { projectRoot: "/scan/one", success: false, error: "disk full" },
      { projectRoot: "/scan/two", success: true },
    ]);
    expect(dependencies.configureRepository).toHaveBeenCalledTimes(2);
    expect(dependencies.reconcileGlobal).not.toHaveBeenCalled();
  });

  it("makes cancellation before execution a zero-write operation", async () => {
    vi.mocked(p.confirm).mockResolvedValueOnce(false as never);
    const cfg = config();
    const before = structuredClone(cfg);

    const result = await runBulkProjectSetup(cfg, dependencies);

    expect(result.status).toBe("cancelled");
    expect(cfg).toEqual(before);
    expect(dependencies.saveConfig).not.toHaveBeenCalled();
    expect(dependencies.installSkills).not.toHaveBeenCalled();
    expect(dependencies.configureRepository).not.toHaveBeenCalled();
    expect(dependencies.reconcileGlobal).not.toHaveBeenCalled();
  });
});

describe("bulk repository execution", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "dosu-bulk-project-"));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("writes only the project MCP, rule, and AGENTS.md bundle with no project skill copy", async () => {
    const cursor = CursorProvider();
    const result = await configureBulkRepository({
      config: config(),
      repository: { path: projectRoot, kind: "repository" },
      selectedProviders: [cursor],
      knownProviders: [cursor],
      initialState: inspectRepositoryBindings(projectRoot, [cursor]),
      replaceExisting: false,
      instruction: "canonical rule\n",
    });

    expect(result).toEqual({ projectRoot, success: true });
    const projectMcp = readFileSync(join(projectRoot, ".cursor", "mcp.json"), "utf8");
    expect(projectMcp).toContain('"dosu"');
    expect(projectMcp).toContain('"dep-b"');
    expect(projectMcp).not.toContain("key-b");
    expect(existsSync(join(projectRoot, ".cursor", "rules", "dosu.mdc"))).toBe(true);
    expect(existsSync(join(projectRoot, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectRoot, ".agents", "skills"))).toBe(false);
  });

  it("retargets every existing owned MCP entry after replacement is approved", async () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    const oldConfig = makeTestConfig({
      access_token: "token",
      refresh_token: "refresh",
      expires_at: 4_102_444_800,
      user_id: "user",
      deployment_id: "dep-old",
      api_key: "key-old",
    });
    opencode.install(oldConfig, { scope: "project", projectRoot });
    const initialState = inspectRepositoryBindings(projectRoot, [cursor, opencode]);

    const result = await configureBulkRepository({
      config: config(),
      repository: { path: projectRoot, kind: "repository" },
      selectedProviders: [cursor],
      knownProviders: [cursor, opencode],
      initialState,
      replaceExisting: true,
      instruction: "canonical rule\n",
    });

    expect(result.success).toBe(true);
    expect(inspectRepositoryBindings(projectRoot, [cursor, opencode]).targets).toEqual([
      { kind: "deployment", deploymentID: "dep-b" },
    ]);
  });

  it("preflights foreign rules before writing the project MCP or AGENTS.md", async () => {
    const cursor = CursorProvider();
    const rulePath = join(projectRoot, ".cursor", "rules", "dosu.mdc");
    mkdirSync(join(projectRoot, ".cursor", "rules"), { recursive: true });
    writeFileSync(rulePath, "user-owned rule\n");

    const result = await configureBulkRepository({
      config: config(),
      repository: { path: projectRoot, kind: "repository" },
      selectedProviders: [cursor],
      knownProviders: [cursor],
      initialState: inspectRepositoryBindings(projectRoot, [cursor]),
      replaceExisting: false,
      instruction: "canonical rule\n",
    });

    expect(result.success).toBe(false);
    expect(readFileSync(rulePath, "utf8")).toBe("user-owned rule\n");
    expect(existsSync(join(projectRoot, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(projectRoot, "AGENTS.md"))).toBe(false);
  });
});
