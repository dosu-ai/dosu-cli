import { beforeEach, describe, expect, it, vi } from "vitest";

const mockScan = vi.fn();
vi.mock("../sessions/scan", () => ({
  scanAgentSessions: (...args: unknown[]) => mockScan(...args),
}));

const mockResolve = vi.fn();
const mockFlush = vi.fn();
vi.mock("../sessions/project-dir", () => ({
  createProjectDirResolver: () => ({ resolve: mockResolve, flush: mockFlush }),
}));

// Keep the real gate and filter logic; only the persisted state read is faked.
const mockLoadSyncState = vi.fn();
vi.mock("./watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./watermark")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

import type { AgentSession } from "../sessions/scan";
import { listSessionBacklog } from "./backlog";

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

  it("applies the persisted project filter through the dir resolver", () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      project_filter: ["/work/dosu-cli"],
    });
    const inScope = session({ id: "in-scope" });
    const outOfScope = session({ id: "out-of-scope" });
    mockScan.mockReturnValue([inScope, outOfScope]);
    mockResolve.mockImplementation((s: AgentSession) =>
      s.id === "in-scope" ? "/work/dosu-cli" : "/elsewhere",
    );

    const backlog = listSessionBacklog();
    expect(backlog.queued.map((s) => s.id)).toEqual(["in-scope"]);
    expect(mockFlush).toHaveBeenCalled();
  });

  it("reads a failed scan as an empty backlog", () => {
    mockScan.mockImplementation(() => {
      throw new Error("fs exploded");
    });
    expect(listSessionBacklog()).toEqual({ queued: [], open: [] });
  });
});
