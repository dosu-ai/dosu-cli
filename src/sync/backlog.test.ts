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
vi.mock("./state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../sessions/scan";
import { VERSION } from "../version/version";
import { listSessionBacklog } from "./backlog";
import { INCOGNITO_MARKER } from "./incognito";
import { emptySyncState } from "./state";

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
  mockLoadSyncState.mockReturnValue(emptySyncState());
});

describe("listSessionBacklog", () => {
  it("scans only the sync's 30-day window, so the queue never lists what will not ship", () => {
    mockScan.mockReturnValue([]);
    const now = new Date("2026-09-25T12:00:00.000Z");

    listSessionBacklog(now);

    expect(mockScan).toHaveBeenCalledWith({ since: new Date("2026-08-26T12:00:00.000Z") });
  });

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
      ...emptySyncState(),
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
    mockLoadSyncState.mockReturnValue({ ...emptySyncState(), project_filter: ["/work/dosu-cli"] });
    mockScan.mockReturnValue([session({ id: "in-folder" }), session({ id: "elsewhere" })]);
    mockResolve.mockImplementation((s: AgentSession) =>
      s.id === "in-folder" ? "/work/dosu-cli/src" : "/elsewhere",
    );
    mockResolveRepo.mockImplementation((s: AgentSession) =>
      s.id === "in-folder" ? "github.com/dosu-ai/dosu-cli" : "github.com/dosu-ai/dosu",
    );

    expect(listSessionBacklog().queued.map((s) => s.id)).toEqual(["in-folder"]);
  });

  it("lists only sessions the ledger has no answer for, by the same rules the sync uses", () => {
    const shipped = session({ id: "shipped" });
    const grown = session({ id: "grown" });
    const trivialOld = session({ id: "trivial-by-an-older-cli" });
    const trivialNow = session({ id: "trivial-by-this-cli" });
    const fresh = session({ id: "never-seen" });
    const entry = (s: AgentSession, outcome: "shipped" | "trivial", cli_version = VERSION) => ({
      updated: s.updated,
      outcome,
      at: s.updated,
      cli_version,
    });
    mockLoadSyncState.mockReturnValue({
      ...emptySyncState(),
      sessions: {
        "cursor/shipped": entry(shipped, "shipped"),
        "cursor/grown": { ...entry(grown, "shipped"), updated: "2026-01-01T00:00:00.000Z" },
        "cursor/trivial-by-an-older-cli": entry(trivialOld, "trivial", "0.0.1"),
        "cursor/trivial-by-this-cli": entry(trivialNow, "trivial"),
      },
    });
    mockScan.mockReturnValue([shipped, grown, trivialOld, trivialNow, fresh]);

    expect(
      listSessionBacklog()
        .queued.map((s) => s.id)
        .sort(),
    ).toEqual(["grown", "never-seen", "trivial-by-an-older-cli"]);
    // Settled sessions never cost a repo lookup.
    expect(mockResolveRepo).toHaveBeenCalledTimes(3);
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
