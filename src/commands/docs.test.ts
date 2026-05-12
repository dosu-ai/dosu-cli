import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockClackLogError, mockClackLogInfo } = vi.hoisted(() => ({
  mockClackLogError: vi.fn(),
  mockClackLogInfo: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    error: mockClackLogError,
    info: mockClackLogInfo,
  },
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

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { logger } from "../debug/logger";
import { docsCommand } from "./docs";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
  org_id: "org1",
};

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(...args: string[]) {
  const cmd = docsCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv.DOSU_BACKEND_URL = process.env.DOSU_BACKEND_URL;
  process.env.DOSU_BACKEND_URL = "https://api.test.dev";
});

afterAll(() => {
  if (savedEnv.DOSU_BACKEND_URL !== undefined) {
    process.env.DOSU_BACKEND_URL = savedEnv.DOSU_BACKEND_URL;
  } else {
    delete process.env.DOSU_BACKEND_URL;
  }
});

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReset();
  mockFetch.mockReset();
  mockClackLogError.mockReset();
  mockClackLogInfo.mockReset();
  mockQuery.mockResolvedValueOnce({ id: "ks1" }); // knowledgeStore.getBySpaceId
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("docs list", () => {
  it("calls page.listWithTags with knowledge_store_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [] });
    await run("list");

    const call = mockQuery.mock.calls[1];
    expect(call[0]).toBe("page.listWithTags");
    expect(call[1].knowledge_store_id).toBe("ks1");
  });

  it("passes --search and --tag filters", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [] });
    await run("list", "--search", "api", "--tag", "t1");

    const input = mockQuery.mock.calls[1][1];
    expect(input.searchTerm).toBe("api");
    expect(input.tag_id).toBe("t1");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [{ id: "p1", title: "Doc" }] });
    await run("list", "--json");
    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ id: "p1", title: "Doc" });
  });

  it("prints message for empty results", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ data: [] });
    await run("list");
    expect(allOutput()).toContain("No documents found");
  });

  it("shows published/draft status", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      data: [
        { id: "p1", title: "Published", published: true },
        { id: "p2", title: "Draft", published: false },
      ],
    });
    await run("list");
    const output = allOutput();
    expect(output).toContain("published");
    expect(output).toContain("draft");
  });
});

describe("docs get", () => {
  it("calls page.get with id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ id: "p1", title: "Test", body: "Content" });
    await run("get", "p1");
    expect(mockQuery).toHaveBeenCalledWith("page.get", {
      page_id: "p1",
      version: undefined,
    });
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    // docs get doesn't call getKnowledgeStoreId, reset mock
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ id: "p1", title: "Test", body: "# Hello" });
    await run("get", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output.id).toBe("p1");
  });

  it("displays human-readable output with body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({
      id: "p1",
      title: "API Guide",
      body: "# Introduction\nThis is the API guide.",
      published: true,
      created_at: "2024-01-15",
    });
    await run("get", "p1");
    const output = allOutput();
    expect(output).toContain("API Guide");
    expect(output).toContain("published");
    expect(output).toContain("Introduction");
  });

  it("displays untitled page without body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ id: "p1", published: false });
    await run("get", "p1");
    const output = allOutput();
    expect(output).toContain("(untitled)");
    expect(output).toContain("draft");
  });
});

describe("docs create", () => {
  it("calls page.create with title and body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "new-p1" });

    await run("create", "--title", "New Doc", "--body", "# Hello World");

    expect(mockMutate).toHaveBeenCalledWith("page.create", {
      knowledge_store_id: "ks1",
      title: "New Doc",
      body: "# Hello World",
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "new-p1", title: "T" });
    await run("create", "--json", "--title", "T");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ id: "new-p1", title: "T" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "new-p1" });
    await run("create", "--title", "My Doc");
    expect(allOutput()).toContain('Document "My Doc" created');
  });
});

describe("docs update", () => {
  it("calls page.update with id and optional fields", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});

    await run("update", "p1", "--title", "Updated");

    const call = mockMutate.mock.calls[0];
    expect(call[0]).toBe("page.update");
    expect(call[1].id).toBe("p1");
    expect(call[1].title).toBe("Updated");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ id: "p1", title: "Updated" });
    await run("update", "--json", "p1", "--title", "Updated");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ id: "p1", title: "Updated" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("update", "p1", "--title", "Updated");
    expect(allOutput()).toContain("Document updated");
  });
});

describe("docs archive/unarchive", () => {
  it("archive calls page.setArchiveState with archived=true", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    // archive doesn't need ksId
    mockQuery.mockReset();
    await run("archive", "p1");
    expect(mockMutate).toHaveBeenCalledWith("page.setArchiveState", {
      page_id: "p1",
      archived: true,
    });
  });

  it("unarchive calls page.setArchiveState with archived=false", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("unarchive", "p1");
    expect(mockMutate).toHaveBeenCalledWith("page.setArchiveState", {
      page_id: "p1",
      archived: false,
    });
  });

  it("archive outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("archive", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.archived).toBe(true);
  });

  it("archive prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("archive", "p1");
    expect(allOutput()).toContain("archived");
  });

  it("unarchive outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("unarchive", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.archived).toBe(false);
  });

  it("unarchive prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("unarchive", "p1");
    expect(allOutput()).toContain("unarchived");
  });
});

describe("docs delete", () => {
  it("calls page.delete mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("delete", "p1");
    expect(mockMutate).toHaveBeenCalledWith("page.delete", { page_id: "p1" });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("delete", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("p1");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("delete", "p1");
    expect(allOutput()).toContain("Document deleted");
  });
});

describe("docs versions", () => {
  it("calls page.listVersions", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([{ version: 1 }, { version: 2 }]);
    await run("versions", "p1");
    expect(mockQuery).toHaveBeenCalledWith("page.listVersions", { page_id: "p1" });
  });

  it("prints message for empty versions", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([]);
    await run("versions", "p1");
    expect(allOutput()).toContain("No versions found");
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([{ version: 1 }, { version: 2 }]);
    await run("versions", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output).toHaveLength(2);
    expect(output.map((version: { version: number }) => version.version)).toEqual([1, 2]);
  });

  it("prints version table with data", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([
      { version: 1, created_at: "2024-01-01" },
      { version: 2, created_at: "2024-01-15" },
    ]);
    await run("versions", "p1");
    const output = allOutput();
    expect(output).toContain("1");
    expect(output).toContain("2");
  });
});

describe("docs restore", () => {
  it("calls page.restoreVersion with page_id and version", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("restore", "p1", "--version", "3");
    expect(mockMutate).toHaveBeenCalledWith("page.restoreVersion", {
      page_id: "p1",
      version_to_restore: 3,
    });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("restore", "--json", "p1", "--version", "3");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.version).toBe("3");
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("restore", "p1", "--version", "3");
    expect(allOutput()).toContain("restored to version 3");
  });
});

describe("docs generate", () => {
  it("POSTs to Python backend /doc/generate", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "started" }));

    await run("generate", "--title", "API Guide", "--instructions", "Focus on REST");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/doc/generate");
    expect(opts.headers["X-Dosu-API-Key"]).toBe("sk_user_test");
    const body = JSON.parse(opts.body);
    expect(body.knowledge_store_id).toBe("ks1");
    expect(body.title).toBe("API Guide");
    expect(body.instructions).toBe("Focus on REST");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "started" }));
    await run("generate", "--json", "--title", "API Guide");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ status: "started" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "started" }));
    await run("generate", "--title", "API Guide");
    expect(allOutput()).toContain("Document generation started");
  });
});

describe("docs auto-tag", () => {
  it("POSTs to Python backend /doc/auto-tag", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    mockQuery.mockReset();
    await run("auto-tag", "p1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/doc/auto-tag");
    expect(opts.headers["X-Dosu-API-Key"]).toBe("sk_user_test");
    expect(JSON.parse(opts.body)).toEqual({ page_id: "p1" });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();
    await run("auto-tag", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ status: "ok" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();
    await run("auto-tag", "p1");
    expect(allOutput()).toContain("Auto-tagging started");
  });
});

describe("docs import", () => {
  it("calls docImports.importGithubFiles with file_ids", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });

    await run("import", "github", "--files", "f1,f2,f3");

    expect(mockMutate).toHaveBeenCalledWith("docImports.importGithubFiles", {
      knowledge_store_id: "ks1",
      space_id: "sp1",
      file_ids: ["f1", "f2", "f3"],
    });
  });

  it("uses page_ids for confluence/notion/coda", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });

    await run("import", "notion", "--files", "p1,p2");

    expect(mockMutate).toHaveBeenCalledWith("docImports.importNotionPages", {
      knowledge_store_id: "ks1",
      space_id: "sp1",
      page_ids: ["p1", "p2"],
    });
  });

  it("calls docImports.importGitlabFiles for gitlab", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });

    await run("import", "gitlab", "--files", "f1,f2");

    expect(mockMutate).toHaveBeenCalledWith("docImports.importGitlabFiles", {
      knowledge_store_id: "ks1",
      space_id: "sp1",
      file_ids: ["f1", "f2"],
    });
  });

  it("calls docImports.importConfluencePages for confluence", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });

    await run("import", "confluence", "--files", "p1,p2");

    expect(mockMutate).toHaveBeenCalledWith("docImports.importConfluencePages", {
      knowledge_store_id: "ks1",
      space_id: "sp1",
      page_ids: ["p1", "p2"],
    });
  });

  it("calls docImports.importCodaPages for coda", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });

    await run("import", "coda", "--files", "p1");

    expect(mockMutate).toHaveBeenCalledWith("docImports.importCodaPages", {
      knowledge_store_id: "ks1",
      space_id: "sp1",
      page_ids: ["p1"],
    });
  });

  it("exits on unknown platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    await expect(run("import", "unknown", "--files", "f1")).rejects.toThrow("exit");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });
    await run("import", "--json", "github", "--files", "f1");
    const output = JSON.parse(allOutput());
    expect(output.task_id).toBe("task-1");
  });

  it("prints human-readable confirmation with task_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ task_id: "task-1" });
    await run("import", "github", "--files", "f1");
    const output = allOutput();
    expect(output).toContain("Import started");
    expect(output).toContain("task-1");
  });

  it("prints human-readable confirmation without task_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    await run("import", "github", "--files", "f1");
    expect(allOutput()).toContain("Import started");
  });

  it("logs import failure and shows JSON detail as a clean message", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockRejectedValueOnce(new Error('{"detail":"Something went wrong"}'));
    await expect(run("import", "github", "--files", "f1")).rejects.toThrow("exit");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "docs-import",
      expect.stringContaining("Something went wrong"),
    );
    expect(mockClackLogError).toHaveBeenCalledWith("Something went wrong");
    expect(mockClackLogInfo).not.toHaveBeenCalled();
  });

  it("shows concurrent-import guidance when import is already in progress", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockRejectedValueOnce(
      new Error('{"detail":"An import operation is already in progress"}'),
    );
    await expect(run("import", "github", "--files", "f1")).rejects.toThrow("exit");
    expect(mockClackLogError).toHaveBeenCalledWith(
      "An import is already in progress for this organization.",
    );
    expect(mockClackLogInfo).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("dosu docs import-status <task-id>"),
    );
    expect(mockClackLogInfo).toHaveBeenNthCalledWith(
      2,
      "Only one import can run per organization at a time.",
    );
  });

  it("outputs JSON error with parsed message when import fails with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockRejectedValueOnce(
      new Error('{"detail":"An import operation is already in progress"}'),
    );
    await expect(run("import", "--json", "github", "--files", "f1")).rejects.toThrow("exit");
    const errLine = errorSpy.mock.calls.map((c) => c[0]).join("\n");
    const parsed = JSON.parse(errLine) as { error: string };
    expect(parsed.error).toContain("dosu docs import-status");
    expect(mockClackLogError).not.toHaveBeenCalled();
  });
});

describe("docs import-status", () => {
  it("calls docImports.getImportStatus", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ status: "completed" });
    await run("import-status", "task-1");
    expect(mockQuery).toHaveBeenCalledWith("docImports.getImportStatus", "task-1");
  });

  it("prints message when task not found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce(null);
    await run("import-status", "bad-task");
    expect(allOutput()).toContain("Import task not found");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ status: "completed" });
    await run("import-status", "--json", "task-1");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ status: "completed" });
  });

  it("prints status in human-readable format", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ status: "completed" });
    await run("import-status", "task-1");
    expect(allOutput()).toContain('Status: {"status":"completed"}');
  });
});

describe("docs publish", () => {
  it("publishes to github via Python backend", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();

    await run(
      "publish",
      "p1",
      "--to",
      "github",
      "--repo-id",
      "123",
      "--directory",
      "docs/",
      "--data-source-id",
      "ds1",
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/sync-back/github/p1/publish");
    const body = JSON.parse(opts.body);
    expect(body.target_repository_id).toBe(123);
    expect(body.target_directory).toBe("docs/");
  });

  it("publishes to confluence via Python backend", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();

    await run(
      "publish",
      "p1",
      "--to",
      "confluence",
      "--parent-page-id",
      "cp1",
      "--data-source-id",
      "ds1",
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/sync-back/confluence/p1/publish");
    const body = JSON.parse(opts.body);
    expect(body.parent_page_id).toBe("cp1");
    expect(body.target_data_source_id).toBe("ds1");
  });

  it("publishes to gitlab via Python backend", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();

    await run("publish", "p1", "--to", "gitlab", "--project-id", "42", "--directory", "docs/");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/sync-back/gitlab/p1/publish");
    const body = JSON.parse(opts.body);
    expect(body.gitlab_project_id).toBe("42");
    expect(body.target_directory).toBe("docs/");
  });

  it("publishes to notion via Python backend", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();

    await run(
      "publish",
      "p1",
      "--to",
      "notion",
      "--parent-page-id",
      "np1",
      "--data-source-id",
      "ds1",
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/sync-back/notion/p1/publish");
    const body = JSON.parse(opts.body);
    expect(body.parent_notion_page_id).toBe("np1");
  });

  it("publishes to coda via Python backend", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();

    await run("publish", "p1", "--to", "coda", "--doc-id", "cd1", "--data-source-id", "ds1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/sync-back/coda/p1/publish");
    const body = JSON.parse(opts.body);
    expect(body.target_doc_id).toBe("cd1");
  });

  it("exits on unknown platform", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    await expect(run("publish", "p1", "--to", "unknown")).rejects.toThrow("exit");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();
    await run("publish", "--json", "p1", "--to", "github", "--repo-id", "123");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ status: "ok" });
  });

  it("prints human-readable confirmation for publish", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    mockQuery.mockReset();
    await run("publish", "p1", "--to", "github", "--repo-id", "123");
    expect(allOutput()).toContain("Document published to github");
  });
});

describe("docs sync-back", () => {
  it("calls page.syncBack mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("sync-back", "p1");
    expect(mockMutate).toHaveBeenCalledWith("page.syncBack", { page_id: "p1" });
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({ status: "queued" });
    mockQuery.mockReset();
    await run("sync-back", "--json", "p1");
    const output = JSON.parse(allOutput());
    expect(output).toMatchObject({ status: "queued" });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce({});
    mockQuery.mockReset();
    await run("sync-back", "p1");
    expect(allOutput()).toContain("Sync-back initiated");
  });
});

describe("getKnowledgeStoreId", () => {
  it("exits when no knowledge store is found", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce(null); // knowledgeStore.getBySpaceId returns null
    await expect(run("list")).rejects.toThrow("exit");
  });
});

describe("backendPost", () => {
  it("exits when backend URL is not configured", async () => {
    const origUrl = process.env.DOSU_BACKEND_URL;
    delete process.env.DOSU_BACKEND_URL;
    try {
      mockLoadConfig.mockReturnValue(validConfig);
      mockQuery.mockReset();
      await expect(run("generate", "--title", "T")).rejects.toThrow("exit");
    } finally {
      process.env.DOSU_BACKEND_URL = origUrl;
    }
  });

  it("throws error with detail from failed backend response", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Rate limited" }, 429));
    await expect(run("generate", "--title", "T")).rejects.toThrow("Rate limited");
  });

  it("throws error with status when detail is missing from failed response", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(run("generate", "--title", "T")).rejects.toThrow("Request failed with status 500");
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(run("list")).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("list")).rejects.toThrow("exit");
  });
});
