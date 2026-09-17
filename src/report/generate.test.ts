import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  getConfigDir: () => "/tmp/dosu-report-test-config",
}));

vi.mock("../sessions/project-dir", () => ({
  createProjectDirResolver: () => ({
    resolve: (s: { project?: string }) => (s.project ? `/repos/${s.project}` : null),
    cached: () => null,
    flush: () => {},
  }),
}));

function wrapNotes<T>(notes: T[]) {
  return { notes, truncated: false };
}

const mockLoadSyncState = vi.fn();
vi.mock("../sync/watermark", () => ({
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

const mockScan = vi.fn();
vi.mock("../sessions/scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/scan")>()),
  scanAgentSessions: (...args: unknown[]) => mockScan(...args),
}));

const mockWrite = vi.fn();
vi.mock("./write", () => ({
  defaultReportPath: () => "/tmp/dosu-knowledge-report.html",
  writeAndOpenReport: (...args: unknown[]) => mockWrite(...args),
}));

import { emitKnowledgeReport } from "./generate";

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "dosu-report-gen-"));
  mockLoadConfig.mockReturnValue({
    schema_version: 2,
    active_account: { target: { org_name: "Acme" } },
  });
  mockLoadSyncState.mockReturnValue({
    schema_version: 1,
    watermark: null,
    consecutive_failures: 0,
  });
  mockScan.mockReturnValue([]);
  mockWrite.mockResolvedValue("/tmp/dosu-knowledge-report.html");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function claudeSession(id: string, lines: unknown[]) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return { id, harness: "claude" as const, path, updated: "2026-09-09T00:00:00.000Z" };
}

describe("emitKnowledgeReport", () => {
  it("renders fetched notes with traces from their referenced sessions only", async () => {
    const source = claudeSession("s1", [
      { type: "user", message: { content: "why does auth retry?" } },
      { type: "assistant", message: { content: [{ type: "text", text: "because 401" }] } },
    ]);
    const unrelated = claudeSession("noise", [
      { type: "user", message: { content: "completely different topic" } },
    ]);
    mockScan.mockReturnValue([source, unrelated]);
    mockWrite.mockImplementation(async (opts: { html: string; out?: string }) => {
      expect(opts.html).toContain("OAuth retry");
      expect(opts.html).toContain("Work to learn this");
      // Unreferenced local history must not leak into the report.
      expect(opts.html).not.toContain("completely different topic");
      return opts.out ?? "/tmp/x.html";
    });

    const out = await emitKnowledgeReport({
      fetchNotes: async () =>
        wrapNotes([
          {
            title: "OAuth retry",
            content: "Retry after 401.",
            transcript_id: "s1",
            at: "2026-09-09T10:00:00Z",
          },
        ]),
      out: join(dir, "report.html"),
      open: false,
    });
    expect(out).toBe(join(dir, "report.html"));
  });

  it("orders notes chronologically regardless of fetch order", async () => {
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html.indexOf("Older note")).toBeLessThan(opts.html.indexOf("Newer note"));
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({
      fetchNotes: async () =>
        wrapNotes([
          { title: "Newer note", content: "b", at: "2026-09-02T00:00:00Z" },
          { title: "Older note", content: "a", at: "2026-09-01T00:00:00Z" },
        ]),
      open: false,
    });
    expect(mockWrite).toHaveBeenCalled();
  });

  it("propagates fetch failures instead of rendering an empty page", async () => {
    await expect(
      emitKnowledgeReport({
        fetchNotes: async () => {
          throw new Error("Not signed in. Run `dosu setup` to connect an account first.");
        },
        open: false,
      }),
    ).rejects.toThrow(/Not signed in/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("summarizes the run's projects in the header instead of a note anchor", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_learning_tokens: 50_000,
    });
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("Dosu knowledge report — Acme");
      expect(opts.html).not.toContain("feat/report");
      expect(opts.html).toContain("0 sessions");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({
      fetchNotes: async () =>
        wrapNotes([
          { title: "Anchored", content: "Body.", repo: "git@x/y", branch: "feat/report" },
        ]),
      open: false,
    });
    expect(mockWrite).toHaveBeenCalled();
  });

  it("renders notes without transcripts as bare cards", async () => {
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("Unattributed");
      expect(opts.html).not.toContain("Work to learn this");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({
      fetchNotes: async () =>
        wrapNotes([{ title: "Unattributed", content: "No transcript.", at: "garbage-date" }]),
      open: false,
    });
    expect(mockWrite).toHaveBeenCalled();
  });

  it("accepts injected notes without fetching", async () => {
    const fetchNotes = vi.fn();
    await emitKnowledgeReport({ notes: [{ title: "A", content: "B" }], fetchNotes, open: false });
    expect(fetchNotes).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalled();
  });
});

describe("emitKnowledgeReport shipped sessions", () => {
  it("surfaces the ship watermark history's session links in the report", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      ship_transcripts: true,
      ship: {
        watermark: "2026-09-01T00:00:00.000Z",
        consecutive_failures: 0,
        total_shipped: 1,
        shipped_sessions: [
          {
            at: "2026-09-01T00:00:00.000Z",
            session: "claude/s1",
            task_id: "task-1",
            session_url: "https://app/memories/sessions/s1",
          },
        ],
      },
    });

    await emitKnowledgeReport({ notes: [] });

    const html = mockWrite.mock.calls[0][0].html as string;
    expect(html).toContain("Shipped to Dosu memory");
    expect(html).toContain("https://app/memories/sessions/s1");
  });

  it("an injected shipped list overrides the state file", async () => {
    await emitKnowledgeReport({
      notes: [],
      shipped: [
        {
          at: "2026-09-01T00:00:00.000Z",
          session: "cursor/injected",
          task_id: "task-9",
        },
      ],
    });

    const html = mockWrite.mock.calls[0][0].html as string;
    expect(html).toContain("cursor/injected");
  });

  it("renders no shipped section when nothing was ever shipped", async () => {
    await emitKnowledgeReport({ notes: [] });

    const html = mockWrite.mock.calls[0][0].html as string;
    expect(html).not.toContain("Shipped to Dosu memory");
  });
});
