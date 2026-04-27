import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPromptGitHubDocsImport, mockTrpc } = vi.hoisted(() => ({
  mockPromptGitHubDocsImport: vi.fn(),
  mockTrpc: {
    dataSource: { list: { query: vi.fn() } },
    docImports: {
      listImportableGithubFiles: { query: vi.fn() },
      importGithubFiles: { mutate: vi.fn() },
      getImportStatus: { query: vi.fn() },
    },
    knowledgeStore: {
      getBySpaceId: { query: vi.fn() },
    },
  },
}));

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: {
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn(() => mockTrpc),
}));

vi.mock("./github-doc-import-prompt", () => ({
  promptGitHubDocsImport: (...args: unknown[]) => mockPromptGitHubDocsImport(...args),
}));

import * as p from "@clack/prompts";
import type { Config } from "../config/config";
import { stepImportGitHubDocs } from "./github-doc-import-step";

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    access_token: "tok",
    refresh_token: "ref",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    api_key: "sk_user_x",
    deployment_id: "dep-mcp",
    deployment_name: "Default MCP",
    org_id: "org-1",
    space_id: "space-1",
    ...overrides,
  };
}

describe("stepImportGitHubDocs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(p.isCancel).mockReturnValue(false);
    vi.mocked(p.select).mockResolvedValue("skip");
    mockPromptGitHubDocsImport.mockResolvedValue([]);
    mockTrpc.dataSource.list.query.mockResolvedValue([
      { provider_slug: "github", is_indexed: false },
    ]);
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([]);
    mockTrpc.knowledgeStore.getBySpaceId.query.mockResolvedValue({ id: "ks-1" });
    mockTrpc.docImports.importGithubFiles.mutate.mockResolvedValue({ task_id: "task-1" });
    mockTrpc.docImports.getImportStatus.query.mockResolvedValue({
      task_id: "task-1",
      state: "SUCCESS",
      detail: {
        message: "COMPLETED",
        knowledge_store_id: "ks-1",
        provider: "github",
        total: 1,
        completed: 1,
        failed: 0,
        documents: [
          {
            id: "file-1",
            title: "docs/auth/login.md",
            status: "SUCCESS",
          },
        ],
      },
      created_at: "2026-04-24T00:00:00Z",
      updated_at: "2026-04-24T00:00:02Z",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns advance=false when cfg has no org_id / space_id", async () => {
    const result = await stepImportGitHubDocs(makeCfg({ org_id: undefined, space_id: undefined }));

    expect(result.advance).toBe(false);
    expect(mockTrpc.docImports.listImportableGithubFiles.query).not.toHaveBeenCalled();
  });

  it("reads current importable docs immediately when not waiting for a fresh repo", async () => {
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/auth/login.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
      {
        id: "file-2",
        file_path: "README.md",
        repository_slug: "acme/api",
        is_synced: true,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1"]);

    const result = await stepImportGitHubDocs(makeCfg());

    expect(mockTrpc.docImports.listImportableGithubFiles.query).toHaveBeenCalledTimes(1);
    expect(mockTrpc.dataSource.list.query).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
    expect(mockPromptGitHubDocsImport).toHaveBeenCalledWith({
      repositories: [
        {
          slug: "acme/api",
          files: [
            { id: "file-1", path: "docs/auth/login.md", is_synced: false },
            { id: "file-2", path: "README.md", is_synced: true },
          ],
        },
      ],
    });
    expect(mockTrpc.knowledgeStore.getBySpaceId.query).toHaveBeenCalledWith({
      space_id: "space-1",
    });
    expect(mockTrpc.docImports.importGithubFiles.mutate).toHaveBeenCalledWith({
      knowledge_store_id: "ks-1",
      space_id: "space-1",
      file_ids: ["file-1"],
    });
    expect(mockTrpc.docImports.getImportStatus.query).toHaveBeenCalledWith("task-1");
    expect(result.advance).toBe(true);
  });

  it("waits for docs only when a fresh repo was connected in this run", async () => {
    mockTrpc.docImports.listImportableGithubFiles.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "file-1",
          file_path: "docs/auth/login.md",
          repository_slug: "acme/api",
          is_synced: false,
        },
        {
          id: "file-2",
          file_path: "README.md",
          repository_slug: "acme/api",
          is_synced: true,
        },
      ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1"]);

    const result = await stepImportGitHubDocs(makeCfg(), { waitForFreshDocs: true });

    expect(mockTrpc.docImports.listImportableGithubFiles.query).toHaveBeenCalledTimes(2);
    expect(mockPromptGitHubDocsImport).toHaveBeenCalledWith({
      repositories: [
        {
          slug: "acme/api",
          files: [
            { id: "file-1", path: "docs/auth/login.md", is_synced: false },
            { id: "file-2", path: "README.md", is_synced: true },
          ],
        },
      ],
    });
    expect(mockTrpc.knowledgeStore.getBySpaceId.query).toHaveBeenCalledWith({
      space_id: "space-1",
    });
    expect(mockTrpc.docImports.importGithubFiles.mutate).toHaveBeenCalledWith({
      knowledge_store_id: "ks-1",
      space_id: "space-1",
      file_ids: ["file-1"],
    });
    expect(mockTrpc.docImports.getImportStatus.query).toHaveBeenCalledWith("task-1");
    expect(result.advance).toBe(true);
  });

  it("treats an empty doc selection as skip and does not start an import", async () => {
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/setup.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue([]);

    const result = await stepImportGitHubDocs(makeCfg());

    expect(mockTrpc.docImports.importGithubFiles.mutate).not.toHaveBeenCalled();
    expect(result.advance).toBe(true);
  });

  it("polls import status until the task succeeds", async () => {
    vi.useFakeTimers();
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/auth/login.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1"]);
    mockTrpc.docImports.getImportStatus.query
      .mockResolvedValueOnce({
        task_id: "task-1",
        state: "PROGRESS",
        detail: {
          message: "STARTING",
          knowledge_store_id: "ks-1",
          provider: "github",
          total: 1,
          completed: 0,
          failed: 0,
          documents: [{ id: "file-1", title: "docs/auth/login.md", status: "PENDING" }],
        },
        created_at: "2026-04-24T00:00:00Z",
        updated_at: null,
      })
      .mockResolvedValueOnce({
        task_id: "task-1",
        state: "SUCCESS",
        detail: {
          message: "COMPLETED",
          knowledge_store_id: "ks-1",
          provider: "github",
          total: 1,
          completed: 1,
          failed: 0,
          documents: [{ id: "file-1", title: "docs/auth/login.md", status: "SUCCESS" }],
        },
        created_at: "2026-04-24T00:00:00Z",
        updated_at: "2026-04-24T00:00:02Z",
      });

    const resultPromise = stepImportGitHubDocs(makeCfg());
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    const spinnerInstance = vi.mocked(p.spinner).mock.results.at(-1)?.value;
    expect(spinnerInstance?.message).toHaveBeenCalledWith(
      "Preparing document import... 0/1 complete",
    );
    expect(spinnerInstance?.message).toHaveBeenCalledWith("Import complete (1/1)");
    expect(spinnerInstance?.stop).toHaveBeenCalledWith("Import complete");
    expect(p.log.success).toHaveBeenCalledWith(
      "Imported 1 doc.\nYour GitHub docs are ready, and onboarding is complete.",
    );
    expect(result.advance).toBe(true);
  });

  it("falls back to the client-selected count when server reports total=0 during STARTING", async () => {
    // Reproduces the bug where the progress spinner showed "0/0 complete"
    // because the server returns total=0 until it finishes enumerating files.
    vi.useFakeTimers();
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/a.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
      {
        id: "file-2",
        file_path: "docs/b.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1", "file-2"]);
    mockTrpc.docImports.getImportStatus.query
      .mockResolvedValueOnce({
        task_id: "task-1",
        state: "PROGRESS",
        detail: {
          message: "STARTING",
          knowledge_store_id: "ks-1",
          provider: "github",
          total: 0, // server hasn't enumerated yet
          completed: 0,
          failed: 0,
          documents: [],
        },
        created_at: "2026-04-24T00:00:00Z",
        updated_at: null,
      })
      .mockResolvedValueOnce({
        task_id: "task-1",
        state: "SUCCESS",
        detail: {
          message: "COMPLETED",
          knowledge_store_id: "ks-1",
          provider: "github",
          total: 2,
          completed: 2,
          failed: 0,
          documents: [
            { id: "file-1", title: "docs/a.md", status: "SUCCESS" },
            { id: "file-2", title: "docs/b.md", status: "SUCCESS" },
          ],
        },
        created_at: "2026-04-24T00:00:00Z",
        updated_at: "2026-04-24T00:00:02Z",
      });

    const resultPromise = stepImportGitHubDocs(makeCfg());
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    const spinnerInstance = vi.mocked(p.spinner).mock.results.at(-1)?.value;
    // Must use the client-known selection (2) rather than the server's 0.
    expect(spinnerInstance?.message).toHaveBeenCalledWith(
      "Preparing document import... 0/2 complete",
    );
    expect(spinnerInstance?.message).not.toHaveBeenCalledWith(expect.stringContaining("0/0"));
    expect(spinnerInstance?.message).toHaveBeenCalledWith("Import complete (2/2)");
    expect(result.advance).toBe(true);
  });

  it("surfaces partial failures after the import task completes", async () => {
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/auth/login.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
      {
        id: "file-2",
        file_path: "docs/setup.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1", "file-2"]);
    mockTrpc.docImports.getImportStatus.query.mockResolvedValue({
      task_id: "task-1",
      state: "FAILURE",
      detail: {
        message: "COMPLETED_WITH_ERRORS",
        knowledge_store_id: "ks-1",
        provider: "github",
        total: 2,
        completed: 1,
        failed: 1,
        documents: [
          { id: "file-1", title: "docs/auth/login.md", status: "SUCCESS" },
          { id: "file-2", title: "docs/setup.md", status: "FAILED", error: "boom" },
        ],
      },
      created_at: "2026-04-24T00:00:00Z",
      updated_at: "2026-04-24T00:00:02Z",
    });

    const result = await stepImportGitHubDocs(makeCfg());

    const spinnerInstance = vi.mocked(p.spinner).mock.results.at(-1)?.value;
    expect(spinnerInstance?.stop).toHaveBeenCalledWith("Import completed with issues");
    expect(p.log.warn).toHaveBeenCalledWith(
      "Imported 1 of 2 docs; 1 failed.\nYou can review the failed docs later, but onboarding is complete.",
    );
    expect(result.advance).toBe(true);
  });

  it("lets onboarding continue if progress polling becomes unavailable", async () => {
    vi.useFakeTimers();
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([
      {
        id: "file-1",
        file_path: "docs/auth/login.md",
        repository_slug: "acme/api",
        is_synced: false,
      },
    ]);
    mockPromptGitHubDocsImport.mockResolvedValue(["file-1"]);
    mockTrpc.docImports.getImportStatus.query.mockRejectedValue(new Error("network"));

    const resultPromise = stepImportGitHubDocs(makeCfg());
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await resultPromise;

    const spinnerInstance = vi.mocked(p.spinner).mock.results.at(-1)?.value;
    expect(spinnerInstance?.stop).toHaveBeenCalledWith("Stopped watching import progress");
    expect(p.log.info).toHaveBeenCalledWith(
      "The import is still running in the background.\nCheck status later with: dosu docs import-status task-1",
    );
    expect(result.advance).toBe(true);
  });

  it("shows an immediate empty state when no docs are currently importable", async () => {
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([]);

    const result = await stepImportGitHubDocs(makeCfg());

    expect(p.spinner).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
    expect(mockPromptGitHubDocsImport).not.toHaveBeenCalled();
    expect(result.advance).toBe(true);
  });

  it("offers skip after the 60-second scan timeout", async () => {
    vi.useFakeTimers();
    mockTrpc.docImports.listImportableGithubFiles.query.mockResolvedValue([]);
    vi.mocked(p.select).mockResolvedValue("skip");

    const resultPromise = stepImportGitHubDocs(makeCfg(), { waitForFreshDocs: true });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await resultPromise;

    expect(p.select).toHaveBeenCalledWith({
      message: "Still waiting for GitHub docs to become available",
      options: [
        { value: "retry", label: "Retry" },
        { value: "skip", label: "Skip for now" },
      ],
    });
    expect(mockPromptGitHubDocsImport).not.toHaveBeenCalled();
    expect(result.advance).toBe(true);
  });
});
