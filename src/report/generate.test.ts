import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

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
  dir = mkdtempSync(join(tmpdir(), "dosu-report-gen-"));
  mockLoadConfig.mockReturnValue({
    schema_version: 2,
    active_account: { target: { org_name: "Acme" } },
  });
  mockLoadSyncState.mockReturnValue({
    schema_version: 1,
    watermark: null,
    consecutive_failures: 0,
    written_notes: [],
  });
  mockScan.mockReturnValue([]);
  mockWrite.mockResolvedValue("/tmp/dosu-knowledge-report.html");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("emitKnowledgeReport", () => {
  it("builds HTML from captured notes and scanned sessions", async () => {
    const path = join(dir, "s1.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "user", message: { content: "why does auth retry?" } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "because 401" }] },
        }),
      ].join("\n"),
    );
    const session = {
      id: "s1",
      harness: "claude" as const,
      path,
      updated: "2026-09-09T00:00:00.000Z",
    };
    mockWrite.mockImplementation(async (opts: { html: string; out?: string }) => {
      expect(opts.html).toContain("OAuth refresh");
      expect(opts.html).toContain("Estimated context savings");
      expect(opts.html).toContain("Notes written to Dosu");
      return opts.out ?? "/tmp/x.html";
    });

    const out = await emitKnowledgeReport({
      notes: [{ title: "OAuth refresh", content: "Retry after 401.", transcript_id: "s1" }],
      sessions: [session],
      out: join(dir, "report.html"),
      open: false,
    });
    expect(out).toBe(join(dir, "report.html"));
    expect(mockWrite).toHaveBeenCalled();
  });

  it("uses persisted written_notes after a drain when notes are not injected", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_learning_tokens: 50_000,
      written_notes: [
        {
          title: "Persisted note",
          content: "From the watermark.",
          transcript_id: "s1",
          status: "written",
          at: "2026-09-09T00:00:00.000Z",
        },
      ],
    });
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("Persisted note");
      expect(opts.html).toContain("Notes written to Dosu");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({ open: false });
    expect(mockWrite).toHaveBeenCalled();
  });

  it("merges backend backfill notes under the local window when none are injected", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      written_notes: [
        {
          title: "Local capture",
          content: "From the gate.",
          status: "written",
          at: "2026-09-09T00:00:00.000Z",
        },
      ],
    });
    const fetchRemote = vi.fn().mockResolvedValue([
      {
        title: "Historical note",
        content: "Mined before capture existed.",
        status: "written",
        at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("Local capture");
      expect(opts.html).toContain("Historical note");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({ open: false, fetchRemote });
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalled();
  });

  it("skips the backend fetch when notes are injected explicitly", async () => {
    const fetchRemote = vi.fn();
    await emitKnowledgeReport({
      notes: [{ title: "Injected", content: "Direct." }],
      open: false,
      fetchRemote,
    });
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("renders an empty report when no notes were injected or persisted", async () => {
    mockLoadSyncState.mockReturnValue({
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
    });
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("No write_knowledge payloads yet");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({ open: false });
    expect(mockWrite).toHaveBeenCalled();
  });

  it("keeps all scanned sessions when notes have no transcript ids", async () => {
    const session = {
      id: "s1",
      harness: "claude" as const,
      path: join(dir, "missing.jsonl"),
      updated: "2026-09-09T00:00:00.000Z",
    };
    writeFileSync(session.path, "");
    mockScan.mockReturnValue([session]);
    mockLoadConfig.mockReturnValue({ schema_version: 2, active_account: { target: {} } });
    mockWrite.mockImplementation(async (opts: { html: string }) => {
      expect(opts.html).toContain("Dosu knowledge report — Your team");
      expect(opts.html).toContain("git@x/y");
      expect(opts.html).toContain("feat/report");
      return "/tmp/x.html";
    });
    await emitKnowledgeReport({
      notes: [
        { title: "Unanchored", content: "No session.", repo: "git@x/y", branch: "feat/report" },
      ],
      open: false,
    });
  });

  it("falls back to every scanned session when ids do not match", async () => {
    const session = {
      id: "other",
      harness: "claude" as const,
      path: join(dir, "s.jsonl"),
      updated: "2026-09-09T00:00:00.000Z",
    };
    writeFileSync(session.path, "");
    await emitKnowledgeReport({
      notes: [{ title: "A", content: "B", transcript_id: "missing" }],
      sessions: [session],
      open: false,
    });
    expect(mockWrite).toHaveBeenCalled();
  });
});
