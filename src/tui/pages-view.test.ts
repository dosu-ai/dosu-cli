import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { TypedClient } from "../client/trpc";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./alt-screen";
import {
  type LibraryPage,
  makeLibraryPagesLoader,
  PAGE_BODY_LINES,
  PAGES_FETCH_BATCH,
  PAGES_VIEW_LINES,
  type PagesBatch,
  pageRows,
  reducePagesViewKey,
  renderPageFrame,
  renderPagesFrame,
  runPagesView,
  windowSelection,
  wrapBody,
} from "./pages-view";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

function page(overrides: Partial<LibraryPage> = {}): LibraryPage {
  return {
    id: "page-1",
    title: "OAuth refresh token expiry",
    type: "document",
    published: true,
    updated_at: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("reducePagesViewKey", () => {
  it("goes back on q, esc, and ctrl-c", () => {
    expect(reducePagesViewKey("q")).toBe("back");
    expect(reducePagesViewKey(ESC)).toBe("back");
    expect(reducePagesViewKey(CTRL_C)).toBe("back");
  });

  it("scrolls on the up/down arrows and k/j", () => {
    expect(reducePagesViewKey(`${ESC}[A`)).toBe("up");
    expect(reducePagesViewKey("k")).toBe("up");
    expect(reducePagesViewKey(`${ESC}[B`)).toBe("down");
    expect(reducePagesViewKey("j")).toBe("down");
  });

  it("opens the selection on enter", () => {
    expect(reducePagesViewKey("\r")).toBe("open");
    expect(reducePagesViewKey("\n")).toBe("open");
  });

  it("ignores other keys", () => {
    expect(reducePagesViewKey("x")).toBe("none");
    expect(reducePagesViewKey("\t")).toBe("none");
  });
});

describe("makeLibraryPagesLoader", () => {
  /** A typed-client double covering just the two procedures the fetch uses. */
  function fakeClient(total: number, storeId = "ks-1") {
    const all = Array.from({ length: total }, (_, i) => ({
      id: `p-${i}`,
      title: `Page ${i}`,
      type: "document",
      published: i % 2 === 0,
      updated_at: "2026-09-01T00:00:00.000Z",
    }));
    const listWithTags = vi.fn(
      async ({ limit = PAGES_FETCH_BATCH, offset = 0 }: { limit?: number; offset?: number }) => ({
        data: all.slice(offset, offset + limit),
        pagination: { limit, offset, total, totalPages: Math.ceil(total / limit) },
      }),
    );
    const getBySpaceId = vi.fn(async () => ({ id: storeId }));
    const client = {
      knowledgeStore: { getBySpaceId: { query: getBySpaceId } },
      page: { listWithTags: { query: listWithTags } },
    };
    return { client: client as unknown as TypedClient, listWithTags, getBySpaceId };
  }

  it("fetches one batch at the given offset and reports the backend total", async () => {
    const total = PAGES_FETCH_BATCH * 2 + 5;
    const { client, listWithTags } = fakeClient(total);
    const load = makeLibraryPagesLoader(client, "space-1");

    const first = await load(0);
    expect(first.pages).toHaveLength(PAGES_FETCH_BATCH);
    expect(first.total).toBe(total);
    expect(first.pages[0]).toEqual({
      id: "p-0",
      title: "Page 0",
      type: "document",
      published: true,
      updated_at: "2026-09-01T00:00:00.000Z",
    });

    const last = await load(PAGES_FETCH_BATCH * 2);
    expect(last.pages).toHaveLength(5);
    expect(listWithTags).toHaveBeenLastCalledWith(
      expect.objectContaining({ knowledge_store_id: "ks-1", offset: PAGES_FETCH_BATCH * 2 }),
    );
  });

  it("resolves the knowledge store once and reuses it across batches", async () => {
    const { client, getBySpaceId } = fakeClient(PAGES_FETCH_BATCH * 3);
    const load = makeLibraryPagesLoader(client, "space-1");
    await load(0);
    await load(PAGES_FETCH_BATCH);
    expect(getBySpaceId).toHaveBeenCalledTimes(1);
  });

  it("falls back to (untitled) for empty titles", async () => {
    const { client } = fakeClient(1);
    const raw = await client.page.listWithTags.query({ knowledge_store_id: "ks-1" });
    raw.data[0].title = "";
    vi.mocked(client.page.listWithTags.query).mockResolvedValueOnce(raw);
    const { pages } = await makeLibraryPagesLoader(client, "space-1")(0);
    expect(pages[0]?.title).toBe("(untitled)");
  });

  it("rejects when the space has no knowledge store", async () => {
    const { client } = fakeClient(1);
    vi.mocked(client.knowledgeStore.getBySpaceId.query).mockResolvedValueOnce(null);
    await expect(makeLibraryPagesLoader(client, "space-1")(0)).rejects.toThrow(
      "No knowledge store found",
    );
  });
});

describe("pageRows", () => {
  it("renders title, type, status, and date columns", () => {
    const rows = pageRows([page(), page({ title: "Draft note", published: false })], 80);
    expect(rows[0]).toContain("OAuth refresh token expiry");
    expect(rows[0]).toContain("document");
    expect(rows[0]).toContain("published");
    expect(rows[0]).toContain("2026-09-01");
    expect(rows[1]).toContain("draft");
  });

  it("clips long titles to the available width", () => {
    const rows = pageRows([page({ title: "x".repeat(200) })], 60);
    expect(rows[0]).toContain("\u2026");
    expect(rows[0]).not.toContain("x".repeat(60));
  });
});

describe("windowSelection", () => {
  it("pins to the top while the cursor is inside the first window", () => {
    expect(windowSelection(20, 0, 10)).toEqual({ start: 0, above: 0, below: 10 });
    expect(windowSelection(20, 9, 10)).toEqual({ start: 0, above: 0, below: 10 });
  });

  it("rides the cursor on the bottom row once it walks past the window", () => {
    expect(windowSelection(20, 10, 10)).toEqual({ start: 1, above: 1, below: 9 });
    expect(windowSelection(20, 19, 10)).toEqual({ start: 10, above: 10, below: 0 });
  });

  it("shows everything when the list fits", () => {
    expect(windowSelection(3, 2, 10)).toEqual({ start: 0, above: 0, below: 0 });
  });
});

describe("renderPagesFrame", () => {
  it("shows the breadcrumb header and a loading line before the fetch resolves", () => {
    const frame = stripAnsi(renderPagesFrame({ phase: "loading" }, 64, 0));
    expect(frame).toContain("Home \u203A Pages");
    expect(frame).toContain("Loading pages");
    expect(frame).toContain("\u2191\u2193 move \u00B7 enter open \u00B7 esc back");
  });

  it("shows the error message when the fetch fails", () => {
    const frame = stripAnsi(
      renderPagesFrame({ phase: "error", message: "No Library configured." }, 64, 0),
    );
    expect(frame).toContain("No Library configured.");
  });

  it("shows an empty message for a Library with no pages", () => {
    const frame = stripAnsi(renderPagesFrame({ phase: "ready", pages: [], total: 0 }, 64, 0));
    expect(frame).toContain("No pages in this Library yet.");
  });

  it("marks the selected row with the cursor", () => {
    const pages = [page({ title: "First" }), page({ title: "Second" })];
    const frame = stripAnsi(renderPagesFrame({ phase: "ready", pages, total: 2 }, 80, 1));
    const lines = frame.split("\n");
    const first = lines.find((l) => l.includes("First"));
    const second = lines.find((l) => l.includes("Second"));
    expect(first?.startsWith("\u25B8")).toBe(false);
    expect(second?.startsWith("\u25B8")).toBe(true);
  });

  it("shows the page count and follows the cursor when the list overflows", () => {
    const pages = Array.from({ length: PAGES_VIEW_LINES + 3 }, (_, i) =>
      page({ title: `Page ${i}` }),
    );
    const model = { phase: "ready" as const, pages, total: pages.length };
    const top = stripAnsi(renderPagesFrame(model, 80, 0));
    expect(top).toContain(`(${pages.length})`);
    expect(top).toContain("\u2193 3 more");
    // The cursor one row past the first window drags the list with it.
    const scrolled = stripAnsi(renderPagesFrame(model, 80, PAGES_VIEW_LINES));
    expect(scrolled).toContain("\u2191 1 earlier");
    expect(scrolled).toContain(`\u25B8 Page ${PAGES_VIEW_LINES}`);
  });

  it("counts unfetched pages in the header and the more-hint", () => {
    const pages = Array.from({ length: PAGES_VIEW_LINES + 2 }, (_, i) =>
      page({ title: `Page ${i}` }),
    );
    // 1M pages in the Library, only the first slice loaded so far.
    const frame = stripAnsi(renderPagesFrame({ phase: "ready", pages, total: 1_000_000 }, 80, 0));
    expect(frame).toContain(`(${pages.length} of 1000000)`);
    expect(frame).toContain(`\u2193 ${1_000_000 - PAGES_VIEW_LINES} more`);
  });
});

describe("wrapBody", () => {
  it("preserves line breaks and blank lines", () => {
    expect(wrapBody("one\n\ntwo", 40)).toEqual(["one", "", "two"]);
  });

  it("word-wraps long lines to the width", () => {
    const lines = wrapBody("alpha beta gamma delta", 11);
    expect(lines).toEqual(["alpha beta", "gamma delta"]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(11);
  });

  it("hard-breaks tokens longer than the width", () => {
    const lines = wrapBody(`start ${"x".repeat(25)} end`, 10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
    expect(lines.join("")).toContain("x".repeat(25));
    expect(lines.at(-1)).toContain("end");
  });
});

describe("renderPageFrame", () => {
  it("shows the breadcrumb with the page title, meta line, and a loading state", () => {
    const frame = stripAnsi(renderPageFrame(page(), { phase: "loading" }, 64, 0));
    expect(frame).toContain("Home \u203A Pages \u203A OAuth refresh token expiry");
    expect(frame).toContain("document \u00B7 published \u00B7 updated 2026-09-01");
    expect(frame).toContain("Loading page");
    expect(frame).toContain("\u2191\u2193 scroll \u00B7 esc back to pages");
  });

  it("shows the fetched body and windows it with scroll hints", () => {
    const body = Array.from({ length: PAGE_BODY_LINES + 4 }, (_, i) => `line ${i}`).join("\n");
    const top = stripAnsi(renderPageFrame(page(), { phase: "ready", body }, 64, 0));
    expect(top).toContain("line 0");
    expect(top).toContain("\u2193 4 more");
    const scrolled = stripAnsi(renderPageFrame(page(), { phase: "ready", body }, 64, 2));
    expect(scrolled).toContain("\u2191 2 earlier");
    expect(scrolled).not.toContain("line 0\n");
  });

  it("shows a body fetch error", () => {
    const frame = stripAnsi(
      renderPageFrame(page(), { phase: "error", message: "Page not found." }, 64, 0),
    );
    expect(frame).toContain("Page not found.");
  });
});

// ---------------------------------------------------------------------------
// runPagesView — driven through fake streams and an injected loader
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

/** Let the injected loadPages promise settle before asserting. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("runPagesView", () => {
  it("resolves immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await runPagesView({ input, output, loadPages: vi.fn() });
    expect(written).toEqual([]);
  });

  it("shows loading, then the fetched pages, and exits on q", async () => {
    const { input, output, written } = fakeIO();

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({ pages: [page(), page({ title: "Second page" })], total: 2 }),
    });

    expect(written.join("")).toContain(ALT_SCREEN_ENTER);
    expect(stripAnsi(written.join(""))).toContain("Loading pages");

    await flush();
    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("OAuth refresh token expiry");
    expect(rendered).toContain("Second page");
    expect(rendered).toContain("(2)");

    input.emit("data", "q");
    await view;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
    expect(written.join("")).toContain(ALT_SCREEN_EXIT);
  });

  it("shows the loader's error and still exits cleanly", async () => {
    const { input, output, written } = fakeIO();

    const view = runPagesView({
      input,
      output,
      loadPages: async () => {
        throw new Error("No Library configured. Run 'dosu setup' first.");
      },
    });

    await flush();
    expect(stripAnsi(written.join(""))).toContain("No Library configured.");

    input.emit("data", ESC);
    await view;
  });

  it("moves the cursor with the arrows and drags the window along", async () => {
    const { input, output, written } = fakeIO();
    const pages = Array.from({ length: PAGES_VIEW_LINES + 2 }, (_, i) =>
      page({ id: `p-${i}`, title: `Page ${i}` }),
    );

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({ pages, total: pages.length }),
    });
    await flush();

    // ↑ at the top is a no-op; the cursor starts on the first row.
    input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.join(""))).not.toContain("\u2191 1 earlier");

    // Walk the cursor one row past the window: the list follows.
    for (let i = 0; i < PAGES_VIEW_LINES; i++) input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("\u2191 1 earlier");
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`\u25B8 Page ${PAGES_VIEW_LINES}`);

    // The cursor stops at the last row.
    input.emit("data", `${ESC}[B`);
    input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`\u25B8 Page ${PAGES_VIEW_LINES + 1}`);

    input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`\u25B8 Page ${PAGES_VIEW_LINES}`);

    input.emit("data", "q");
    await view;
  });

  it("enter opens the selected page, esc returns to the list", async () => {
    const { input, output, written } = fakeIO();
    const loadPageBody = vi.fn(async (id: string) => `body of ${id}\nsecond line`);

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({
        pages: [page({ id: "p-0", title: "First" }), page({ id: "p-1", title: "Second" })],
        total: 2,
      }),
      loadPageBody,
    });
    await flush();

    // Move to the second page and open it.
    input.emit("data", `${ESC}[B`);
    input.emit("data", "\r");
    expect(loadPageBody).toHaveBeenCalledWith("p-1");
    expect(stripAnsi(written.at(-1) ?? "")).toContain("Loading page");

    await flush();
    const reader = stripAnsi(written.at(-1) ?? "");
    expect(reader).toContain("Second");
    expect(reader).toContain("body of p-1");
    expect(reader).toContain("second line");
    expect(reader).toContain("esc back to pages");

    // esc closes the reader, not the view: the list is back, cursor kept.
    input.emit("data", ESC);
    const list = stripAnsi(written.at(-1) ?? "");
    expect(list).toContain("Pages");
    expect(list).toContain("\u25B8 Second");

    input.emit("data", "q");
    await view;
  });

  it("scrolls the reader body and shows a body fetch error", async () => {
    const { input, output, written } = fakeIO();
    const body = Array.from({ length: PAGE_BODY_LINES + 3 }, (_, i) => `row ${i}`).join("\n");

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({ pages: [page({ id: "p-0" })], total: 1 }),
      loadPageBody: async () => body,
    });
    await flush();

    input.emit("data", "\r");
    await flush();
    expect(stripAnsi(written.at(-1) ?? "")).toContain("\u2193 3 more");

    input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("\u2191 1 earlier");
    // Scrolling stops at the last body line.
    for (let i = 0; i < 10; i++) input.emit("data", `${ESC}[B`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("\u2191 3 earlier");

    input.emit("data", ESC);
    input.emit("data", "q");
    await view;
  });

  it("shows the reader error when the body fetch fails", async () => {
    const { input, output, written } = fakeIO();

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({ pages: [page()], total: 1 }),
      loadPageBody: async () => {
        throw new Error("Page not found.");
      },
    });
    await flush();

    input.emit("data", "\r");
    await flush();
    expect(stripAnsi(written.at(-1) ?? "")).toContain("Page not found.");

    input.emit("data", ESC);
    input.emit("data", "q");
    await view;
  });

  it("drops a stale body fetch after the reader was closed", async () => {
    const { input, output, written } = fakeIO();
    let resolveBody: (body: string) => void = () => {};

    const view = runPagesView({
      input,
      output,
      loadPages: async () => ({ pages: [page()], total: 1 }),
      loadPageBody: () => new Promise((resolve) => (resolveBody = resolve)),
    });
    await flush();

    input.emit("data", "\r");
    input.emit("data", ESC); // close the reader before the fetch lands
    const afterClose = written.length;

    resolveBody("late body");
    await flush();
    // The stale fetch repaints nothing and never shows the late body.
    expect(written.length).toBe(afterClose);
    expect(stripAnsi(written.join(""))).not.toContain("late body");

    input.emit("data", "q");
    await view;
  });

  it("ignores scroll keys while still loading", async () => {
    const { input, output, written } = fakeIO();
    let resolveLoad: (batch: PagesBatch) => void = () => {};
    const view = runPagesView({
      input,
      output,
      loadPages: () => new Promise((resolve) => (resolveLoad = resolve)),
    });

    const before = written.length;
    input.emit("data", `${ESC}[B`);
    expect(written.length).toBe(before);

    resolveLoad({ pages: [page()], total: 1 });
    await flush();
    input.emit("data", "q");
    await view;
  });

  it("does not repaint when the fetch lands after the user already left", async () => {
    const { input, output, written } = fakeIO();
    let resolveLoad: (batch: PagesBatch) => void = () => {};
    const view = runPagesView({
      input,
      output,
      loadPages: () => new Promise((resolve) => (resolveLoad = resolve)),
    });

    input.emit("data", "q");
    await view;
    const afterExit = written.length;

    resolveLoad({ pages: [page()], total: 1 });
    await flush();
    expect(written.length).toBe(afterExit);
  });

  it("fetches the next batch when the cursor nears the end of the loaded list", async () => {
    const { input, output, written } = fakeIO();
    const BATCH = PAGES_VIEW_LINES + 8; // one screen plus some headroom
    const all = Array.from({ length: BATCH * 2 }, (_, i) => page({ id: `p-${i}`, title: `P${i}` }));
    const loadPages = vi.fn(async (offset: number) => ({
      pages: all.slice(offset, offset + BATCH),
      total: all.length,
    }));

    const view = runPagesView({ input, output, loadPages });
    await flush();

    // Only the first batch was fetched; the header says so.
    expect(loadPages).toHaveBeenCalledTimes(1);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`(${BATCH} of ${all.length})`);

    // Walk the cursor into the prefetch margin near the end of the batch.
    for (let i = 0; i < BATCH - PAGES_VIEW_LINES; i++) input.emit("data", `${ESC}[B`);
    await flush();

    expect(loadPages).toHaveBeenCalledTimes(2);
    expect(loadPages).toHaveBeenLastCalledWith(BATCH);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`(${all.length})`);

    input.emit("data", "q");
    await view;
  });

  it("keeps the loaded list usable when a later batch fails, and retries on the next move", async () => {
    const { input, output, written } = fakeIO();
    const BATCH = PAGES_VIEW_LINES + 8;
    const all = Array.from({ length: BATCH * 2 }, (_, i) => page({ id: `p-${i}`, title: `P${i}` }));
    const loadPages = vi
      .fn(async (offset: number) => ({
        pages: all.slice(offset, offset + BATCH),
        total: all.length,
      }))
      .mockImplementationOnce(async () => ({ pages: all.slice(0, BATCH), total: all.length }))
      .mockImplementationOnce(async () => {
        throw new Error("network fail");
      });

    const view = runPagesView({ input, output, loadPages });
    await flush();

    // Reach the margin: the second call fails, the list stays on screen.
    for (let i = 0; i < BATCH - PAGES_VIEW_LINES; i++) input.emit("data", `${ESC}[B`);
    await flush();
    expect(loadPages).toHaveBeenCalledTimes(2);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`(${BATCH} of ${all.length})`);
    expect(stripAnsi(written.join(""))).not.toContain("network fail");

    // The next cursor move retries and completes the list.
    input.emit("data", `${ESC}[B`);
    await flush();
    expect(loadPages).toHaveBeenCalledTimes(3);
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`(${all.length})`);

    input.emit("data", "q");
    await view;
  });

  it("clamps the total when the backend returns an empty batch early", async () => {
    const { input, output, written } = fakeIO();
    const BATCH = PAGES_VIEW_LINES + 8;
    const first = Array.from({ length: BATCH }, (_, i) => page({ id: `p-${i}`, title: `P${i}` }));
    const loadPages = vi
      .fn(async () => ({ pages: [] as LibraryPage[], total: BATCH * 2 }))
      .mockImplementationOnce(async () => ({ pages: first, total: BATCH * 2 }));

    const view = runPagesView({ input, output, loadPages });
    await flush();

    for (let i = 0; i < BATCH - PAGES_VIEW_LINES; i++) input.emit("data", `${ESC}[B`);
    await flush();

    // The claimed 2×BATCH total is clamped to what actually exists; no
    // further fetches spin against the phantom remainder.
    expect(stripAnsi(written.at(-1) ?? "")).toContain(`(${BATCH})`);
    const calls = loadPages.mock.calls.length;
    input.emit("data", `${ESC}[B`);
    await flush();
    expect(loadPages.mock.calls.length).toBe(calls);

    input.emit("data", "q");
    await view;
  });
});
