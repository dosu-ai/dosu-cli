import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { SyncStatus } from "../sync/status";
import type { SyncState } from "../sync/watermark";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./alt-screen";
import {
  ANALYTICS_VIEW_LINES,
  analyticsRows,
  fetchPageStats,
  type PageStats,
  reduceAnalyticsViewKey,
  renderAnalyticsFrame,
  runAnalyticsView,
  windowReport,
} from "./analytics-view";
import { frameTopMargin } from "./layout";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

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

function makeStatus(state: SyncState = emptyState()): SyncStatus {
  return { running: false, state, recentActivity: [] };
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

describe("reduceAnalyticsViewKey", () => {
  it("goes back on q, esc, and ctrl-c", () => {
    expect(reduceAnalyticsViewKey("q")).toBe("back");
    expect(reduceAnalyticsViewKey(ESC)).toBe("back");
    expect(reduceAnalyticsViewKey(CTRL_C)).toBe("back");
  });

  it("scrolls on the up/down arrows and k/j", () => {
    expect(reduceAnalyticsViewKey(`${ESC}[A`)).toBe("up");
    expect(reduceAnalyticsViewKey("k")).toBe("up");
    expect(reduceAnalyticsViewKey(`${ESC}[B`)).toBe("down");
    expect(reduceAnalyticsViewKey("j")).toBe("down");
  });

  it("ignores other keys", () => {
    expect(reduceAnalyticsViewKey("x")).toBe("none");
    expect(reduceAnalyticsViewKey("\t")).toBe("none");
  });
});

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

describe("renderAnalyticsFrame", () => {
  it("titles the screen and shows the report with the key legend", () => {
    const frame = stripAnsi(renderAnalyticsFrame(reportState(), 0));
    expect(frame).toContain("Analytics");
    expect(frame).toContain("Sessions mined");
    expect(frame).toContain("\u2191\u2193 scroll \u00B7 esc back");
  });

  it("shows an empty message before the first run", () => {
    const frame = stripAnsi(renderAnalyticsFrame(emptyState(), 0));
    expect(frame).toContain("No analytics yet");
  });

  it("reports scrollback below when the report overflows the window", () => {
    // Enough per-project rows to overflow: rows = 3 stat lines +
    // blank + heading + 8 projects = 13 > the 12-line window.
    const state: SyncState = {
      ...reportState(),
      mined_sessions: Array.from({ length: 9 }, (_, i) => ({
        at: "2026-09-02T23:00:00.000Z",
        session: `cursor/s${i}`,
        project: `project-${i}`,
      })),
    };
    const rows = analyticsRows(state);
    expect(rows.length).toBeGreaterThan(ANALYTICS_VIEW_LINES);
    const top = stripAnsi(renderAnalyticsFrame(state, 0));
    expect(top).toContain(`\u2193 ${rows.length - ANALYTICS_VIEW_LINES} more`);
    const scrolled = stripAnsi(renderAnalyticsFrame(state, 1));
    expect(scrolled).toContain("\u2191 1 earlier");
  });
});

// ---------------------------------------------------------------------------
// runAnalyticsView — driven through fake streams and timers
// ---------------------------------------------------------------------------

interface FakeInput extends EventEmitter {
  isTTY: boolean;
  isRaw?: boolean;
  setRawMode: (raw: boolean) => void;
  resume: () => void;
  pause: () => void;
}

function fakeIO(inputOverrides: Partial<FakeInput> = {}) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
    },
    resume() {},
    pause() {},
    ...inputOverrides,
  }) as unknown as NodeJS.ReadStream;

  const written: string[] = [];
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  }) as unknown as NodeJS.WriteStream;

  return { input, output, written };
}

describe("runAnalyticsView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await runAnalyticsView({ input, output });
    expect(written).toEqual([]);
  });

  it("takes over the screen, renders the report, and exits on q", async () => {
    const { input, output, written } = fakeIO();

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      loadPageStats: async () => null,
      pollMs: 100,
    });

    expect(written.join("")).toContain(ALT_SCREEN_ENTER);
    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("Sessions mined");
    expect(rendered).toContain("558");

    input.emit("data", "q");
    await view;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
    expect(written.join("")).toContain(ALT_SCREEN_EXIT);
  });

  it("scrolls the overflowing report with the arrows", async () => {
    const { input, output, written } = fakeIO();
    const state: SyncState = {
      ...reportState(),
      mined_sessions: Array.from({ length: 9 }, (_, i) => ({
        at: "2026-09-02T23:00:00.000Z",
        session: `cursor/s${i}`,
        project: `project-${i}`,
      })),
    };

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(state),
      loadPageStats: async () => null,
      pollMs: 100,
    });

    // ↑ at the top is a no-op; ↓ walks toward the per-project tail.
    input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.join(""))).not.toContain("\u2191 1 earlier");
    input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("\u2191 1 earlier");
    input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.at(-1) ?? "")).not.toContain("\u2191 1 earlier");

    input.emit("data", "q");
    await view;
  });

  it("skips the terminal write when a poll produces an identical frame", async () => {
    const { input, output, written } = fakeIO();
    let notes = 1;

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus({ ...emptyState(), total_mined: 1, total_notes: notes }),
      loadPageStats: async () => null,
      pollMs: 100,
    });

    const afterFirstDraw = written.length;
    // Nothing changes across several polls: no new writes.
    vi.advanceTimersByTime(300);
    expect(written.length).toBe(afterFirstDraw);

    // A completed batch changes the state: the next poll repaints.
    notes = 2;
    vi.advanceTimersByTime(100);
    expect(written.length).toBeGreaterThan(afterFirstDraw);
    expect(stripAnsi(written.join(""))).toContain("2");

    input.emit("data", "q");
    await view;
  });

  it("repaints on terminal resize even when the frame string is unchanged", async () => {
    const { input, output, written } = fakeIO();

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(),
      loadPageStats: async () => null,
      pollMs: 100,
    });

    const afterFirstDraw = written.length;
    vi.advanceTimersByTime(100);
    expect(written.length).toBe(afterFirstDraw);

    output.emit("resize");
    expect(written.length).toBeGreaterThan(afterFirstDraw);

    input.emit("data", "q");
    await view;
    // The listener is removed on exit: a late resize writes nothing more.
    const afterExit = written.length;
    output.emit("resize");
    expect(written.length).toBe(afterExit);
  });

  it("pads a fixed top margin — no vertical centering, so the frame never jiggles", async () => {
    const { input, output, written } = fakeIO();

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(),
      loadPageStats: async () => null,
      pollMs: 100,
    });

    // The paint starts at home followed by exactly the height-scaled cleared
    // blank rows (+1 to match the home banner's leading blank) — the fake
    // output has no rows, so the 24-row default applies.
    const first = written.join("");
    const blankRun = first.match(new RegExp(`${ESC}\\[H((?:${ESC}\\[K\\n)+)`));
    expect(blankRun).not.toBeNull();
    const blanks = (blankRun?.[1] ?? "").split("\n").length - 1;
    expect(blanks).toBe(frameTopMargin(24) + 1);

    input.emit("data", "q");
    await view;
  });

  it("repaints with the page sections once the backend stats land", async () => {
    const { input, output, written } = fakeIO();

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      loadPageStats: async () => pageStats(),
      pollMs: 100,
    });

    // The first paint is local-only; the loader's microtask hasn't run yet.
    expect(stripAnsi(written.join(""))).not.toContain("Top cited pages");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const rendered = stripAnsi(written.at(-1) ?? "");
    expect(rendered).toContain("Top cited pages (30d)");
    // The report grew past the window; the tail is reachable by scrolling.
    input.emit("data", `${ESC}[B`);
    input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("Recently updated pages");

    input.emit("data", "q");
    await view;
  });

  it("drops page stats that land after the user already left", async () => {
    const { input, output, written } = fakeIO();
    let resolveStats: (stats: PageStats) => void = () => {};

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      loadPageStats: () => new Promise((resolve) => (resolveStats = resolve)),
      pollMs: 100,
    });

    input.emit("data", "q");
    await view;
    const afterExit = written.length;

    resolveStats(pageStats());
    await Promise.resolve();
    await Promise.resolve();
    expect(written.length).toBe(afterExit);
    expect(stripAnsi(written.join(""))).not.toContain("Top cited pages");
  });

  // -------------------------------------------------------------------------
  // Default loader (no loadPageStats injected): stored login → typed client.
  // -------------------------------------------------------------------------

  /** Let the default loader's promise chain settle under fake timers. */
  async function microtasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  it("loads page stats from the stored login by default", async () => {
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
    const { input, output, written } = fakeIO();

    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      pollMs: 100,
    });
    await microtasks();

    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("Top cited pages (30d)");

    input.emit("data", "q");
    await view;
  });

  it("fails open when there is no Library or the config is unreadable", async () => {
    // No space configured → the loader resolves null without a client.
    mockLoadConfig.mockReturnValue(
      makeTestConfig({ access_token: "a", refresh_token: "r", expires_at: 0 }),
    );
    mockCreateTypedClient.mockClear();
    const { input, output, written } = fakeIO();
    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      pollMs: 100,
    });
    await microtasks();
    expect(mockCreateTypedClient).not.toHaveBeenCalled();
    expect(stripAnsi(written.join(""))).not.toContain("Top cited pages");
    input.emit("data", "q");
    await view;

    // Unreadable config → same silent degradation.
    mockLoadConfig.mockImplementation(() => {
      throw new Error("signed out");
    });
    const second = fakeIO();
    const secondView = runAnalyticsView({
      input: second.input,
      output: second.output,
      getStatus: () => makeStatus(reportState()),
      pollMs: 100,
    });
    await microtasks();
    expect(stripAnsi(second.written.join(""))).not.toContain("Top cited pages");
    second.input.emit("data", "q");
    await secondView;
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
    const { input, output, written } = fakeIO();
    const view = runAnalyticsView({
      input,
      output,
      getStatus: () => makeStatus(reportState()),
      pollMs: 100,
    });
    await microtasks();
    expect(stripAnsi(written.join(""))).not.toContain("Top cited pages");
    input.emit("data", "q");
    await view;
  });

  it("stops polling after the user goes back", async () => {
    const { input, output } = fakeIO();
    const getStatus = vi.fn(() => makeStatus());

    const view = runAnalyticsView({
      input,
      output,
      getStatus,
      loadPageStats: async () => null,
      pollMs: 100,
    });

    input.emit("data", ESC);
    await view;
    const callsAtExit = getStatus.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(getStatus.mock.calls.length).toBe(callsAtExit);
  });
});
