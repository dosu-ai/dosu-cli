import { beforeEach, describe, expect, it, vi } from "vitest";

const mockScan = vi.fn();
vi.mock("../sessions/scan", () => ({
  scanAgentSessions: (...args: unknown[]) => mockScan(...args),
}));

const mockResolve = vi.fn();
const mockResolveRepo = vi.fn();
const mockFlush = vi.fn();
vi.mock("../sessions/project-dir", () => ({
  createProjectDirResolver: () => ({
    resolve: mockResolve,
    resolveRepo: mockResolveRepo,
    flush: mockFlush,
  }),
}));

// Keep the real gate and filter logic; only the persisted state read is faked.
const mockLoadSyncState = vi.fn();
vi.mock("./watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./watermark")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../sessions/scan";
import { listSessionBacklog } from "./backlog";
import { INCOGNITO_MARKER } from "./incognito";

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "3c2c12ad-b111-4444-8888-abcdefabcdef",
    harness: "cursor",
    path: "/tmp/log.jsonl",
    updated: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // quiet for an hour
    ...overrides,
  };
}

beforeEach(() => {
  mockScan.mockReset();
  mockResolve.mockReset();
  mockResolveRepo.mockReset().mockReturnValue("github.com/dosu-ai/dosu-cli");
  mockFlush.mockReset();
  mockLoadSyncState.mockReset();
  mockLoadSyncState.mockReturnValue({
    schema_version: 1,
    watermark: null,
    consecutive_failures: 0,
  });
});

describe("listSessionBacklog", () => {
  it("buckets quiet sessions as queued and fresh ones as open", () => {
    const quiet = session({ id: "quiet-1" });
    const fresh = session({ id: "fresh-1", updated: new Date().toISOString() });
    mockScan.mockReturnValue([quiet, fresh]);

    const backlog = listSessionBacklog();
    expect(backlog.queued.map((s) => s.id)).toEqual(["quiet-1"]);
    expect(backlog.open.map((s) => s.id)).toEqual(["fresh-1"]);
  });

  it("applies the persisted repo filter and drops sessions outside any repo", () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      repo_filter: ["github.com/dosu-ai/dosu-cli"],
    });
    mockScan.mockReturnValue([
      session({ id: "in-scope" }),
      session({ id: "other-repo" }),
      session({ id: "no-repo" }),
    ]);
    mockResolveRepo.mockImplementation((s: AgentSession) =>
      s.id === "in-scope"
        ? "github.com/dosu-ai/dosu-cli"
        : s.id === "other-repo"
          ? "github.com/dosu-ai/dosu"
          : null,
    );

    const backlog = listSessionBacklog();
    expect(backlog.queued.map((s) => s.id)).toEqual(["in-scope"]);
    expect(mockFlush).toHaveBeenCalled();
  });

  it("reads a legacy folder scope as the repos of its sessions", () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      project_filter: ["/work/dosu-cli"],
    });
    mockScan.mockReturnValue([session({ id: "in-folder" }), session({ id: "elsewhere" })]);
    mockResolve.mockImplementation((s: AgentSession) =>
      s.id === "in-folder" ? "/work/dosu-cli/src" : "/elsewhere",
    );
    mockResolveRepo.mockImplementation((s: AgentSession) =>
      s.id === "in-folder" ? "github.com/dosu-ai/dosu-cli" : "github.com/dosu-ai/dosu",
    );

    expect(listSessionBacklog().queued.map((s) => s.id)).toEqual(["in-folder"]);
  });

  it("sets aside every session from an agent saved as incognito", () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      incognito_agents: ["claude"],
    });
    mockScan.mockReturnValue([session({ id: "c1" }), session({ id: "k1", harness: "claude" })]);

    const backlog = listSessionBacklog();
    expect(backlog.queued.map((s) => s.id)).toEqual(["c1"]);
    expect(backlog.incognito?.map((s) => s.id)).toEqual(["k1"]);
  });

  it("sets incognito sessions aside from the queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "dosu-backlog-"));
    try {
      const markedPath = join(dir, "marked.jsonl");
      writeFileSync(
        markedPath,
        `${JSON.stringify({ role: "user", message: { content: `go ${INCOGNITO_MARKER}` } })}\n`,
      );
      const plain = session({ id: "plain" }); // path does not exist → not incognito
      const marked = session({ id: "marked", path: markedPath });
      mockScan.mockReturnValue([plain, marked]);

      const backlog = listSessionBacklog();
      expect(backlog.queued.map((s) => s.id)).toEqual(["plain"]);
      expect(backlog.incognito?.map((s) => s.id)).toEqual(["marked"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a failed scan as an empty backlog", () => {
    mockScan.mockImplementation(() => {
      throw new Error("fs exploded");
    });
    expect(listSessionBacklog()).toEqual({ queued: [], open: [], incognito: [] });
  });
});
