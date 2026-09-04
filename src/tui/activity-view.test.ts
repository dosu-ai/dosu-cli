import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../sync/status";
import {
  ACTIVITY_VIEW_BUFFER_LINES,
  activityWidth,
  appendSyncActivity,
  confirmBox,
  cycleTab,
  foldRunProgress,
  formatActivityLine,
  formatMinedRow,
  formatQueuedRow,
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
} from "./activity-view";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./alt-screen";
import { frameTopMargin } from "./layout";

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

/** A status whose state carries mined-session history and an all-time count. */
function minedStatus(): SyncStatus {
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

  it("confirmation keys: enter/y/s start, esc/n/q cancel, rest ignored", () => {
    expect(reduceSyncConfirmKey("\r")).toBe("start");
    expect(reduceSyncConfirmKey("y")).toBe("start");
    expect(reduceSyncConfirmKey("s")).toBe("start");
    expect(reduceSyncConfirmKey(ESC)).toBe("cancel");
    expect(reduceSyncConfirmKey("n")).toBe("cancel");
    expect(reduceSyncConfirmKey("q")).toBe("cancel");
    expect(reduceSyncConfirmKey(`${ESC}[A`)).toBe("none");
  });

  it("cycles activity → mined → queued → open and wraps both ways", () => {
    expect(cycleTab("activity")).toBe("mined");
    expect(cycleTab("mined")).toBe("queued");
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
    expect(formatActivityLine("[2026-09-02T21:58:42.716Z] [miner] wrote note", 64)).toBe(
      "21:58:42 [miner] wrote note",
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
    const line = `[miner] [sdk] ${ESC}[31mred error${ESC}[0m done`;
    expect(formatActivityLine(line, 64)).toBe("[miner] [sdk] red error done");
  });
});

describe("appendSyncActivity", () => {
  it("keeps only sync and miner lines and strips the level tag", () => {
    const chunk = [
      "[2026-09-02T21:00:00.000Z] [INFO] [sync] run started",
      "[2026-09-02T21:00:01.000Z] [DEBUG] [telemetry] unrelated",
      "[2026-09-02T21:00:02.000Z] [INFO] [miner] wrote note",
    ].join("\n");
    expect(appendSyncActivity([], chunk)).toEqual([
      "[2026-09-02T21:00:00.000Z] [sync] run started",
      "[2026-09-02T21:00:02.000Z] [miner] wrote note",
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

describe("formatMinedRow", () => {
  it("lays out agent, mined-at, project, and session id like the queued tab", () => {
    expect(
      formatMinedRow({
        at: "2026-09-02T23:00:00.000Z",
        session: "cursor/abc-123",
        project: "dosu-cli",
      }),
    ).toBe("cursor    09-02 23:00  dosu-cli  abc-123");
  });

  it("shows '-' for records written before the project field existed", () => {
    expect(formatMinedRow({ at: "2026-09-02T23:00:00.000Z", session: "cursor/abc" })).toBe(
      "cursor    09-02 23:00  -  abc",
    );
  });

  it("falls back to the raw timestamp when it is not ISO", () => {
    expect(formatMinedRow({ at: "whenever", session: "cursor/abc" })).toBe(
      "cursor    whenever  -  abc",
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
      id: "a".repeat(40),
    });
    expect(row).toContain("  -  ");
    expect(row).toContain(`${"a".repeat(23)}\u2026`);
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
    expect(parseGateLine("[2026-09-02T21:00:00.000Z] [INFO] [miner] wrote note")).toBeNull();
  });
});

describe("latestBacklog", () => {
  it("returns the counts from the newest gate line", () => {
    const log = [
      "[sync] gate: 49 ready, 0 in flight (watermark none)",
      "[miner] wrote note",
      "[sync] gate: 44 ready, 1 in flight (watermark 2026-09-01)",
    ].join("\n");
    expect(latestBacklog(log)).toEqual({ ready: 44, inFlight: 1 });
  });

  it("returns null when no gate line exists", () => {
    expect(latestBacklog("[miner] wrote note\nplain line")).toBeNull();
  });
});

describe("foldRunProgress", () => {
  const marker =
    "[2026-09-03T16:00:01.000Z] [DEBUG] [sync] mining 2 of 5 ready sessions (1 trivial skipped)\n";
  const read = (id: string, offset = 0) =>
    `[2026-09-03T16:00:05.000Z] [DEBUG] [miner] [agent] \u2192 mcp__sessions__read_session {"id":"${id}","offset":${offset}}\n`;
  const note =
    '[2026-09-03T16:00:07.000Z] [DEBUG] [miner] [agent] \u2192 mcp__dosu__write_knowledge {"title":"x"}\n';

  it("starts a batch at the mining marker and counts distinct session reads", () => {
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

  it("ignores miner traces before any batch marker", () => {
    expect(foldRunProgress(null, read("s-1") + note)).toBeNull();
  });

  it("clears when the batch settles — committed, failed, or refused", () => {
    const live = foldRunProgress(null, marker + read("s-1"));
    expect(
      foldRunProgress(
        live,
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] mined 2 sessions, 4 suggested pages; watermark \u2192 y\n",
      ),
    ).toBeNull();
    expect(
      foldRunProgress(
        foldRunProgress(null, marker),
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] mining failed: error; boom\n",
      ),
    ).toBeNull();
    expect(
      foldRunProgress(
        foldRunProgress(null, marker),
        "[2026-09-03T16:00:30.000Z] [DEBUG] [sync] mining skipped by gateway: credit_limit\n",
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
    const lines = wrapLine("! Mining paused: credits are gone for now", 20);
    expect(lines).toEqual(["! Mining paused:", "  credits are gone", "  for now"]);
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
    expect(frame).toContain("\u26CF\uFE0F Mining sessions...");
    expect(frame).toContain("pid 4242");
  });

  it("shows idle state and the never-mined watermark", () => {
    const frame = stripAnsi(renderActivityFrame(makeStatus(), [], 64));
    expect(frame).toContain("Idle");
    expect(frame).toContain("Nothing mined yet");
    expect(frame).toContain("No sync activity in the log yet.");
  });

  it("flags a stale lock from a crashed run", () => {
    const frame = stripAnsi(renderActivityFrame(makeStatus({ staleLock: true, pid: 7 }), [], 64));
    expect(frame).toContain("Not running");
    expect(frame).toContain("exited without cleaning up");
  });

  it("renders a progress bar proportional to the drained backlog", () => {
    // 20 mined, 60 queued → 25% of an 80-session drain.
    const line = stripAnsi(progressLine(20, 60, 64) ?? "");
    expect(line).toContain("20/80 mined \u00B7 25%");
    const cells = 20; // width 64 minus the room reserved for the suffix
    expect(line).toContain("\u2588".repeat(Math.round(0.25 * cells)));
    expect(line).toContain("\u2591".repeat(cells - Math.round(0.25 * cells)));
  });

  it("returns no progress line when there is nothing to measure", () => {
    expect(progressLine(0, 0, 64)).toBeNull();
  });

  it("appends a live suggested-page count to the bar", () => {
    expect(stripAnsi(progressLine(0, 2, 64, 1) ?? "")).toContain(
      "0/2 mined \u00B7 0% \u00B7 1 suggested page",
    );
    expect(stripAnsi(progressLine(1, 1, 64, 7) ?? "")).toContain(
      "1/2 mined \u00B7 50% \u00B7 7 suggested pages",
    );
    expect(stripAnsi(progressLine(0, 2, 64, 0) ?? "")).not.toContain("suggested");
  });

  it("steps the bar within a live batch as the miner opens sessions", () => {
    const state = {
      schema_version: 1,
      watermark: null,
      consecutive_failures: 0,
      total_mined: 568,
    };
    // Queue of 2, single batch: the miner has opened both sessions, so the
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
    expect(frame).toContain("1/2 mined \u00B7 50% \u00B7 3 suggested pages");
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
    expect(frame).toContain("0/2 mined \u00B7 0% \u00B7 1 suggested page");
  });

  it("scopes the bar to the run: lifetime history does not pin it at ~100%", () => {
    // 568 sessions mined all-time, a hook just queued 1: the bar must read
    // 0/1 (this run hasn't mined anything yet), not 568/569 ≈ 99%.
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
    expect(frame).toContain("0/1 mined \u00B7 0%");
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
    expect(running).toContain("20/80 mined \u00B7 25%");

    const idle = stripAnsi(
      renderActivityFrame(makeStatus({ state }), [], 64, { ready: 60, inFlight: 0 }),
    );
    expect(idle).not.toContain("mined \u00B7");
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
    expect(withOpen).not.toContain("queue empty");
    expect(withOpen).not.toContain("queued when they finish");

    // No open sessions: plain zero counts, no noise.
    const drained = stripAnsi(renderActivityFrame(makeStatus(), [], 64, { ready: 0, inFlight: 0 }));
    expect(drained).toContain("Queued (0)");
    expect(drained).toContain("Open (0)");
    expect(drained).not.toContain("queue empty");
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
    expect(frame).toContain("Mined sessions up to");
    expect(frame).toContain("retrying after");
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
    expect(frame).toContain("Mining paused: Your org has used its Dosu credits");
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
    expect(frame).not.toContain("Mining paused");
  });

  it("underlines the active tab in the quiet two-line strip", () => {
    const [row, rule] = tabBar("mined", 3, 2, 577, 60).map(stripAnsi);
    // Order: Activity, Mined, Queued, Open.
    expect(row.indexOf("Activity")).toBeLessThan(row.indexOf("Mined (577)"));
    expect(row.indexOf("Mined (577)")).toBeLessThan(row.indexOf("Queued (3)"));
    expect(row.indexOf("Queued (3)")).toBeLessThan(row.indexOf("Open (2)"));
    // No folder-tab chrome: just the labels and the rule.
    expect(row).not.toContain("\u2502");
    // The heavy segment of the rule sits exactly under the active label...
    const start = row.indexOf("Mined (577)");
    expect(rule.indexOf("\u2501")).toBe(start);
    expect(rule.lastIndexOf("\u2501")).toBe(start + "Mined (577)".length - 1);
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
    expect(row).toContain("Activity   Mined (577)");
  });

  it("shows all three tabs with counts, activity active by default", () => {
    const frame = stripAnsi(
      renderActivityFrame(minedStatus(), [], 64, null, undefined, [queuedSession()]),
    );
    expect(frame).toContain("Activity");
    expect(frame).toContain("Queued (1)");
    expect(frame).toContain("Mined (7)");
    expect(frame).toContain(
      "tab switch \u00B7 \u2191\u2193 scroll \u00B7 s sync now \u00B7 esc back",
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

  it("offers the sync trigger only while idle", () => {
    const idle = stripAnsi(renderActivityFrame(makeStatus(), [], 64));
    expect(idle).toContain("s sync now");

    const running = stripAnsi(renderActivityFrame(makeStatus({ running: true, pid: 1 }), [], 64));
    expect(running).not.toContain("s sync now");
  });

  it("replaces the key legend with the confirmation popup while confirm is pending", () => {
    const pane = { tab: "activity" as const, scroll: 0, confirm: true };
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, { ready: 3, inFlight: 0 }, pane, [
        queuedSession("a"),
        queuedSession("b"),
        queuedSession("c"),
      ]),
    );
    expect(frame).toContain("Start mining now?");
    expect(frame).toContain("3 sessions queued \u00B7 runs in the background");
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
    // No variation-selector emoji inside the box: xterm.js terminals advance
    // one column for the U+26CF+U+FE0F pair while the padding counts two,
    // which pushed the title row's right border one column off.
    expect(box.join("")).not.toContain("\uFE0F");
  });

  it("wraps the popup scope line in a narrow terminal instead of breaking the border", () => {
    const box = confirmBox(12, { ready: 12, inFlight: 2 }, 40).map(stripAnsi);
    for (const line of box) {
      expect(line.trimEnd().length).toBeLessThanOrEqual(40);
    }
    expect(box.join("\n")).toContain("12 sessions queued");
  });

  it("renders the mined-sessions tab from the state's history", () => {
    const frame = stripAnsi(
      renderActivityFrame(minedStatus(), ["[sync] activity line"], 64, null, {
        tab: "mined",
        scroll: 0,
      }),
    );
    expect(frame).toContain("cursor    09-02 23:00  -  abc");
    expect(frame).not.toContain("[sync] activity line");
  });

  it("clips mined rows to the frame width so they never outrun the tab rule", () => {
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
      renderActivityFrame(status, [], width, null, { tab: "mined", scroll: 0 }),
    );
    const row = frame.split("\n").find((line) => line.startsWith("cursor"));
    expect(row).toBeDefined();
    expect(row?.length).toBeLessThanOrEqual(width);
    expect(row?.endsWith("\u2026")).toBe(true);
  });

  it("shows an empty message on the mined tab before any history", () => {
    const frame = stripAnsi(
      renderActivityFrame(makeStatus(), [], 64, null, { tab: "mined", scroll: 0 }),
    );
    expect(frame).toContain("Mined (0)");
    expect(frame).toContain("No mined sessions yet.");
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
    const frame = stripAnsi(renderActivityFrame(status, [], 64, null, { tab: "mined", scroll: 0 }));
    expect(frame).toContain("History starts with the next mining run");
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

// ---------------------------------------------------------------------------
// runActivityView — driven through fake streams and timers
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

  it("resolves immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await runActivityView({ input, output });
    expect(written).toEqual([]);
  });

  it("seeds from the log, tails new lines and backlog on poll, and exits on q", async () => {
    const { input, output, written } = fakeIO();
    const chunks: string[] = [
      "[2026-09-02T21:00:05.000Z] [INFO] [miner] wrote note 1/20\n" +
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

    // Takes over the terminal full-screen before the first frame,
    // seeded with the log's activity and backlog counts (the gate's ready
    // count drives the live run's progress bar).
    expect(written.join("")).toContain(ALT_SCREEN_ENTER);
    expect(stripAnsi(written.join(""))).toContain("[sync] gate: 49 ready");
    expect(stripAnsi(written.join(""))).toContain("0/49 mined");

    vi.advanceTimersByTime(100);
    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("[miner] wrote note 1/20");
    expect(rendered).toContain("0/44 mined");

    input.emit("data", "q");
    await view;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
    // Going back restores the previous terminal contents.
    expect(written.join("")).toContain(ALT_SCREEN_EXIT);
  });

  it("cycles mined → queued → open on tab and scrolls with the arrows", async () => {
    const { input, output, written } = fakeIO();
    const seed = Array.from(
      { length: 15 },
      (_, i) => `[2026-09-02T23:01:0${i % 10}.000Z] [INFO] [sync] activity ${i}`,
    ).join("\n");

    const view = runActivityView({
      input,
      output,
      getStatus: minedStatus,
      readLog: () => seed,
      createFollower: () => ({ poll() {} }),
      listBacklog: () => ({ queued: [queuedSession()], open: [queuedSession("open-1")] }),
      pollMs: 100,
    });

    // 15 activity lines, 10-line window: scrolling up reveals the earliest.
    expect(stripAnsi(written.join(""))).not.toContain("activity 2 ");
    for (let i = 0; i < 5; i++) input.emit("data", `${ESC}[A`);
    expect(stripAnsi(written.join(""))).toContain("activity 2");

    // First tab flips to the mined-sessions history from the persisted state.
    input.emit("data", "\t");
    const afterFirstTab = stripAnsi(written.at(-1) ?? "");
    expect(afterFirstTab).toContain("Mined (7)");
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

  it("baselines run progress when the run appears and tracks it batch by batch", async () => {
    const { input, output, written } = fakeIO();
    let totalMined = 568;
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
            total_mined: totalMined,
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
    expect(stripAnsi(written.join(""))).toContain("0/1 mined \u00B7 0%");

    // The run mines the session: lifetime counter bumps, gate drains.
    totalMined = 569;
    emitChunk(
      "[2026-09-03T16:00:20.000Z] [INFO] [sync] gate: 0 ready, 0 in flight (watermark y)\n",
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("1/1 mined \u00B7 100%");

    input.emit("data", "q");
    await view;
  });

  it("steps the bar within a batch from the miner's tool-call traces", async () => {
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
        "[2026-09-03T16:00:01.000Z] [DEBUG] [sync] mining 2 of 2 ready sessions (0 trivial skipped)\n",
      createFollower: (handler) => {
        emitChunk = handler;
        return { poll() {} };
      },
      pollMs: 100,
    });

    // Batch started, first session opened: still 0/2 (it's in flight).
    emitChunk(
      '[2026-09-03T16:00:05.000Z] [DEBUG] [miner] [agent] \u2192 mcp__sessions__read_session {"id":"s-1"}\n',
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("0/2 mined \u00B7 0%");

    // A note lands and the miner moves on to the second session: 1/2.
    emitChunk(
      '[2026-09-03T16:00:07.000Z] [DEBUG] [miner] [agent] \u2192 mcp__dosu__write_knowledge {"title":"x"}\n' +
        '[2026-09-03T16:00:09.000Z] [DEBUG] [miner] [agent] \u2192 mcp__sessions__read_session {"id":"s-2"}\n',
    );
    vi.advanceTimersByTime(100);
    expect(stripAnsi(written.join(""))).toContain("1/2 mined \u00B7 50% \u00B7 1 suggested page");

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

    // A mined batch moves the watermark: the next poll rescans.
    watermark = "2026-09-02T23:59:00.000Z";
    vi.advanceTimersByTime(100);
    expect(listBacklog).toHaveBeenCalledTimes(2);

    // Entering Mined doesn't rescan (it reads persisted history), but the
    // Queued tab does — open sessions drain into the queue without the
    // watermark ever moving.
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
    expect(prompt).toContain("Start mining now?");
    expect(prompt).toContain("2 sessions queued (+1 open, mined once it goes quiet)");
    expect(prompt).toContain("enter start \u00B7 esc cancel");

    input.emit("data", "\r");
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(stripAnsi(written.join(""))).toContain(
      "[sync] sync requested \u00B7 starting a background run",
    );

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
    expect(stripAnsi(written.join(""))).toContain("queue empty");
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

  it("ignores s while a run already holds the lock", async () => {
    const { input, output } = fakeIO();
    const startSync = vi.fn(() => true);

    const view = runActivityView({
      input,
      output,
      getStatus: () => makeStatus({ running: true, pid: 7 }),
      readLog: () => "",
      createFollower: () => ({ poll() {} }),
      startSync,
      pollMs: 100,
    });

    input.emit("data", "s");
    expect(startSync).not.toHaveBeenCalled();

    input.emit("data", "q");
    await view;
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
