import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import type { ShippedSessionRecord, SyncState } from "../sync/watermark";
import { trace } from "./fixtures.test-utils";
import { buildKnowledgeReport, emitKnowledgeReport } from "./generate";
import type { ReportSession } from "./types";

const NOW = new Date("2026-10-06T12:00:00Z");

function config(target: Record<string, string | undefined> = {}): Config {
  return {
    schema_version: 2,
    active_account: {
      user_id: "u",
      session: { access_token: "t", refresh_token: "r", expires_at: 0 },
      target: { api_key: "sk_user_x", org_id: "org-1", org_name: "Acme", ...target },
    },
  } as Config;
}

function state(shipped: ShippedSessionRecord[]): SyncState {
  return { schema_version: 2, watermark: null, consecutive_failures: 0, shipped_sessions: shipped };
}

function shipped(session: string, daysAgo: number): ShippedSessionRecord {
  return {
    at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    session,
    task_id: "t",
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const fetchSessions = vi.fn(async (records: ShippedSessionRecord[]) =>
    records.map<ReportSession>((r) => ({
      sessionId: r.session.split("/")[1],
      harness: r.session.split("/")[0],
      ...(r.project ? { project: r.project } : {}),
      shippedAt: r.at,
      state: "complete",
      trace: trace(r.session.split("/")[1]),
    })),
  );
  return {
    loadConfig: () => config(),
    loadState: () => state([shipped("claude/recent", 2), shipped("codex/old", 45)]),
    backendUrl: "https://api.test",
    appUrl: "https://app.test",
    now: () => NOW,
    fetchSessions,
    ...overrides,
  };
}

describe("buildKnowledgeReport", () => {
  it("looks up only the sessions shipped within the period, with the install's credentials", async () => {
    const d = deps();

    const report = await buildKnowledgeReport({ days: 30, ...d });

    expect(d.fetchSessions).toHaveBeenCalledWith([shipped("claude/recent", 2)], {
      apiKey: "sk_user_x",
      orgId: "org-1",
      backendUrl: "https://api.test",
    });
    expect(report).toMatchObject({ days: 30, orgName: "Acme", appUrl: "https://app.test" });
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["recent"]);
  });

  it("names each session's project by its folder, not the agent's path slug", async () => {
    const d = deps({
      loadState: () =>
        state([{ ...shipped("claude/recent", 2), project: "-Users-me-dosu-backend" }]),
      projectName: (slug: string) => (slug === "-Users-me-dosu-backend" ? "backend" : slug),
    });

    const report = await buildKnowledgeReport({ days: 30, ...d });

    expect(report.sessions[0].project).toBe("backend");
  });

  it("widens with --days", async () => {
    const d = deps();

    const report = await buildKnowledgeReport({ days: 60, ...d });

    expect(report.sessions.map((s) => s.sessionId)).toEqual(["recent", "old"]);
  });

  it("does not call the API when nothing was shipped in the period", async () => {
    const d = deps({ loadState: () => state([shipped("codex/old", 45)]) });

    const report = await buildKnowledgeReport({ days: 30, ...d });

    expect(d.fetchSessions).not.toHaveBeenCalled();
    expect(report.sessions).toEqual([]);
  });

  it.each([
    ["no API key", { api_key: undefined }],
    ["no organization", { org_id: undefined }],
  ])("asks the user to run setup with %s", async (_label, target) => {
    const d = deps({ loadConfig: () => config(target) });

    await expect(buildKnowledgeReport({ days: 30, ...d })).rejects.toThrow(/dosu setup/);
  });

  it("refuses OSS mode, which has no Dosu memory", async () => {
    const d = deps({ loadConfig: () => ({ ...config(), mode: "oss" }) });

    await expect(buildKnowledgeReport({ days: 30, ...d })).rejects.toThrow(/memory/);
  });
});

describe("emitKnowledgeReport", () => {
  it("writes the HTML and returns its path without opening it when asked not to", async () => {
    const write = vi.fn(async (opts: { html: string; out?: string; open?: boolean }) => {
      expect(opts.html).toContain("What your agent sessions taught Dosu");
      expect(opts.open).toBe(false);
      return opts.out ?? "/tmp/x.html";
    });

    const path = await emitKnowledgeReport({
      days: 30,
      out: "/tmp/r.html",
      open: false,
      write,
      ...deps(),
    });

    expect(path).toBe("/tmp/r.html");
  });
});
