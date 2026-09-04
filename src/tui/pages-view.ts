/** Read-only Pages screen: lazily fetched selectable list of the Library's pages with a
 * scrollable reader. Pure render/reduce functions wired to injectable IO. */

import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { brand } from "../setup/styles";
import { activityWidth } from "./activity-view";
import { enterAltScreen } from "./alt-screen";
import { windowReport } from "./analytics-view";
import { breadcrumb, frameTopMargin } from "./layout";
import { parseKeys } from "./menu";

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CTRL_C = String.fromCharCode(3);
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[0J`;
const CLEAR_EOL = `${ESC}[K`;

/** How many page rows fit on screen at once (the scroll window). */
export const PAGES_VIEW_LINES = 12;

/** How many body lines the page reader shows at once. */
export const PAGE_BODY_LINES = 14;

/** Backend page size for the fetch-everything loop. */
export const PAGES_FETCH_BATCH = 100;

export type PagesViewAction = "back" | "up" | "down" | "open" | "none";

/** q/esc/ctrl-c back, ↑↓ (or k/j) move or scroll, enter opens the reader. */
export function reducePagesViewKey(key: string): PagesViewAction {
  if (key === "q" || key === ESC || key === CTRL_C) return "back";
  if (key === KEY_UP || key === "k") return "up";
  if (key === KEY_DOWN || key === "j") return "down";
  if (key === "\r" || key === "\n") return "open";
  return "none";
}

/** The slice of a Library page this screen shows. */
export interface LibraryPage {
  id: string;
  title: string;
  type: string;
  published: boolean;
  updated_at: string;
}

export type PagesViewModel =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; pages: LibraryPage[]; total: number };

/** One fetched slice of the Library plus the backend's reported total. */
export interface PagesBatch {
  pages: LibraryPage[];
  total: number;
}

/** Fetches one batch of pages starting at `offset`. */
export type PagesBatchLoader = (offset: number) => Promise<PagesBatch>;

/** Batch loader: one request per screenful; the knowledge store is resolved once and cached. */
export function makeLibraryPagesLoader(client: TypedClient, spaceId: string): PagesBatchLoader {
  let storeId: Promise<string> | null = null;
  return async (offset: number) => {
    storeId ??= client.knowledgeStore.getBySpaceId.query({ space_id: spaceId }).then((store) => {
      if (!store) throw new Error("No knowledge store found for this Library.");
      return store.id;
    });
    const result = await client.page.listWithTags.query({
      knowledge_store_id: await storeId,
      limit: PAGES_FETCH_BATCH,
      offset,
    });
    return {
      pages: result.data.map((page) => ({
        id: page.id,
        title: page.title || "(untitled)",
        type: page.type,
        published: page.published,
        updated_at: page.updated_at,
      })),
      total: result.pagination.total,
    };
  };
}

/** The default loader: the stored login + target, same gate as `dosu docs`. */
function loadPagesFromConfig(): PagesBatchLoader {
  const cfg = loadConfig();
  const spaceId = cfg.active_account?.target?.space_id;
  if (!spaceId) {
    return () => Promise.reject(new Error("No Library configured. Run 'dosu setup' first."));
  }
  return makeLibraryPagesLoader(createTypedClient(cfg), spaceId);
}

/** What the reader shows for one opened page. */
export type PageContentModel =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; body: string };

/** Default body fetch: `page.get`, the same contract call as `dosu docs get`. */
async function loadPageBodyFromConfig(id: string): Promise<string> {
  const page = await createTypedClient(loadConfig()).page.get.query({ page_id: id });
  if (!page) throw new Error("Page not found.");
  return page.body || "(this page has no content)";
}

/** Word-wrap a page body to `width`; over-long tokens are hard-broken to stay in the margin. */
export function wrapBody(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    const pieces: string[] = [];
    let line = "";
    for (const word of raw.split(" ")) {
      let rest = word;
      while (rest.length > width) {
        if (line !== "") {
          pieces.push(line);
          line = "";
        }
        pieces.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (line === "") line = rest;
      else if (line.length + 1 + rest.length <= width) line = `${line} ${rest}`;
      else {
        pieces.push(line);
        line = rest;
      }
    }
    if (line !== "" || pieces.length === 0) pieces.push(line);
    out.push(...pieces);
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/** One row per page: title, type, status, last-changed date. */
export function pageRows(pages: readonly LibraryPage[], width: number): string[] {
  // type (9) + status (9) + date (10) + separating spaces.
  const titleWidth = Math.max(16, width - 32);
  return pages.map((page) => {
    const title = clip(page.title, titleWidth).padEnd(titleWidth + 1);
    const type = page.type.padEnd(10);
    const status = (page.published ? "published" : "draft").padEnd(10);
    const date = page.updated_at.slice(0, 10);
    return `${title}${type}${status}${date}`;
  });
}

/** List window keeping `selected` visible; pure, so the renderer needs no scroll state. */
export function windowSelection(
  count: number,
  selected: number,
  height: number = PAGES_VIEW_LINES,
): { start: number; above: number; below: number } {
  const start = Math.max(0, Math.min(selected - height + 1, count - height));
  return { start, above: start, below: Math.max(0, count - start - height) };
}

/** Render the full pages block, anchored to the content column's left edge. */
export function renderPagesFrame(model: PagesViewModel, width: number, selected: number): string {
  const body: string[] = [];
  let scrollHint = "";

  if (model.phase === "loading") {
    body.push(pc.dim("Loading pages\u2026"));
  } else if (model.phase === "error") {
    body.push(pc.yellow(clip(model.message, width)));
  } else if (model.pages.length === 0) {
    body.push(pc.dim("No pages in this Library yet."));
  } else {
    // Two columns for the cursor marker; rows are laid out for what remains.
    const rows = pageRows(model.pages, width - 2);
    const { start, above } = windowSelection(rows.length, selected);
    const visible = rows.slice(start, start + PAGES_VIEW_LINES);
    body.push(
      ...visible.map((row, i) =>
        start + i === selected ? `${brand("\u25B8")} ${pc.bold(row)}` : `  ${pc.dim(row)}`,
      ),
    );
    // "more" counts against the backend total, not just what's loaded, so
    // the hint never understates a lazily fetched Library.
    const below = Math.max(0, Math.max(model.total, rows.length) - start - PAGES_VIEW_LINES);
    const parts: string[] = [];
    if (above > 0) parts.push(`\u2191 ${above} earlier`);
    if (below > 0) parts.push(`\u2193 ${below} more`);
    scrollHint = parts.join(" \u00B7 ");
  }

  const count =
    model.phase === "ready"
      ? ` ${pc.dim(
          model.pages.length < model.total
            ? `(${model.pages.length} of ${model.total})`
            : `(${model.pages.length})`,
        )}`
      : "";
  const lines = [
    `${breadcrumb(["Home", "Pages"], width)}${count}`,
    "",
    ...body,
    ...(scrollHint ? [pc.dim(scrollHint)] : []),
    "",
    pc.dim("\u2191\u2193 move \u00B7 enter open \u00B7 esc back"),
  ];
  return lines.join("\n");
}

/** Render one opened page: title, dim meta line, scrollable body window. */
export function renderPageFrame(
  page: LibraryPage,
  content: PageContentModel,
  width: number,
  scroll: number,
): string {
  const body: string[] = [];
  let scrollHint = "";

  if (content.phase === "loading") {
    body.push(pc.dim("Loading page\u2026"));
  } else if (content.phase === "error") {
    body.push(pc.yellow(clip(content.message, width)));
  } else {
    const rows = wrapBody(content.body, width);
    const { visible, above, below } = windowReport(rows, scroll, PAGE_BODY_LINES);
    body.push(...visible);
    const parts: string[] = [];
    if (above > 0) parts.push(`\u2191 ${above} earlier`);
    if (below > 0) parts.push(`\u2193 ${below} more`);
    scrollHint = parts.join(" \u00B7 ");
  }

  const meta = `${page.type} \u00B7 ${page.published ? "published" : "draft"} \u00B7 updated ${page.updated_at.slice(0, 10)}`;
  const lines = [
    breadcrumb(["Home", "Pages", page.title], width),
    pc.dim(clip(meta, width)),
    "",
    ...body,
    ...(scrollHint ? [pc.dim(scrollHint)] : []),
    "",
    pc.dim("\u2191\u2193 scroll \u00B7 esc back to pages"),
  ];
  return lines.join("\n");
}

export interface PagesViewIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Injectable batch fetch for tests; defaults to the stored login + target. */
  loadPages?: PagesBatchLoader;
  /** Injectable body fetch for tests; defaults to `page.get`. */
  loadPageBody?: (id: string) => Promise<string>;
}

/** Show the Library's pages until back; resolves immediately when stdin isn't interactive. */
export function runPagesView(io: PagesViewIO = {}): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  if (!input.isTTY) return Promise.resolve();

  const loadPages = io.loadPages ?? loadPagesFromConfig();
  const loadPageBody = io.loadPageBody ?? loadPageBodyFromConfig;

  let model: PagesViewModel = { phase: "loading" };
  let selected = 0;
  let fetchingMore = false;
  // Reader state: the page being read, its body fetch, and its scroll.
  let openPage: LibraryPage | null = null;
  let content: PageContentModel = { phase: "loading" };
  let contentScroll = 0;
  // Guards a slow body fetch: reopening (or leaving) makes older loads moot.
  let openSeq = 0;
  let closed = false;

  // Same painting discipline as the analytics view: home the cursor, clear
  // each repainted line to end-of-line, clear below, skip identical frames.
  let lastFrame: string | null = null;
  const draw = () => {
    const width = activityWidth(output.columns ?? 80);
    const frame = openPage
      ? renderPageFrame(openPage, content, width, contentScroll)
      : renderPagesFrame(model, width, selected);
    if (frame === lastFrame) return;
    lastFrame = frame;
    // A fixed top margin, not vertical centering — one extra row matches the
    // home banner's leading blank line so every TUI page starts at the same row.
    const blank = `${CLEAR_EOL}\n`.repeat(frameTopMargin(output.rows ?? 24) + 1);
    const painted = frame.replaceAll("\n", `${CLEAR_EOL}\n`) + CLEAR_EOL;
    output.write(`${CURSOR_HOME}${blank}${painted}\n${CLEAR_BELOW}`);
  };

  const onResize = () => {
    lastFrame = null;
    draw();
  };
  output.on?.("resize", onResize);

  const leaveAltScreen = enterAltScreen(output);
  output.write(HIDE_CURSOR);
  draw();

  /** Fetch the next batch when the cursor nears the end and more exist; one request in flight,
   * and a failed batch is silently retried on the next cursor move. */
  const maybeFetchMore = () => {
    if (model.phase !== "ready" || fetchingMore || closed) return;
    if (model.pages.length >= model.total) return;
    if (selected < Math.max(0, model.pages.length - PAGES_VIEW_LINES)) return;
    fetchingMore = true;
    loadPages(model.pages.length).then(
      (batch) => {
        fetchingMore = false;
        if (closed || model.phase !== "ready") return;
        // An empty batch means the backend disagrees with its own total:
        // clamp to what we have rather than refetching forever.
        model =
          batch.pages.length === 0
            ? { ...model, total: model.pages.length }
            : { phase: "ready", pages: [...model.pages, ...batch.pages], total: batch.total };
        draw();
        maybeFetchMore();
      },
      () => {
        fetchingMore = false;
      },
    );
  };

  loadPages(0).then(
    (batch) => {
      model = { phase: "ready", pages: batch.pages, total: batch.total };
      if (closed) return;
      draw();
      maybeFetchMore();
    },
    (err: unknown) => {
      model = { phase: "error", message: err instanceof Error ? err.message : String(err) };
      if (!closed) draw();
    },
  );

  /** Open the page under the cursor in the reader and fetch its body. */
  const openSelected = () => {
    if (model.phase !== "ready" || model.pages.length === 0) return;
    openPage = model.pages[selected];
    content = { phase: "loading" };
    contentScroll = 0;
    const seq = ++openSeq;
    loadPageBody(openPage.id).then(
      (body) => {
        if (closed || seq !== openSeq) return;
        content = { phase: "ready", body };
        draw();
      },
      (err: unknown) => {
        if (closed || seq !== openSeq) return;
        content = { phase: "error", message: err instanceof Error ? err.message : String(err) };
        draw();
      },
    );
    draw();
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const finish = () => {
      closed = true;
      output.off?.("resize", onResize);
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      leaveAltScreen();
      output.write(SHOW_CURSOR);
      resolve();
    };

    const onData = (chunk: Buffer | string) => {
      for (const key of parseKeys(chunk.toString())) {
        const action = reducePagesViewKey(key);

        // Reader mode: esc closes the page (back to the list, cursor kept),
        // arrows scroll the body.
        if (openPage) {
          if (action === "back") {
            openPage = null;
            openSeq += 1; // an in-flight body fetch is now moot
            draw();
          } else if (action === "up" && contentScroll > 0) {
            contentScroll -= 1;
            draw();
          } else if (action === "down" && content.phase === "ready") {
            const width = activityWidth(output.columns ?? 80);
            const maxScroll = Math.max(0, wrapBody(content.body, width).length - PAGE_BODY_LINES);
            if (contentScroll < maxScroll) {
              contentScroll += 1;
              draw();
            }
          }
          continue;
        }

        // List mode: esc leaves the view, arrows move the cursor, enter opens.
        if (action === "back") {
          finish();
          return;
        }
        if (action === "open") {
          openSelected();
        } else if (action === "up" && selected > 0) {
          selected -= 1;
          draw();
        } else if (action === "down" && model.phase === "ready") {
          if (selected < model.pages.length - 1) {
            selected += 1;
            draw();
          }
          maybeFetchMore();
        }
      }
    };
    input.on("data", onData);
  });
}
