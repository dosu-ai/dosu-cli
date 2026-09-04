import { describe, expect, it, vi } from "vitest";

// The default page-stats loader reads the stored login and builds a real
// client; override just those two entry points so the glue is testable.
const mockLoadConfig = vi.fn();
vi.mock("../config/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config")>()),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));
const mockCreateTypedClient = vi.fn();
vi.mock("../client/trpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/trpc")>()),
  createTypedClient: (...args: unknown[]) => mockCreateTypedClient(...args),
}));

import { makeTestConfig } from "../config/config.test-utils";
import type { SyncState } from "../sync/watermark";
import {
  analyticsRows,
  fetchPageStats,
  loadPageStatsFromConfig,
  type PageStats,
  windowReport,
} from "./analytics-view";

function emptyState(): SyncState {
  return { schema_version: 1, watermark: null, consecutive_failures: 0 };
}

/** A state carrying the full savings model plus per-project history. */
function reportState(): SyncState {
  return {
    schema_version: 1,
    watermark: "2026-09-02T23:00:00.000Z",
    consecutive_failures: 0,
    mined_sessions: [
      { at: "2026-09-02T23:00:00.000Z", session: "cursor/abc", project: "dosu-cli" },
      { at: "2026-09-02T23:10:00.000Z", session: "cursor/def", project: "dosu-cli" },
      { at: "2026-09-02T23:20:00.000Z", session: "claude/ghi" },
    ],
    total_mined: 558,
    total_notes: 42,
    total_learning_tokens: 1_200_000,
  };
}

/** Page analytics as the backend loader returns them. */
function pageStats(): PageStats {
  return {
    topUpdated: [
      { title: "Release process", updated_at: "2026-09-03T10:00:00.000Z" },
      { title: "OAuth refresh token expiry gotcha", updated_at: "2026-09-02T09:00:00.000Z" },
    ],
    topCited: [
      { title: "OAuth refresh token expiry gotcha", citation_count: 12 },
      { title: "Release process", citation_count: 4 },
    ],
  };
}

describe("analyticsRows", () => {
  it("renders the mining totals with per-project history", () => {
    const rows = analyticsRows(reportState()).join("\n");
    expect(rows).toContain("Sessions mined");
    expect(rows).toContain("558");
    expect(rows).toContain("Suggested pages");
    expect(rows).toContain("42");
    expect(rows).toContain("Investigation distilled");
    expect(rows).toContain("Mined by project");
    expect(rows).toContain("dosu-cli");
    expect(rows).toContain("(unknown)");
  });

  it("returns nothing before the first run has anything to report", () => {
    expect(analyticsRows(emptyState())).toEqual([]);
  });

  it("omits the token row when no learning tokens are known", () => {
    const rows = analyticsRows({ ...emptyState(), total_mined: 3, total_notes: 2 }).join("\n");
    expect(rows).toContain("Sessions mined");
    expect(rows).not.toContain("Investigation distilled");
  });

  it("appends the page sections when page stats are in", () => {
    const rows = analyticsRows(reportState(), pageStats()).join("\n");
    expect(rows).toContain("Top cited pages (30d)");
    expect(rows).toContain("OAuth refresh token exp\u2026");
    expect(rows).toContain("12");
    expect(rows).toContain("Recently updated pages");
    expect(rows).toContain("Release process");
    expect(rows).toContain("2026-09-03");
  });

  it("shows page sections even before the first mining run", () => {
    const rows = analyticsRows(emptyState(), pageStats());
    expect(rows[0]).toContain("Top cited pages");
    expect(rows.join("\n")).not.toContain("Sessions mined");
  });

  it("omits empty page sections", () => {
    const rows = analyticsRows(reportState(), {
      topUpdated: [],
      topCited: [],
    }).join("\n");
    expect(rows).not.toContain("Top cited pages");
    expect(rows).not.toContain("Recently updated pages");
  });
});

describe("fetchPageStats", () => {
  /** A typed-client double covering just the three procedures the fetch uses. */
  function fakeClient(overrides: {
    store?: { id: string } | null;
    listWithTags?: ReturnType<typeof vi.fn>;
    topCited?: ReturnType<typeof vi.fn>;
  }) {
    const getBySpaceId = vi.fn(async () =>
      "store" in overrides ? overrides.store : { id: "ks-1" },
    );
    const listWithTags =
      overrides.listWithTags ??
      vi.fn(async () => ({
        data: [
          {
            id: "p-1",
            title: "Release process",
            type: "document",
            published: true,
            updated_at: "2026-09-03T10:00:00.000Z",
          },
          {
            id: "p-2",
            title: "",
            type: "document",
            published: true,
            updated_at: "2026-09-02T09:00:00.000Z",
          },
        ],
        pagination: { limit: 5, offset: 0, total: 2, totalPages: 1 },
      }));
    const topCited =
      overrides.topCited ??
      vi.fn(async () => [{ page_id: "p-1", title: "Release process", citation_count: 7 }]);
    const client = {
      knowledgeStore: { getBySpaceId: { query: getBySpaceId } },
      page: { listWithTags: { query: listWithTags }, topCited: { query: topCited } },
    };
    return {
      client: client as unknown as import("../client/trpc").TypedClient,
      getBySpaceId,
      listWithTags,
      topCited,
    };
  }

  it("returns both sections, falling back to (untitled)", async () => {
    const { client, topCited } = fakeClient({});
    const stats = await fetchPageStats(client, "space-1");
    expect(stats).toEqual({
      topUpdated: [
        { title: "Release process", updated_at: "2026-09-03T10:00:00.000Z" },
        { title: "(untitled)", updated_at: "2026-09-02T09:00:00.000Z" },
      ],
      topCited: [{ title: "Release process", citation_count: 7 }],
    });
    expect(topCited).toHaveBeenCalledWith({
      knowledge_store_id: "ks-1",
      days: expect.any(Number),
      limit: expect.any(Number),
    });
  });

  it("returns null when the space has no knowledge store", async () => {
    const { client } = fakeClient({ store: null });
    expect(await fetchPageStats(client, "space-1")).toBeNull();
  });

  it("degrades topCited to empty when the backend lacks the procedure", async () => {
    const { client } = fakeClient({
      topCited: vi.fn(async () => {
        throw new Error("No procedure found on path 'page.topCited'");
      }),
    });
    const stats = await fetchPageStats(client, "space-1");
    expect(stats?.topCited).toEqual([]);
    expect(stats?.topUpdated).toHaveLength(2);
  });

  it("propagates a page-list failure so the caller can fail open", async () => {
    const { client } = fakeClient({
      listWithTags: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await expect(fetchPageStats(client, "space-1")).rejects.toThrow("network down");
  });
});

describe("loadPageStatsFromConfig", () => {
  it("loads page stats from the stored login", async () => {
    mockLoadConfig.mockReturnValue(
      makeTestConfig({
        access_token: "a",
        refresh_token: "r",
        expires_at: Date.now() + 60_000,
        space_id: "space-1",
      }),
    );
    mockCreateTypedClient.mockReturnValue({
      knowledgeStore: { getBySpaceId: { query: vi.fn(async () => ({ id: "ks-1" })) } },
      page: {
        listWithTags: {
          query: vi.fn(async () => ({
            data: [
              {
                id: "p-1",
                title: "Release process",
                type: "document",
                published: true,
                updated_at: "2026-09-03T10:00:00.000Z",
              },
            ],
            pagination: { limit: 5, offset: 0, total: 1, totalPages: 1 },
          })),
        },
        topCited: {
          query: vi.fn(async () => [
            { page_id: "p-1", title: "Release process", citation_count: 3 },
          ]),
        },
      },
    });

    const stats = await loadPageStatsFromConfig();
    expect(stats?.topCited).toEqual([{ title: "Release process", citation_count: 3 }]);
    expect(stats?.topUpdated).toHaveLength(1);
  });

  it("fails open when there is no Library or the config is unreadable", async () => {
    // No space configured → resolves null without ever building a client.
    mockLoadConfig.mockReturnValue(
      makeTestConfig({ access_token: "a", refresh_token: "r", expires_at: 0 }),
    );
    mockCreateTypedClient.mockClear();
    expect(await loadPageStatsFromConfig()).toBeNull();
    expect(mockCreateTypedClient).not.toHaveBeenCalled();

    // Unreadable config → same silent degradation.
    mockLoadConfig.mockImplementation(() => {
      throw new Error("signed out");
    });
    expect(await loadPageStatsFromConfig()).toBeNull();
  });

  it("fails open when the backend fetch rejects", async () => {
    mockLoadConfig.mockReturnValue(
      makeTestConfig({
        access_token: "a",
        refresh_token: "r",
        expires_at: Date.now() + 60_000,
        space_id: "space-1",
      }),
    );
    mockCreateTypedClient.mockReturnValue({
      knowledgeStore: {
        getBySpaceId: {
          query: vi.fn(async () => {
            throw new Error("network down");
          }),
        },
      },
      page: {},
    });
    expect(await loadPageStatsFromConfig()).toBeNull();
  });
});

describe("windowReport", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `row ${i}`);

  it("anchors to the top at scroll 0 — a report reads top-down", () => {
    const { visible, above, below } = windowReport(lines, 0, 10);
    expect(visible).toEqual(lines.slice(0, 10));
    expect(above).toBe(0);
    expect(below).toBe(15);
  });

  it("scrolls down toward the tail", () => {
    const { visible, above, below } = windowReport(lines, 5, 10);
    expect(visible).toEqual(lines.slice(5, 15));
    expect(above).toBe(5);
    expect(below).toBe(10);
  });

  it("clamps scroll past the last line", () => {
    const { visible, above, below } = windowReport(lines, 999, 10);
    expect(visible).toEqual(lines.slice(15));
    expect(above).toBe(15);
    expect(below).toBe(0);
  });

  it("shows everything when the report fits the window", () => {
    const { visible, above, below } = windowReport(["a", "b"], 3, 10);
    expect(visible).toEqual(["a", "b"]);
    expect(above).toBe(0);
    expect(below).toBe(0);
  });
});
