import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../sync/status";
import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  appendSyncActivity,
  formatActivityLine,
  latestBacklog,
  parseGateLine,
  reduceSyncViewKey,
  renderSyncFrame,
  runSyncView,
  SYNC_VIEW_ACTIVITY_LINES,
} from "./sync-view";

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

describe("reduceSyncViewKey", () => {
  it("goes back on q, esc, and ctrl-c", () => {
    expect(reduceSyncViewKey("q")).toBe("back");
    expect(reduceSyncViewKey(ESC)).toBe("back");
    expect(reduceSyncViewKey(CTRL_C)).toBe("back");
  });

  it("ignores other keys", () => {
    expect(reduceSyncViewKey("j")).toBe("none");
    expect(reduceSyncViewKey("\r")).toBe("none");
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
    const seed = Array.from({ length: SYNC_VIEW_ACTIVITY_LINES }, (_, i) => `[sync] old ${i}`);
    const result = appendSyncActivity(seed, "[sync] new line");
    expect(result).toHaveLength(SYNC_VIEW_ACTIVITY_LINES);
    expect(result.at(-1)).toBe("[sync] new line");
    expect(result[0]).toBe("[sync] old 1");
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

describe("renderSyncFrame", () => {
  it("shows a live run with pid and start time", () => {
    const frame = stripAnsi(
      renderSyncFrame(
        makeStatus({ running: true, pid: 4242, startedAt: "2026-09-02T21:58:42.716Z" }),
        [],
        64,
      ),
    );
    expect(frame).toContain("Mining now");
    expect(frame).toContain("pid 4242");
  });

  it("shows idle state and the never-mined watermark", () => {
    const frame = stripAnsi(renderSyncFrame(makeStatus(), [], 64));
    expect(frame).toContain("Idle");
    expect(frame).toContain("Nothing mined yet");
    expect(frame).toContain("No sync activity in the log yet.");
  });

  it("flags a stale lock from a crashed run", () => {
    const frame = stripAnsi(renderSyncFrame(makeStatus({ staleLock: true, pid: 7 }), [], 64));
    expect(frame).toContain("Not running");
    expect(frame).toContain("exited without cleaning up");
  });

  it("shows the backlog when gate counts are known", () => {
    const queued = stripAnsi(renderSyncFrame(makeStatus(), [], 64, { ready: 44, inFlight: 1 }));
    expect(queued).toContain("44 sessions queued (+1 still active)");

    const drained = stripAnsi(renderSyncFrame(makeStatus(), [], 64, { ready: 0, inFlight: 0 }));
    expect(drained).toContain("queue empty");
  });

  it("shows the watermark, backoff, and activity lines", () => {
    const frame = stripAnsi(
      renderSyncFrame(
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
});

// ---------------------------------------------------------------------------
// runSyncView — driven through fake streams and timers
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

describe("runSyncView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately for non-interactive stdin", async () => {
    const { input, output, written } = fakeIO({ isTTY: false });
    await runSyncView({ input, output });
    expect(written).toEqual([]);
  });

  it("seeds from the log, tails new lines and backlog on poll, and exits on q", async () => {
    const { input, output, written } = fakeIO();
    const chunks: string[] = [
      "[2026-09-02T21:00:05.000Z] [INFO] [miner] wrote note 1/20\n" +
        "[2026-09-02T21:00:06.000Z] [DEBUG] [sync] gate: 44 ready, 0 in flight (watermark x)\n",
    ];
    let emit: (chunk: string) => void = () => {};

    const view = runSyncView({
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
    // seeded with the log's activity and backlog counts.
    expect(written.join("")).toContain(ALT_SCREEN_ENTER);
    expect(stripAnsi(written.join(""))).toContain("[sync] gate: 49 ready");
    expect(stripAnsi(written.join(""))).toContain("49 sessions queued");

    vi.advanceTimersByTime(100);
    const rendered = stripAnsi(written.join(""));
    expect(rendered).toContain("[miner] wrote note 1/20");
    expect(rendered).toContain("44 sessions queued");

    input.emit("data", "q");
    await view;
    expect((input as unknown as FakeInput).isRaw).toBe(false);
    // Going back restores the previous terminal contents.
    expect(written.join("")).toContain(ALT_SCREEN_EXIT);
  });

  it("stops polling after the user goes back", async () => {
    const { input, output } = fakeIO();
    const poll = vi.fn();

    const view = runSyncView({
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
