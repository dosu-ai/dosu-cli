import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../sync/status";
import {
  ACTIVITY_VIEW_BUFFER_LINES,
  ACTIVITY_VIEW_FULL_LIST_ROWS,
  activityWidth,
  appendSyncActivity,
  confirmBox,
  cycleTab,
  foldRunProgress,
  formatActivityLine,
  formatQueuedRow,
  formatStudiedRow,
  latestBacklog,
  parseGateLine,
  progressLine,
  reduceActivityViewKey,
  reduceSyncConfirmKey,
  renderActivityFrame,
  runActivityView,
  tabBar,
  windowList,
  wrapLine,
  wrapRow,
} from "./activity-view";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./alt-screen";
import { frameTopMargin } from "./layout";

const mockSpawnDetachedSelf = vi.fn((_args: string[]) => true);
vi.mock("../sync/detach", () => ({
  spawnDetachedSelf: (args: string[]) => mockSpawnDetachedSelf(args),
}));

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "");
}

function makeStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    running: false,
    state: { schema_version: 1, watermark: null, consecutive_failures: 0 },
    recentActivity: [],
    ...overrides,
  };
}

/** One gated backlog session, as the scanner would report it. */
function queuedSession(id = "848b3896-fb07") {
  return {
    id,
    harness: "cursor" as const,
    path: "/home/u/.cursor/projects/p/agent-transcripts/848b3896-fb07/848b3896-fb07.jsonl",
    project: "Users-james-dosu-cli",
    updated: "2026-08-27T21:05:00.000Z",
  };
}

/** A status whose state carries studied-session history and an all-time count. */
function studiedStatus(): SyncStatus {
  return makeStatus({
    state: {
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      mined_sessions: [{ at: "2026-09-02T23:00:00.000Z", session: "cursor/abc" }],
      total_mined: 7,
    },
  });
}

describe("reduceActivityViewKey", () => {
  it("goes back on q, esc, and ctrl-c", () => {
    expect(reduceActivityViewKey("q")).toBe("back");
    expect(reduceActivityViewKey(ESC)).toBe("back");
    expect(reduceActivityViewKey(CTRL_C)).toBe("back");
  });

  it("cycles tabs forward on tab/right and backward on left", () => {
    expect(reduceActivityViewKey("\t")).toBe("tab");
    expect(reduceActivityViewKey(`${ESC}[C`)).toBe("tab");
    expect(reduceActivityViewKey(`${ESC}[D`)).toBe("tab-back");
  });

  it("scrolls on the up/down arrows and k/j", () => {
    expect(reduceActivityViewKey(`${ESC}[A`)).toBe("up");
    expect(reduceActivityViewKey("k")).toBe("up");
    expect(reduceActivityViewKey(`${ESC}[B`)).toBe("down");
    expect(reduceActivityViewKey("j")).toBe("down");
  });

  it("starts a sync on s", () => {
    expect(reduceActivityViewKey("s")).toBe("sync");
  });

  it("toggles full rows on f", () => {
    expect(reduceActivityViewKey("f")).toBe("full");
  });

  it("clears study history on c", () => {
    expect(reduceActivityViewKey("c")).toBe("clear");
  });

  it("confirmation keys: enter/y/s start, esc/n/q cancel, rest ignored", () => {
    expect(reduceSyncConfirmKey("\r")).toBe("start");
    expect(reduceSyncConfirmKey("y")).toBe("start");
    expect(reduceSyncConfirmKey("s")).toBe("start");
    expect(reduceSyncConfirmKey(ESC)).toBe("cancel");
    expect(reduceSyncConfirmKey("n")).toBe("cancel");
    expect(reduceSyncConfirmKey("q")).toBe("cancel");
    expect(reduceSyncConfirmKey(`${ESC}[A`)).toBe("none");
  });

  it("cycles activity → studied → queued → open and wraps both ways", () => {
    expect(cycleTab("activity")).toBe("studied");
    expect(cycleTab("studied")).toBe("queued");
    expect(cycleTab("queued")).toBe("open");
    expect(cycleTab("open")).toBe("activity");
    expect(cycleTab("activity", -1)).toBe("open");
  });

  it("ignores other keys", () => {
    expect(reduceActivityViewKey("x")).toBe("none");
    expect(reduceActivityViewKey("\r")).toBe("none");
  });
});

describe("formatActivityLine", () => {
  it("compacts the ISO timestamp to its time component", () => {
    expect(formatActivityLine("[2026-09-02T21:58:42.716Z] [learner] wrote note", 64)).toBe(
      "21:58:42 [learner] wrote note",
    );
  });

  it("clips long lines to the width with an ellipsis", () => {
    const line = `[2026-09-02T21:58:42.716Z] [sync] ${"x".repeat(100)}`;
    const formatted = formatActivityLine(line, 30);
    expect(formatted).toHaveLength(30);
    expect(formatted.endsWith("\u2026")).toBe(true);
  });

  it("leaves lines without a timestamp intact", () => {
    expect(formatActivityLine("[sync] run finished", 64)).toBe("[sync] run finished");
  });

  it("strips ANSI codes from older log content so colors never bleed", () => {
    const line = `[learner] [sdk] ${ESC}[31mred error${ESC}[0m done`;
    expect(formatActivityLine(line, 64)).toBe("[learner] [sdk] red error done");
  });
});

describe("appendSyncActivity", () => {
  it("keeps only sync and learner lines and strips the level tag", () => {
    const chunk = [
      "[2026-09-02T21:00:00.000Z] [INFO] [sync] run started",
      "[2026-09-02T21:00:01.000Z] [DEBUG] [telemetry] unrelated",
      "[2026-09-02T21:00:02.000Z] [INFO] [learner] wrote note",
    ].join("\n");
    expect(appendSyncActivity([], chunk)).toEqual([
      "[2026-09-02T21:00:00.000Z] [sync] run started",
      "[2026-09-02T21:00:02.000Z] [learner] wrote note",
    ]);
  });

  it("caps the buffer at the newest max entries", () => {
    const seed = Array.from({ length: ACTIVITY_VIEW_BUFFER_LINES }, (_, i) => `[sync] old ${i}`);
    const result = appendSyncActivity(seed, "[sync] new line");
    expect(result).toHaveLength(ACTIVITY_VIEW_BUFFER_LINES);
    expect(result.at(-1)).toBe("[sync] new line");
    expect(result[0]).toBe("[sync] old 1");
  });
});

describe("formatStudiedRow", () => {
  it("lays out agent, studied-at, project, and session id like the queued tab", () => {
    expect(
      formatStudiedRow({
        at: "2026-09-02T23:00:00.000Z",
        session: "cursor/abc-123",
        project: "dosu-cli",
      }),
    ).toBe("cursor    09-02 23:00  dosu-cli  abc-123");
  });

  it("shows '-' for records written before the project field existed", () => {
    expect(formatStudiedRow({ at: "2026-09-02T23:00:00.000Z", session: "cursor/abc" })).toBe(
      "cursor    09-02 23:00  -  abc",
    );
  });

  it("falls back to the raw timestamp when it is not ISO", () => {
    expect(formatStudiedRow({ at: "whenever", session: "cursor/abc" })).toBe(
      "cursor    whenever  -  abc",
    );
  });

  it("keeps the full project and id in full mode", () => {
    const record = {
      at: "2026-09-02T23:00:00.000Z",
      session: "cursor/a60cacd1-2d66-455d-b220-0123456789ab",
      project: "Users-james-Documents-dosu-global-dosu-cli",
    };
    expect(formatStudiedRow(record, true)).toBe(
      "cursor    09-02 23:00  Users-james-Documents-dosu-global-dosu-cli  a60cacd1-2d66-455d-b220-0123456789ab",
    );
  });
});

describe("formatQueuedRow", () => {
  it("lays out agent, updated, project, and session id", () => {
    expect(formatQueuedRow(queuedSession())).toBe(
      "cursor    08-27 21:05  Users-james-dosu-cli  848b3896-fb07",
    );
  });

  it("dashes a missing project and clips long values", () => {
    const row = formatQueuedRow({
      ...queuedSession(),
      project: undefined,
      id: "a".repeat(50),
    });
    expect(row).toContain("  -  ");
    expect(row).toContain(`${"a".repeat(43)}\u2026`);
  });

  it("keeps the full id and project in full mode", () => {
    const row = formatQueuedRow(
      { ...queuedSession(), id: "a".repeat(40), project: "p".repeat(40) },
      true,
    );
    expect(row).toContain("a".repeat(40));
    expect(row).toContain("p".repeat(40));
    expect(row).not.toContain("\u2026");
  });
});

describe("wrapRow", () => {
  it("passes short rows through untouched", () => {
    expect(wrapRow("cursor    09-02 23:00  dosu  abc", 64)).toEqual([
      "cursor    09-02 23:00  dosu  abc",
    ]);
  });

  it("hard-wraps long rows mid-word and indents continuation lines", () => {
    const lines = wrapRow(`head  ${"x".repeat(30)}`, 20);
    expect(lines).toEqual([`head  ${"x".repeat(14)}`, `    ${"x".repeat(16)}`]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.join("").replaceAll(" ", "")).toContain("x".repeat(30));
  });
});

describe("windowList", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);

  it("pins to the newest lines at scroll 0", () => {
    const { visible, above, below } = windowList(lines, 0, 10);
    expect(visible).toEqual(lines.slice(15));
    expect(above).toBe(15);
    expect(below).toBe(0);
  });

  it("scrolls back and reports lines on both sides", () => {
    const { visible, above, below } = windowList(lines, 5, 10);
    expect(visible).toEqual(lines.slice(10, 20));
    expect(above).toBe(10);
    expect(below).toBe(5);
  });

  it("clamps scroll past the oldest line", () => {
    const { visible, above, below } = windowList(lines, 999, 10);
    expect(visible).toEqual(lines.slice(0, 10));
    expect(above).toBe(0);
    expect(below).toBe(15);
  });

  it("shows everything when the list fits the window", () => {
    const { visible, above, below } = windowList(["a", "b"], 3, 10);
    expect(visible).toEqual(["a", "b"]);
    expect(above).toBe(0);
    expect(below).toBe(0);
  });
});

describe("parseGateLine", () => {
  it("extracts backlog counts from a gate log line", () => {
    expect(
      parseGateLine("[2026-09-02T21:00:00.000Z] [DEBUG] [sync] gate: 44 ready, 1 in flight (…)"),
    ).toEqual({ ready: 44, inFlight: 1 });
  });

  it("returns null for non-gate lines", () => {
    expect(parseGateLine("[2026-09-02T21:00:00.000Z] [INFO] [learner] wrote note")).toBeNull();
  });
});

describe("latestBacklog", () => {
  it("returns the counts from the newest gate line", () => {
    const log = [
      "[sync] gate: 49 ready, 0 in flight (watermark none)",
      "[learner] wrote note",
      "[sync] gate: 44 ready, 1 in flight (watermark 2026-09-01)",
    ].join("\n");
    expect(latestBacklog(log)).toEqual({ ready: 44, inFlight: 1 });
  });

  it("returns null when no gate line exists", () => {
    expect(latestBacklog("[learner] wrote note\nplain line")).toBeNull();
  });
});

describe("foldRunProgress", () => {
  const marker =
    "[2026-09-03T16:00:01.000Z] [DEBUG] [sync] studying 2 of 5 ready sessions (1 trivial skipped)\n";
  const read = (id: string, offset = 0) =>
    `[2026-09-03T16:00:05.000Z] [DEBUG] [learner] [agent] \u2192 mcp__sessions__read_session {"id":"${id}","offset":${offset}}\n`;
  const note =
    '[2026-09-03T16:00:07.000Z] [DEBUG] [learner] [agent] \u2192 mcp__dosu__write_knowledge {"title":"x"}\n';

  it("starts a batch at the studying marker and counts distinct session reads", () => {
    const progress = foldRunProgress(null, marker + read("s-1") + read("s-2") + note + note);
    expect(progress).not.toBeNull();
    expect(progress?.batch).toBe(2);
    expect(progress?.read.size).toBe(2);
    expect(progress?.notes).toBe(2);
  });

  it("collapses pagination and re-reads of the same session", () => {
    const progress = foldRunProgress(
      null,
      marker + read("s-1") + read("s-1", 30) + read("s-1", 60),
    );
    expect(progress?.read.size).toBe(1);
  });

  it("ignores learner traces before any batch marker", () => {
    expect(foldRunProgress(null, read("s-1") + note)).toBeNull();
  });

  it("clears when the batch settles — committed, failed, or refused", () => {
    const live = foldRunProgress(null, marker + read("s-1"));
    expect(
      foldRunProgress(
        live,
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] studied 2 sessions, 4 suggested pages; watermark \u2192 y\n",
      ),
    ).toBeNull();
    expect(
      foldRunProgress(
        foldRunProgress(null, marker),
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] studying failed: error; boom\n",
      ),
    ).toBeNull();
    expect(
      foldRunProgress(
        foldRunProgress(null, marker),
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] studying skipped by gateway: credit_limit\n",
      ),
    ).toBeNull();
  });

  it("a fresh marker resets the counts for the next batch", () => {
    const first = foldRunProgress(null, marker + read("s-1") + note);
    const second = foldRunProgress(first, marker + read("s-9"));
    expect(second?.read.size).toBe(1);
    expect(second?.read.has("s-9")).toBe(true);
    expect(second?.notes).toBe(0);
  });
});

describe("activityWidth", () => {
  it("keeps lines inside the centered column with equal margins on both sides", () => {
    // 160 cols: margin (160-64)/2 = 48 on each side → 160-96-1 = 63 usable.
    expect(activityWidth(160)).toBe(63);
    // 80 cols: margin 8 on each side → 63.
    expect(activityWidth(80)).toBe(63);
  });

  it("uses the full width minus one when there is no margin, floored at 20", () => {
    expect(activityWidth(50)).toBe(49);
    expect(activityWidth(10)).toBe(20);
  });
});

describe("wrapLine", () => {
  it("wraps on word boundaries and indents continuation lines", () => {
    const lines = wrapLine("! Studying paused: credits are gone for now", 20);
    expect(lines).toEqual(["! Studying paused:", "  credits are gone", "  for now"]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  it("returns short text as a single line", () => {
    expect(wrapLine("! all good", 40)).toEqual(["! all good"]);
  });
});

describe("renderActivityFrame", () => {
  it("shows a live run with pid and start time", () => {
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({ running: true, pid: 4242, startedAt: "2026-09-02T21:58:42.716Z" }),
        [],
        64,
      ),
    );
    expect(frame).toContain("\uD83D\uDCDA Studying sessions...");
    expect(frame).toContain("pid 4242");
  });

  it("shows idle state and the never-studied watermark", () => {
    const frame = stripAnsi(renderActivityFrame(makeStatus(), [], 64));
    expect(frame).toContain("Idle");
    expect(frame).toContain("Nothing studied yet");
    expect(frame).toContain("No sync activity in the log yet.");
  });

  it("flags a stale lock from a crashed run", () => {
    const frame = stripAnsi(renderActivityFrame(makeStatus({ staleLock: true, pid: 7 }), [], 64));
    expect(frame).toContain("Not running");
    expect(frame).toContain("exited without cleaning up");
  });

  it("renders a progress bar proportional to the drained backlog", () => {
    // 20 studied, 60 queued → 25% of an 80-session drain.
    const line = stripAnsi(progressLine(20, 60, 64) ?? "");
    expect(line).toContain("20/80 studied \u00B7 25%");
    const cells = 20; // width 64 minus the room reserved for the suffix
    expect(line).toContain("\u2588".repeat(Math.round(0.25 * cells)));
    expect(line).toContain("\u2591".repeat(cells - Math.round(0.25 * cells)));
  });

  it("returns no progress line when there is nothing to measure", () => {
    expect(progressLine(0, 0, 64)).toBeNull();
  });

  it("appends a live suggested-page count to the bar", () => {
    expect(stripAnsi(progressLine(0, 2, 64, 1) ?? "")).toContain(
      "0/2 studied \u00B7 0% \u00B7 1 suggested page",
    );
    expect(stripAnsi(progressLine(1, 1, 64, 7) ?? "")).toContain(
      "1/2 studied \u00B7 50% \u00B7 7 suggested pages",
    );
    expect(stripAnsi(progressLine(0, 2, 64, 0) ?? "")).not.toContain("suggested");
  });

  it("steps the bar within a live batch as the learner opens sessions", () => {
    const state = {
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_mined: 568,
    };
    // Queue of 2, single batch: the learner has opened both sessions, so the
    // first is done and the second is in flight — 1/2, not 0/2 until the end.
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({ running: true, pid: 1, state }),
        [],
        64,
        { ready: 2, inFlight: 0 },
        undefined,
        [],
        568,
        [],
        { batch: 2, read: new Set(["s-1", "s-2"]), notes: 3 },
      ),
    );
    expect(frame).toContain("1/2 studied \u00B7 50% \u00B7 3 suggested pages");
  });

  it("never counts the in-flight session as done — one open session stays 0/N", () => {
    const state = { schema_version: 1, watermark: null, consecutive_failures: 0, total_mined: 0 };
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({ running: true, pid: 1, state }),
        [],
        64,
        { ready: 2, inFlight: 0 },
        undefined,
        [],
        0,
        [],
        { batch: 2, read: new Set(["s-1"]), notes: 1 },
      ),
    );
    expect(frame).toContain("0/2 studied \u00B7 0% \u00B7 1 suggested page");
  });

  it("scopes the bar to the run: lifetime history does not pin it at ~100%", () => {
    // 568 sessions studied all-time, a hook just queued 1: the bar must read
    // 0/1 (this run hasn't studied anything yet), not 568/569 ≈ 99%.
    const state = {
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_mined: 568,
    };
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({ running: true, pid: 1, state }),
        [],
        64,
        { ready: 1, inFlight: 0 },
        undefined,
        [],
        568,
      ),
    );
    expect(frame).toContain("0/1 studied \u00B7 0%");
    expect(frame).not.toContain("568/569");
  });

  it("shows the progress bar only while a run is live", () => {
    const state = {
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_mined: 20,
    };
    const running = stripAnsi(
      renderActivityFrame(makeStatus({ running: true, pid: 1, state }), [], 64, {
        ready: 60,
        inFlight: 0,
      }),
    );
    expect(running).toContain("20/80 studied \u00B7 25%");

    const idle = stripAnsi(
      renderActivityFrame(makeStatus({ state }), [], 64, { ready: 60, inFlight: 0 }),
    );
    expect(idle).not.toContain("studied \u00B7");
  });

  it("shows open sessions in their own tab, not folded into the Queued label", () => {
    const withOpen = stripAnsi(
      renderActivityFrame(
        makeStatus(),
        [],
        64,
        { ready: 0, inFlight: 2 },
        undefined,
        [queuedSession()],
        0,
        [queuedSession("o1"), queuedSession("o2")],
      ),
    );
    expect(withOpen).toContain("Queued (1)");
    expect(withOpen).toContain("Open (2)");
    expect(withOpen).not.toContain("\u00B7 2 open");
    expect(withOpen).not.toContain("Queue is empty");
    expect(withOpen).not.toContain("queued when they finish");

    // No open sessions: plain zero counts, no noise.
    const drained = stripAnsi(renderActivityFrame(makeStatus(), [], 64, { ready: 0, inFlight: 0 }));
    expect(drained).toContain("Queued (0)");
    expect(drained).toContain("Open (0)");
    expect(drained).not.toContain("Queue is empty");
  });

  it("lists open sessions on the Open tab with the queued-row layout", () => {
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "open", scroll: 0 }, [], 0, [
        queuedSession(),
      ]),
    );
    expect(frame).toContain("Users-james-dosu-cli");
    expect(frame).toContain("848b3896-fb07");

    const empty = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "open", scroll: 0 }),
    );
    expect(empty).toContain("No open sessions");
  });

  it("shows the watermark, backoff, and activity lines", () => {
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({
          state: {
            schema_version: 1,
            watermark: "2026-09-02T20:00:00.000Z",
            consecutive_failures: 2,
          },
          backoffUntil: "2026-09-02T22:00:00.000Z",
        }),
        ["[2026-09-02T21:00:00.000Z] [sync] run started"],
        64,
      ),
    );
    expect(frame).toContain("Studied sessions up to");
    // The backoff line must advertise the manual escape hatch: s ignores the backoff.
    expect(frame).toContain("retrying after");
    expect(frame).toContain("s syncs now");
    expect(frame).toContain("[sync] run started");
  });

  it("explains a gateway refusal when idle instead of a bare Idle", () => {
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({
          state: {
            schema_version: 1,
            watermark: null,
            consecutive_failures: 0,
            last_refusal: {
              at: "2026-09-02T22:00:00.000Z",
              outcome: "credit_limit",
              message: "Your org has used its Dosu credits for this billing period.",
            },
          },
        }),
        [],
        64,
      ),
    );
    expect(frame).toContain("Studying paused: Your org has used its Dosu credits");
  });

  it("hides the refusal line while a run is live", () => {
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus({
          running: true,
          pid: 1,
          state: {
            schema_version: 1,
            watermark: null,
            consecutive_failures: 0,
            last_refusal: { at: "2026-09-02T22:00:00.000Z", outcome: "credit_limit", message: "x" },
          },
        }),
        [],
        64,
      ),
    );
    expect(frame).not.toContain("Studying paused");
  });

  it("underlines the active tab in the quiet two-line strip", () => {
    const [row, rule] = tabBar("studied", 3, 2, 577, 60).map(stripAnsi);
    // Order: Activity, Studied, Queued, Open.
    expect(row.indexOf("Activity")).toBeLessThan(row.indexOf("Studied (577)"));
    expect(row.indexOf("Studied (577)")).toBeLessThan(row.indexOf("Queued (3)"));
    expect(row.indexOf("Queued (3)")).toBeLessThan(row.indexOf("Open (2)"));
    // No folder-tab chrome: just the labels and the rule.
    expect(row).not.toContain("\u2502");
    // The heavy segment of the rule sits exactly under the active label...
    const start = row.indexOf("Studied (577)");
    expect(rule.indexOf("\u2501")).toBe(start);
    expect(rule.lastIndexOf("\u2501")).toBe(start + "Studied (577)".length - 1);
    // ...and the rule runs the full frame width.
    expect(rule.length).toBe(60);
  });

  it("spreads the tabs across the full frame width like flex", () => {
    const [row] = tabBar("activity", 3, 2, 577, 60).map(stripAnsi);
    // The last label ends flush with the frame edge...
    expect(row.length).toBe(60);
    expect(row.endsWith("Open (2)")).toBe(true);
    // ...and the gaps between labels are as even as integer columns allow.
    const gaps = row.split(/\S+ \S+|\S+/).filter((s) => s.length > 0);
    const sizes = gaps.map((g) => g.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("keeps a minimum gap when the frame is too narrow to spread", () => {
    const [row] = tabBar("activity", 3, 2, 577, 20).map(stripAnsi);
    expect(row).toContain("Activity   Studied (577)");
  });

  it("shows all three tabs with counts, activity active by default", () => {
    const frame = stripAnsi(
      renderActivityFrame(studiedStatus(), [], 64, null, undefined, [queuedSession()]),
    );
    expect(frame).toContain("Activity");
    expect(frame).toContain("Queued (1)");
    expect(frame).toContain("Studied (1)"); // unique sessions in history, not lifetime passes
    expect(frame).toContain(
      "tab switch \u00B7 \u2191\u2193 scroll \u00B7 f full rows \u00B7 s sync now \u00B7 esc back",
    );
  });

  it("keeps analytics content out of the sync frame — it has its own screen", () => {
    const withAnalytics = makeStatus({
      state: {
        schema_version: 1,
        watermark: null,
        consecutive_failures: 0,
        total_notes: 47,
        total_learning_tokens: 312_000,
      },
    });
    const frame = stripAnsi(renderActivityFrame(withAnalytics, [], 80));
    expect(frame).not.toContain("Suggested pages");
    expect(frame).not.toContain("Analytics");
  });

  it("keys s to the state: sync now while idle, stop while running, resume while paused", () => {
    const idle = stripAnsi(renderActivityFrame(makeStatus(), [], 64));
    expect(idle).toContain("s sync now");

    const running = stripAnsi(renderActivityFrame(makeStatus({ running: true, pid: 1 }), [], 64));
    expect(running).not.toContain("s sync now");
    expect(running).toContain("s stop");

    const paused = makeStatus();
    paused.state.paused = true;
    const pausedFrame = stripAnsi(renderActivityFrame(paused, [], 64));
    expect(pausedFrame).toContain("Paused");
    expect(pausedFrame).toContain("s resume");
  });

  it("offers c clear only while idle with something studied", () => {
    const nothingMined = stripAnsi(renderActivityFrame(makeStatus(), [], 64));
    expect(nothingMined).not.toContain("c clear");

    const studied = makeStatus();
    studied.state.watermark = "2026-09-02T21:00:00.000Z";
    const idle = stripAnsi(renderActivityFrame(studied, [], 80));
    expect(idle).toContain("s sync now \u00B7 c clear \u00B7 esc back");

    const running = makeStatus({ running: true, pid: 1 });
    running.state.watermark = "2026-09-02T21:00:00.000Z";
    expect(stripAnsi(renderActivityFrame(running, [], 64))).not.toContain("c clear");
  });

  it("renders the clear confirmation with its own title, scope, and verb", () => {
    const pane = { tab: "activity" as const, scroll: 0, confirm: "clear" as const };
    const frame = stripAnsi(renderActivityFrame(makeStatus(), [], 64, null, pane));
    expect(frame).toContain("Clear study history?");
    // The scope wraps inside the box; compare with the box borders and breaks flattened.
    const flat = frame.replace(/[\u2502\n]/g, " ").replace(/\s+/g, " ");
    expect(flat).toContain("reads them all again");
    expect(flat).toContain("Notes already saved in Dosu are kept");
    expect(frame).toContain("enter clear \u00B7 esc cancel");
    expect(frame).not.toContain("c clear");
  });

  it("wraps the key legend instead of outrunning a narrow frame", () => {
    const studied = makeStatus();
    studied.state.watermark = "2026-09-02T21:00:00.000Z";
    const width = 50;
    const frame = stripAnsi(renderActivityFrame(studied, [], width));
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    const flat = frame.replace(/\n/g, " ").replace(/\s+/g, " ");
    expect(flat).toContain("s sync now \u00B7 c clear \u00B7 esc back");
  });

  it("replaces the key legend with the confirmation popup while confirm is pending", () => {
    const pane = { tab: "activity" as const, scroll: 0, confirm: "start" as const };
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, { ready: 3, inFlight: 0 }, pane, [
        queuedSession("a"),
        queuedSession("b"),
        queuedSession("c"),
      ]),
    );
    expect(frame).toContain("Start studying now?");
    expect(frame).toContain("Dosu reads 3 sessions and distills");
    expect(frame).toContain("enter start \u00B7 esc cancel");
    expect(frame).not.toContain("s sync now");
    // The confirmation renders as a bordered popup box.
    expect(frame).toContain("\u256D");
    expect(frame).toContain("\u2570");
  });

  it("sizes the popup box to its content with aligned borders", () => {
    const box = confirmBox(2, { ready: 2, inFlight: 1 }, 64).map(stripAnsi);
    expect(box[0].trim().startsWith("\u256D")).toBe(true);
    expect(box[box.length - 1].trim().endsWith("\u256F")).toBe(true);
    // Every row of the box paints the same width so the right border lines up.
    const widths = new Set(box.map((line) => line.trimEnd().length));
    expect(widths.size).toBe(1);
    // No emoji inside the box at all: U+26CF is ambiguous-width across terminals
    // (1 column in xterm.js, 2 in Ghostty/kitty), so it always skews a border somewhere.
    expect(box.join("")).not.toContain("\u26CF");
    expect(box.join("")).not.toContain("\uFE0F");
  });

  it("wraps the popup scope line in a narrow terminal instead of breaking the border", () => {
    const box = confirmBox(12, { ready: 12, inFlight: 2 }, 40).map(stripAnsi);
    for (const line of box) {
      expect(line.trimEnd().length).toBeLessThanOrEqual(40);
    }
    expect(box.join("\n")).toContain("Dosu reads 12 sessions");
  });

  it("renders the studied-sessions tab from the state's history", () => {
    const frame = stripAnsi(
      renderActivityFrame(studiedStatus(), ["[sync] activity line"], 64, null, {
        tab: "studied",
        scroll: 0,
      }),
    );
    expect(frame).toContain("cursor    09-02 23:00  -  abc");
    expect(frame).not.toContain("[sync] activity line");
  });

  it("clips studied rows to the frame width so they never outrun the tab rule", () => {
    const status = makeStatus({
      state: {
        schema_version: 1,
        watermark: "x",
        consecutive_failures: 0,
        mined_sessions: [
          {
            at: "2026-09-02T23:00:00.000Z",
            session: "cursor/a60cacd1-2d66-455d-b220-0123456789ab",
            project: "Users-james-Documents-dosu-global-dosu-cli",
          },
        ],
      },
    });
    const width = 63;
    const frame = stripAnsi(
      renderActivityFrame(status, [], width, null, { tab: "studied", scroll: 0 }),
    );
    const row = frame.split("\n").find((line) => line.startsWith("cursor"));
    expect(row).toBeDefined();
    expect(row?.length).toBeLessThanOrEqual(width);
    expect(row?.endsWith("\u2026")).toBe(true);
  });

  it("lists the f toggle in the key legend on every tab, with no CLI hint clutter", () => {
    const queuedFrame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "queued", scroll: 0 }, [
        queuedSession(),
      ]),
    );
    expect(queuedFrame).toContain("\u2191\u2193 scroll \u00B7 f full rows \u00B7 s sync now");
    expect(queuedFrame).not.toContain("dosu knowledge sessions");

    const activityFrame = stripAnsi(
      renderActivityFrame(makeStatus(), ["[sync] line"], 64, null, { tab: "activity", scroll: 0 }),
    );
    expect(activityFrame).toContain("\u00B7 f full rows \u00B7");
    expect(activityFrame).not.toContain("dosu logs");

    // The legend lists f even with nothing to expand yet.
    const emptyFrame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "activity", scroll: 0 }),
    );
    expect(emptyFrame).toContain("f full rows");
  });

  it("shows activity lines unclipped and wrapped in full mode", () => {
    const width = 40;
    const tail = "/Users/james/Documents/dosu-global/dosu-cli/src/tui/activity-view.ts";
    const line = `[2026-09-02T21:00:00.000Z] [INFO] [sync] wrote ${tail}`;

    const clipped = stripAnsi(
      renderActivityFrame(makeStatus(), [line], width, null, { tab: "activity", scroll: 0 }),
    );
    expect(clipped).not.toContain(tail);
    expect(
      clipped.split("\n").some((row) => row.startsWith("21:00:00") && row.endsWith("\u2026")),
    ).toBe(true);

    const full = stripAnsi(
      renderActivityFrame(makeStatus(), [line], width, null, {
        tab: "activity",
        scroll: 0,
        fullRows: true,
      }),
    );
    // The log row wraps to the frame width (with the hanging indent) instead of clipping.
    const rows = full.split("\n");
    const start = rows.findIndex((row) => row.startsWith("21:00:00"));
    expect(start).toBeGreaterThan(-1);
    expect(rows[start].length).toBeLessThanOrEqual(width);
    expect(rows[start + 1].startsWith("  ")).toBe(true);
    expect(rows[start + 1].length).toBeLessThanOrEqual(width);
    expect(full.replaceAll("\n", "").replaceAll(" ", "")).toContain(tail);
    expect(full).not.toContain("\u2026");
    // The legend wraps to the narrow frame too, so compare it flattened.
    const legendRows = rows.slice(-2);
    expect(legendRows.join(" ").replace(/\s+/g, " ")).toContain(
      "\u2191\u2193 scroll \u00B7 f clip \u00B7 s sync now",
    );
    for (const row of legendRows) expect(row.length).toBeLessThanOrEqual(width);
  });

  it("clips the scroll counter line in a narrow frame instead of letting it wrap", () => {
    // Scrolled into the middle so both counters render; at the 20-column floor they don't fit.
    const queued = Array.from({ length: 30 }, (_, i) => queuedSession(`session-${i}`));
    const width = 20;
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], width, null, { tab: "queued", scroll: 5 }, queued),
    );
    const hint = frame.split("\n").find((line) => line.includes("earlier"));
    expect(hint).toBeDefined();
    expect(hint?.length).toBeLessThanOrEqual(width);
    expect(hint?.endsWith("\u2026")).toBe(true);
  });

  it("shows full rows wrapped to the width in full mode", () => {
    const status = makeStatus({
      state: {
        schema_version: 1,
        watermark: "x",
        consecutive_failures: 0,
        mined_sessions: [
          {
            at: "2026-09-02T23:00:00.000Z",
            session: "cursor/a60cacd1-2d66-455d-b220-0123456789ab",
            project: "Users-james-Documents-dosu-global-dosu-cli",
          },
        ],
      },
    });
    const width = 63;
    const frame = stripAnsi(
      renderActivityFrame(status, [], width, null, { tab: "studied", scroll: 0, fullRows: true }),
    );
    // No line outruns the frame, nothing is clipped, and the whole id survives the wrap.
    for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
    expect(
      frame.split("\n").some((line) => line.startsWith("cursor") && line.includes("\u2026")),
    ).toBe(false);
    const joined = frame.replaceAll("\n", "").replaceAll(" ", "");
    expect(joined).toContain("a60cacd1-2d66-455d-b220-0123456789ab");
    expect(joined).toContain("Users-james-Documents-dosu-global-dosu-cli");
    expect(frame).toContain("\u00B7 f clip \u00B7");
    expect(frame).not.toContain("f full rows");
  });

  it("windows fewer rows in full mode so wrapped rows fit the screen", () => {
    const queued = Array.from({ length: 8 }, (_, i) => queuedSession(`session-${i}`));
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus(),
        [],
        64,
        null,
        { tab: "queued", scroll: 0, fullRows: true },
        queued,
      ),
    );
    expect(frame).toContain(`session-${8 - ACTIVITY_VIEW_FULL_LIST_ROWS}`);
    expect(frame).not.toContain(`session-${8 - ACTIVITY_VIEW_FULL_LIST_ROWS - 1}`);
    expect(frame).toContain(`\u2191 ${8 - ACTIVITY_VIEW_FULL_LIST_ROWS} earlier`);
  });

  it("shows an empty message on the studied tab before any history", () => {
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "studied", scroll: 0 }),
    );
    expect(frame).toContain("Studied (0)");
    expect(frame).toContain("No studied sessions yet.");
  });

  it("renders the queued tab with agent, updated, project, and session id", () => {
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus(),
        ["[sync] activity line"],
        80,
        null,
        { tab: "queued", scroll: 0 },
        [queuedSession()],
      ),
    );
    expect(frame).toContain("cursor");
    expect(frame).toContain("08-27 21:05");
    expect(frame).toContain("Users-james-dosu-cli");
    expect(frame).toContain("848b3896-fb07");
    expect(frame).not.toContain("[sync] activity line");
  });

  it("collapses repeat study passes to the session's latest row and counts unique sessions", () => {
    const status = makeStatus({
      state: {
        schema_version: 1,
        watermark: "2026-05-12T19:00:00.000Z",
        consecutive_failures: 0,
        mined_sessions: [
          { at: "2026-05-12T17:00:00.000Z", session: "cursor/dup-1", project: "p" },
          { at: "2026-05-12T18:00:00.000Z", session: "claude/solo-1", project: "p" },
          { at: "2026-05-12T19:00:00.000Z", session: "cursor/dup-1", project: "p" },
        ],
      },
    });
    const frame = stripAnsi(
      renderActivityFrame(status, [], 80, null, { tab: "studied", scroll: 0 }),
    );
    expect(frame).toContain("Studied (2)");
    const dupRows = frame.split("\n").filter((line) => line.includes("dup-1"));
    expect(dupRows).toHaveLength(1);
    expect(dupRows[0]).toContain("05-12 19:00");
  });

  it("shows the resolved project name instead of the stored slug when provided", () => {
    const status = makeStatus({
      state: {
        schema_version: 1,
        watermark: "2026-05-12T17:16:26.769Z",
        consecutive_failures: 0,
        mined_sessions: [
          {
            at: "2026-05-12T17:16:26.769Z",
            session: "claude/abc123",
            project: "Users-spencer-Documents-GitHub-dosu",
          },
        ],
      },
    });
    const frame = stripAnsi(
      renderActivityFrame(status, [], 80, null, { tab: "studied", scroll: 0 }, [], 0, [], null, {
        "claude/abc123": "dosu",
      }),
    );
    const row = frame.split("\n").find((line) => line.startsWith("claude"));
    expect(row).toContain("dosu");
    expect(row).not.toContain("Users-spencer");
  });

  it("names queued rows through the same lookup, falling back to the slug when absent", () => {
    const session = queuedSession();
    const frame = stripAnsi(
      renderActivityFrame(
        makeStatus(),
        [],
        80,
        null,
        { tab: "queued", scroll: 0 },
        [session],
        0,
        [],
        null,
        { [`${session.harness}/${session.id}`]: "dosu-cli" },
      ),
    );
    const row = frame.split("\n").find((line) => line.startsWith(session.harness));
    expect(row).toContain("dosu-cli");
  });

  it("shows an empty message on the queued tab when the backlog is drained", () => {
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "queued", scroll: 0 }),
    );
    expect(frame).toContain("Queued (0)");
    expect(frame).toContain("Queue empty");
  });

  it("explains missing history when pre-history runs already advanced the watermark", () => {
    const status = makeStatus({
      state: { schema_version: 1, watermark: "2026-05-12T17:16:26.769Z", consecutive_failures: 0 },
    });
    const frame = stripAnsi(
      renderActivityFrame(status, [], 64, null, { tab: "studied", scroll: 0 }),
    );
    expect(frame).toContain("History starts with the next study run");
  });

  it("windows long lists and reports scrollback on both sides", () => {
    const activity = Array.from({ length: 25 }, (_, i) => `[sync] line ${i}`);
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), activity, 64, null, { tab: "activity", scroll: 5 }),
    );
    expect(frame).toContain("[sync] line 19");
    expect(frame).not.toContain("[sync] line 24");
    expect(frame).toContain("\u2191 10 earlier \u00B7 \u2193 5 newer");
  });
});

// --- runActivityView: driven through fake streams and timers ---

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
  const output = {
    isTTY: true,
    columns: 80,
    write(chunk: string) {
      written.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  return { input, output, written };
}

describe("runActivityView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names rows through the default resolver stack when no rowNames is injected", async () => {
    const home = mkdtempSync(join(tmpdir(), "dosu-namer-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    try {
      // Studied claude session, reconstructable from slug + id, with a summary title.
      const slug = "Users-u-repos-dosu";
      const claudeDir = join(home, ".claude", "projects", slug);
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "abc.jsonl"),
        `${JSON.stringify({ type: "summary", summary: "Fix the studying race" })}\n${JSON.stringify(
          { cwd: join(home, "repos", "dosu") },
        )}\n`,
      );
      // Queued cursor session with a real transcript carrying a tagged query.
      const cursorDir = join(home, ".cursor", "projects", slug, "agent-transcripts", "q1");
      mkdirSync(cursorDir, { recursive: true });
      const cursorPath = join(cursorDir, "q1.jsonl");
      writeFileSync(
        cursorPath,
        `${JSON.stringify({
          role: "user",
          message: { content: "<user_query>ship the studying rename</user_query>" },
        })}\n`,
      );
      mkdirSync(join(home, "repos", "dosu"), { recursive: true });

      const status = makeStatus({
        state: {
          schema_version: 1,
          watermark: "2026-09-02T21:00:00.000Z",
          consecutive_failures: 0,
          mined_sessions: [
            { at: "2026-09-02T21:00:00.000Z", session: "claude/abc", project: slug },
          ],
        },
      });
      const queued = {
        id: "q1",
        harness: "cursor" as const,
        path: cursorPath,
        project: slug,
        updated: "2026-09-02T21:05:00.000Z",
      };
      const { input, output, written } = fakeIO();
      const view = runActivityView({
        input,
        output,
        getStatus: () => status,
        readLog: () => "",
        createFollower: () => ({ poll() {} }),
        listBacklog: () => ({ queued: [queued], open: [] }),
        pollMs: 100,
      });
      input.emit("data", "\t"); // Studied tab
      input.emit("data", "\t"); // Queued tab
      const rendered = stripAnsi(written.join(""));
      // Studied row: title reconstructed from slug + id, claude summary wins
      // (rows clip to the fake terminal width, so match a prefix).
      expect(rendered).toContain("Fix the studying r");
      // Queued row: the tagged user query names it.
      expect(rendered).toContain("ship the studying");
      input.emit("data", "q");
      await view;
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await runActivityView({ input, output });
    expect(written).toEqual([]);
  });

  it("seeds from the log, tails new lines and backlog on poll, and exits on q", async () => {
    const { input, output, written } = fakeIO();
    const chunks: string[] = [
      "[2026-09-02T21:00:05.000Z] [INFO] [learner] wrote note 1/20\n" +
        "[2026-09-02T21:00:06.000Z] [DEBUG] [sync] gate: 44 ready, 0 in flight (watermark x)\n",
    ];
    let emit: (chunk: string) => void = () => {};

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus({ running: true, pid: 99 }),
      readLog: () =>
        "[2026-09-02T21:00:00.000Z] [DEBUG] [sync] gate: 49 ready, 0 in flight (watermark none)\n",
      createFollower: (handler) => {
        emit = handler;
        return {
          poll() {
            const next = chunks.shift();
            if (next) emit(next);
          },
        };
      },
      pollMs: 100,
    });

    // Takes over the terminal before the first frame, seeded with the log's activity and
    // backlog counts (the gate's ready count drives the live run's progress bar).
    expect(written.join("")).toContain(ALT_SCREEN_ENTER);
    expect(stripAnsi(written.join(""))).toContain("[sync] gate: 49 ready");
    expect(stripAnsi(written.join(""))).toContain("0/49 studied");

    vi.advanceTimersByTime(100);
    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("[learner] wrote note 1/20");
    expect(rendered).toContain("0/44 studied");

    input.emit("data", "q");
    await view;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
    // Going back restores the previous terminal contents.
    expect(written.join("")).toContain(ALT_SCREEN_EXIT);
  });

  it("cycles studied → queued → open on tab and scrolls with the arrows", async () => {
    const { input, output, written } = fakeIO();
    const seed = Array.from(
      { length: 15 },
      (_, i) => `[2026-09-02T23:01:0${i % 10}.000Z] [INFO] [sync] activity ${i}`,
    ).join("\n");

    const view = runActivityView({
      input,
      output,
      getStatus: studiedStatus,
      readLog: () => seed,
      createFollower: () => ({ poll() {} }),
      listBacklog: () => ({ queued: [queuedSession()], open: [queuedSession("open-1")] }),
      pollMs: 100,
    });

    // 15 activity lines, 10-line window: scrolling up reveals the earliest.
    expect(stripAnsi(written.join(""))).not.toContain("activity 2 ");
    for (let i = 0; i < 5; i++) input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.join(""))).toContain("activity 2");

    // First tab flips to the studied-sessions history from the persisted state.
    input.emit("data", "\t");
    const afterFirstTab = stripAnsi(written.at(-1) ?? "");
    expect(afterFirstTab).toContain("Studied (1)");
    expect(afterFirstTab).toContain("cursor    09-02 23:00  -  abc");

    // Second tab lands on the queued backlog from the injected scanner.
    input.emit("data", "\t");
    const afterSecondTab = stripAnsi(written.at(-1) ?? "");
    expect(afterSecondTab).toContain("Users-james-dosu-cli");
    expect(afterSecondTab).toContain("848b3896-fb07");

    // Third tab shows the still-open sessions from the same scan.
    input.emit("data", "\t");
    const afterThirdTab = stripAnsi(written.at(-1) ?? "");
    expect(afterThirdTab).toContain("Open (1)");
    expect(afterThirdTab).toContain("open-1");

    input.emit("data", "q");
    await view;
  });

  it("toggles full rows with f on every tab, one shared state", async () => {
    const { input, output, written } = fakeIO();
    const longId = "a60cacd1-2d66-455d-b220-0123456789ab";
    const longPath = "/Users/james/Documents/dosu-global/dosu-cli/src/tui/activity-view.ts";

    const view = runActivityView({
      input,
      output,
      getStatus: makeStatus,
      readLog: () => `[2026-09-02T21:00:00.000Z] [INFO] [sync] wrote ${longPath}\n`,
      createFollower: () => ({ poll() {} }),
      listBacklog: () => ({ queued: [queuedSession(longId)], open: [] }),
      pollMs: 100,
    });

    // The activity tab clips long log lines by default (frame is 63 wide)...
    const activityClipped = stripAnsi(written.at(-1) ?? "");
    expect(activityClipped).not.toContain(longPath);
    expect(activityClipped).toContain("\u00B7 f full rows \u00B7");

    // ...and f expands them in place, wrapped.
    input.emit("data", "f");
    const activityFull = stripAnsi(written.at(-1) ?? "");
    expect(activityFull.replaceAll("\n", "").replaceAll(" ", "")).toContain(longPath);
    expect(activityFull).toContain("\u00B7 f clip \u00B7");

    // The toggle is shared: Queued opens already in full mode.
    input.emit("data", "\t");
    input.emit("data", "\t");
    const queuedFull = stripAnsi(written.at(-1) ?? "");
    expect(queuedFull.replaceAll("\n", "").replaceAll(" ", "")).toContain(longId);

    // f back to clipped (column clip plus the frame-width clip).
    input.emit("data", "f");
    const clipped = stripAnsi(written.at(-1) ?? "");
    expect(clipped).toContain(longId.slice(0, 10));
    expect(clipped).not.toContain(longId);
    expect(clipped).toContain("f full rows");

    // f expands to the full id (the frame is 63 wide, so the row wraps).
    input.emit("data", "f");
    const full = stripAnsi(written.at(-1) ?? "");
    expect(full.replaceAll("\n", "").replaceAll(" ", "")).toContain(longId);
    expect(full).toContain("\u00B7 f clip \u00B7");

    // f again clips back.
    input.emit("data", "f");
    const reclipped = stripAnsi(written.at(-1) ?? "");
    expect(reclipped).not.toContain(longId);
    expect(reclipped).toContain("f full rows");

    input.emit("data", "q");
    await view;
  });

  it("scrolls against the shorter full-rows window after f", async () => {
    const { input, output, written } = fakeIO();
    // 8 short lines: they all fit the default 10-line window but not the 5-row full window.
    const seed = Array.from(
      { length: 8 },
      (_, i) => `[2026-09-02T23:01:0${i}.000Z] [INFO] [sync] activity ${i}`,
    ).join("\n");

    const view = runActivityView({
      input,
      output,
      getStatus: makeStatus,
      readLog: () => seed,
      createFollower: () => ({ poll() {} }),
      pollMs: 100,
    });

    // Clipped mode: everything is visible, so up has nothing to reveal and redraws nothing.
    expect(stripAnsi(written.at(-1) ?? "")).toContain("activity 0");
    const framesBefore = written.length;
    input.emit("data", `${ESC}[A`);
    expect(written.length).toBe(framesBefore);

    // Full mode windows ACTIVITY_VIEW_FULL_LIST_ROWS rows, pinned to the newest.
    input.emit("data", "f");
    const full = stripAnsi(written.at(-1) ?? "");
    expect(full).not.toContain("activity 0");
    expect(full).toContain(`\u2191 ${8 - ACTIVITY_VIEW_FULL_LIST_ROWS} earlier`);

    // Scrolling up walks back to the earliest row and then stops at the window's edge.
    for (let i = 0; i < 8 - ACTIVITY_VIEW_FULL_LIST_ROWS; i++) input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.at(-1) ?? "")).toContain("activity 0");
    const framesAtTop = written.length;
    input.emit("data", `${ESC}[A`);
    expect(written.length).toBe(framesAtTop);

    input.emit("data", "q");
    await view;
  });

  it("baselines run progress when the run appears and tracks it batch by batch", async () => {
    const { input, output, written } = fakeIO();
    let totalStudied = 568;
    let emitChunk: (chunk: string) => void = () => {};

    const view = runActivityView({
      input,
      output,
      getStatus: () =>
        makeStatus({
          running: true,
          pid: 9,
          state: {
            schema_version: 1,
            watermark: null,
            consecutive_failures: 0,
            total_mined: totalStudied,
          },
        }),
      readLog: () =>
        "[2026-09-03T16:00:00.000Z] [INFO] [sync] gate: 1 ready, 0 in flight (watermark x)\n",
      createFollower: (handler) => {
        emitChunk = handler;
        return { poll() {} };
      },
      pollMs: 100,
    });

    // First frame: run live on an install with 568 lifetime sessions and a
    // 1-session queue — the bar is run-scoped, not 568/569 ≈ 99%.
    expect(stripAnsi(written.join(""))).toContain("0/1 studied \u00B7 0%");

    // The run mines the session: lifetime counter bumps, gate drains.
    totalStudied = 569;
    emitChunk(
      "[2026-09-03T16:00:20.000Z] [INFO] [sync] gate: 0 ready, 0 in flight (watermark y)\n",
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("1/1 studied \u00B7 100%");

    input.emit("data", "q");
    await view;
  });

  it("uses the run baseline the studying process persisted (survives reopening mid-run)", async () => {
    const { input, output, written } = fakeIO();

    // The view opens mid-run: 8 sessions already studied this run (568 - 560),
    // 2 still queued. Without the persisted baseline this would read 0/2.
    const view = runActivityView({
      input,
      output,
      getStatus: () =>
        makeStatus({
          running: true,
          pid: 9,
          state: {
            schema_version: 1,
            watermark: null,
            consecutive_failures: 0,
            total_mined: 568,
            run: { pid: 9, started_at: "2026-09-03T16:00:00Z", baseline_mined: 560 },
          },
        }),
      readLog: () =>
        "[2026-09-03T16:05:00.000Z] [INFO] [sync] gate: 2 ready, 0 in flight (watermark x)\n",
      createFollower: () => ({ poll() {} }),
      pollMs: 100,
    });

    expect(stripAnsi(written.join(""))).toContain("8/10 studied \u00B7 80%");

    input.emit("data", "q");
    await view;
  });

  it("ignores a stale run record from a different pid (falls back to the snapshot)", async () => {
    const { input, output, written } = fakeIO();

    const view = runActivityView({
      input,
      output,
      getStatus: () =>
        makeStatus({
          running: true,
          pid: 9,
          state: {
            schema_version: 1,
            watermark: null,
            consecutive_failures: 0,
            total_mined: 568,
            // A crashed earlier run's record; this run hasn't written its own yet.
            run: { pid: 7, started_at: "2026-09-03T15:00:00Z", baseline_mined: 500 },
          },
        }),
      readLog: () =>
        "[2026-09-03T16:05:00.000Z] [INFO] [sync] gate: 2 ready, 0 in flight (watermark x)\n",
      createFollower: () => ({ poll() {} }),
      pollMs: 100,
    });

    expect(stripAnsi(written.join(""))).toContain("0/2 studied \u00B7 0%");

    input.emit("data", "q");
    await view;
  });

  it("steps the bar within a batch from the learner's tool-call traces", async () => {
    const { input, output, written } = fakeIO();
    let emitChunk: (chunk: string) => void = () => {};

    const view = runActivityView({
      input,
      output,
      getStatus: () =>
        makeStatus({
          running: true,
          pid: 9,
          state: { schema_version: 1, watermark: null, consecutive_failures: 0, total_mined: 0 },
        }),
      readLog: () =>
        "[2026-09-03T16:00:00.000Z] [INFO] [sync] gate: 2 ready, 0 in flight (watermark x)\n" +
        "[2026-09-03T16:00:01.000Z] [DEBUG] [sync] studying 2 of 2 ready sessions (0 trivial skipped)\n",
      createFollower: (handler) => {
        emitChunk = handler;
        return { poll() {} };
      },
      pollMs: 100,
    });

    // Batch started, first session opened: still 0/2 (it's in flight).
    emitChunk(
      '[2026-09-03T16:00:05.000Z] [DEBUG] [learner] [agent] \u2192 mcp__sessions__read_session {"id":"s-1"}\n',
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("0/2 studied \u00B7 0%");

    // A note lands and the learner moves on to the second session: 1/2.
    emitChunk(
      '[2026-09-03T16:00:07.000Z] [DEBUG] [learner] [agent] \u2192 mcp__dosu__write_knowledge {"title":"x"}\n' +
        '[2026-09-03T16:00:09.000Z] [DEBUG] [learner] [agent] \u2192 mcp__sessions__read_session {"id":"s-2"}\n',
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("1/2 studied \u00B7 50% \u00B7 1 suggested page");

    input.emit("data", "q");
    await view;
  });

  it("rescans the backlog when the watermark moves or a backlog tab is entered", async () => {
    const { input, output } = fakeIO();
    let watermark: string | null = null;
    const listBacklog = vi.fn(() => ({ queued: [queuedSession()], open: [] }));

    const view = runActivityView({
      input,
      output,
      getStatus: () =>
        makeStatus({
          state: { schema_version: 1, watermark, consecutive_failures: 0 },
        }),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      listBacklog,
      pollMs: 100,
    });

    expect(listBacklog).toHaveBeenCalledTimes(1);
    // Polls without a watermark change reuse the cached backlog.
    vi.advanceTimersByTime(300);
    expect(listBacklog).toHaveBeenCalledTimes(1);

    // A studied batch moves the watermark: the next poll rescans.
    watermark = "2026-09-02T23:59:00.000Z";
    vi.advanceTimersByTime(100);
    expect(listBacklog).toHaveBeenCalledTimes(2);

    // Entering Studied reads persisted history without rescanning, but Queued rescans: open
    // sessions drain into the queue without the watermark ever moving.
    input.emit("data", "\t");
    expect(listBacklog).toHaveBeenCalledTimes(2);
    input.emit("data", "\t");
    expect(listBacklog).toHaveBeenCalledTimes(3);

    input.emit("data", "q");
    await view;
  });

  it("s asks for confirmation with the queue size, enter starts the run", async () => {
    const { input, output, written } = fakeIO();
    const startSync = vi.fn(() => true);

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () =>
        "[2026-09-03T16:00:00.000Z] [INFO] [sync] gate: 2 ready, 1 in flight (watermark none)\n",
      createFollower: () => ({ poll() {} }),
      startSync,
      listBacklog: () => ({ queued: [queuedSession(), queuedSession("b2")], open: [] }),
      pollMs: 100,
    });

    // s alone must not start anything — it raises the confirmation.
    input.emit("data", "s");
    expect(startSync).not.toHaveBeenCalled();
    const prompt = stripAnsi(written.join(""));
    expect(prompt).toContain("Start studying now?");
    expect(prompt).toContain("Dosu reads 2 sessions (+1 still open; it joins once quiet)");
    expect(prompt).toContain("enter start \u00B7 esc cancel");

    input.emit("data", "\r");
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(stripAnsi(written.join(""))).toContain(
      "[sync] sync requested \u00B7 starting a background run",
    );

    input.emit("data", "q");
    await view;
  });

  it("the default sync spawn omits --quiet so a manual run ignores the failure backoff", async () => {
    mockSpawnDetachedSelf.mockClear();
    const { input, output } = fakeIO();

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      // No startSync injected: the view falls through to spawnDetachedSelf.
      listBacklog: () => ({ queued: [queuedSession()], open: [] }),
      pollMs: 100,
    });

    input.emit("data", "s");
    input.emit("data", "\r");
    expect(mockSpawnDetachedSelf).toHaveBeenCalledWith(["knowledge", "sync", "--bootstrap"]);

    input.emit("data", "q");
    await view;
  });

  it("esc cancels the confirmation without starting or leaving the view", async () => {
    const { input, output, written } = fakeIO();
    const startSync = vi.fn(() => true);

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync,
      listBacklog: () => ({ queued: [], open: [] }),
      pollMs: 100,
    });

    input.emit("data", "s");
    expect(stripAnsi(written.join(""))).toContain("Queue is empty");
    input.emit("data", ESC);
    expect(startSync).not.toHaveBeenCalled();
    // The view is still open (esc consumed by the prompt): the legend is back.
    const after = stripAnsi(written.join(""));
    expect(after).toContain("s sync now");

    input.emit("data", "q");
    await view;
  });

  it("reports a failed spawn instead of pretending the sync started", async () => {
    const { input, output, written } = fakeIO();

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync: () => false,
      pollMs: 100,
    });

    input.emit("data", "s");
    input.emit("data", "\r");
    expect(stripAnsi(written.join(""))).toContain("could not start a background run");

    input.emit("data", "q");
    await view;
  });

  it("s while running asks to stop; enter kills the run and pauses studying", async () => {
    const { input, output, written } = fakeIO();
    const startSync = vi.fn(() => true);
    const stopSync = vi.fn(() => true);
    const setPaused = vi.fn();

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus({ running: true, pid: 7 }),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync,
      stopSync,
      setPaused,
      pollMs: 100,
    });

    input.emit("data", "s");
    expect(stopSync).not.toHaveBeenCalled();
    const prompt = stripAnsi(written.join(""));
    expect(prompt).toContain("Stop studying?");
    expect(prompt).toContain("enter stop \u00B7 esc cancel");

    input.emit("data", "\r");
    expect(stopSync).toHaveBeenCalledWith(7);
    expect(setPaused).toHaveBeenCalledWith(true);
    expect(startSync).not.toHaveBeenCalled();
    expect(stripAnsi(written.join(""))).toContain(
      "[sync] studying stopped \u00B7 paused until you resume",
    );

    input.emit("data", "q");
    await view;
  });

  it("reports a stop that could not deliver a signal without pausing", async () => {
    const { input, output, written } = fakeIO();
    const setPaused = vi.fn();

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus({ running: true, pid: 7 }),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      stopSync: () => false,
      setPaused,
      pollMs: 100,
    });

    input.emit("data", "s");
    input.emit("data", "\r");
    expect(setPaused).not.toHaveBeenCalled();
    expect(stripAnsi(written.join(""))).toContain("could not stop the run");

    input.emit("data", "q");
    await view;
  });

  it("s while paused asks to resume; enter clears the pause and starts a run", async () => {
    const { input, output, written } = fakeIO();
    const startSync = vi.fn(() => true);
    const setPaused = vi.fn();
    const paused = makeStatus();
    paused.state.paused = true;

    const view = runActivityView({
      input,
      output,
      getStatus: () => paused,
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync,
      setPaused,
      pollMs: 100,
    });

    input.emit("data", "s");
    const prompt = stripAnsi(written.join(""));
    expect(prompt).toContain("Resume studying?");
    expect(prompt).toContain("enter resume \u00B7 esc cancel");

    input.emit("data", "\r");
    expect(setPaused).toHaveBeenCalledWith(false);
    expect(startSync).toHaveBeenCalledTimes(1);

    input.emit("data", "q");
    await view;
  });

  it("c asks to clear history; enter resets the state and rescans the queue", async () => {
    const { input, output, written } = fakeIO();
    const clearHistory = vi.fn();
    const startSync = vi.fn(() => true);
    const listBacklog = vi.fn(() => ({ queued: [], open: [] }));
    // The status reflects the reset once clearHistory has run, as the real state file would.
    const getStatus = () => {
      const status = makeStatus();
      status.state.watermark = clearHistory.mock.calls.length > 0 ? null : "2026-09-02T21:00:00Z";
      return status;
    };

    const view = runActivityView({
      input,
      output,
      getStatus,
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync,
      clearHistory,
      listBacklog,
      pollMs: 100,
    });
    const scansBefore = listBacklog.mock.calls.length;

    input.emit("data", "c");
    expect(clearHistory).not.toHaveBeenCalled();
    const prompt = stripAnsi(written.join(""));
    expect(prompt).toContain("Clear study history?");
    expect(prompt).toContain("enter clear \u00B7 esc cancel");

    input.emit("data", "\r");
    expect(clearHistory).toHaveBeenCalledTimes(1);
    expect(startSync).not.toHaveBeenCalled();
    // The watermark moved (to null), so the queue was rescanned on the redraw.
    expect(listBacklog.mock.calls.length).toBeGreaterThan(scansBefore);
    const after = stripAnsi(written.join(""));
    expect(after).toContain("[sync] study history cleared");
    expect(after).toContain("Nothing studied yet");

    input.emit("data", "q");
    await view;
  });

  it("esc cancels the clear confirmation without touching the state", async () => {
    const { input, output, written } = fakeIO();
    const clearHistory = vi.fn();
    const status = makeStatus();
    status.state.watermark = "2026-09-02T21:00:00Z";

    const view = runActivityView({
      input,
      output,
      getStatus: () => status,
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      clearHistory,
      pollMs: 100,
    });

    input.emit("data", "c");
    expect(stripAnsi(written.join(""))).toContain("Clear study history?");
    input.emit("data", ESC);
    expect(clearHistory).not.toHaveBeenCalled();
    expect(stripAnsi(written.at(-1) ?? "")).toContain("c clear");

    input.emit("data", "q");
    await view;
  });

  it("c is inert while a run is live or nothing has been studied", async () => {
    const { input, output, written } = fakeIO();
    const clearHistory = vi.fn();
    let status = makeStatus({ running: true, pid: 7 });
    status.state.watermark = "2026-09-02T21:00:00Z";

    const view = runActivityView({
      input,
      output,
      getStatus: () => status,
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      clearHistory,
      stopSync: () => true,
      setPaused: () => {},
      pollMs: 100,
    });

    input.emit("data", "c");
    expect(stripAnsi(written.join(""))).not.toContain("Clear study history?");

    // Idle but never studied: still nothing to clear.
    status = makeStatus();
    input.emit("data", "c");
    input.emit("data", "\r");
    expect(clearHistory).not.toHaveBeenCalled();

    input.emit("data", "q");
    await view;
  });

  it("drops a pending clear confirmation when a run starts elsewhere", async () => {
    vi.useFakeTimers();
    const { input, output, written } = fakeIO();
    const clearHistory = vi.fn();
    let status = makeStatus();
    status.state.watermark = "2026-09-02T21:00:00Z";

    const view = runActivityView({
      input,
      output,
      getStatus: () => status,
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      clearHistory,
      pollMs: 100,
    });

    input.emit("data", "c");
    expect(stripAnsi(written.join(""))).toContain("Clear study history?");

    status = makeStatus({ running: true, pid: 9 });
    status.state.watermark = "2026-09-02T21:00:00Z";
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.at(-1) ?? "")).not.toContain("Clear study history?");
    // Enter now has nothing to confirm.
    input.emit("data", "\r");
    expect(clearHistory).not.toHaveBeenCalled();

    input.emit("data", "q");
    await view;
    vi.useRealTimers();
  });

  it("skips the terminal write when a poll produces an identical frame", async () => {
    const { input, output, written } = fakeIO();
    let emit: (chunk: string) => void = () => {};

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: (handler) => {
        emit = handler;
        return { poll() {} };
      },
      pollMs: 100,
    });

    const afterFirstDraw = written.length;
    // Nothing changes across several polls: no new writes.
    vi.advanceTimersByTime(300);
    expect(written.length).toBe(afterFirstDraw);

    // New activity changes the frame: the next poll repaints.
    emit("[2026-09-02T21:00:05.000Z] [DEBUG] [sync] fresh line\n");
    vi.advanceTimersByTime(100);
    expect(written.length).toBeGreaterThan(afterFirstDraw);
    expect(stripAnsi(written.join(""))).toContain("[sync] fresh line");

    input.emit("data", "q");
    await view;
  });

  it("repaints on terminal resize even when the frame string is unchanged", async () => {
    const { input } = fakeIO();
    const written: string[] = [];
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    }) as unknown as NodeJS.WriteStream;

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
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

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      pollMs: 100,
    });

    // Home, then exactly the height-scaled cleared blank rows (+1 for the banner's leading
    // blank); the fake output has no rows, so the 24-row default applies.
    const first = written.join("");
    const blankRun = first.match(new RegExp(`${ESC}\\[H((?:${ESC}\\[K\\n)+)`));
    expect(blankRun).not.toBeNull();
    const blanks = (blankRun?.[1] ?? "").split("\n").length - 1;
    expect(blanks).toBe(frameTopMargin(24) + 1);

    input.emit("data", "q");
    await view;
  });

  it("stops polling after the user goes back", async () => {
    const { input, output } = fakeIO();
    const poll = vi.fn();

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus(),
      readLog: () => "",
      createFollower: () => ({ poll }),
      pollMs: 100,
    });

    input.emit("data", ESC);
    await view;
    vi.advanceTimersByTime(1000);
    expect(poll).not.toHaveBeenCalled();
  });
});
