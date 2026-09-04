import { describe, expect, it } from "vitest";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT, enterAltScreen } from "./alt-screen";

function fakeOutput() {
  const written: string[] = [];
  return { written, write: (text: string) => written.push(text) };
}

describe("enterAltScreen", () => {
  it("switches buffers on enter and back on release", () => {
    const out = fakeOutput();
    const leave = enterAltScreen(out);
    expect(out.written).toEqual([ALT_SCREEN_ENTER]);
    leave();
    expect(out.written).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
  });

  it("only the outermost caller switches buffers when nested", () => {
    const out = fakeOutput();
    const leaveOuter = enterAltScreen(out);
    const leaveInner = enterAltScreen(out);
    // Inner enter and inner release write nothing — the buffer stays put.
    expect(out.written).toEqual([ALT_SCREEN_ENTER]);
    leaveInner();
    expect(out.written).toEqual([ALT_SCREEN_ENTER]);
    leaveOuter();
    expect(out.written).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
  });

  it("release is idempotent — double release never over-decrements", () => {
    const out = fakeOutput();
    const leaveOuter = enterAltScreen(out);
    const leaveInner = enterAltScreen(out);
    leaveInner();
    leaveInner(); // second call must not release the outer hold
    expect(out.written).toEqual([ALT_SCREEN_ENTER]);
    leaveOuter();
    expect(out.written).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
    leaveOuter(); // and releasing again writes nothing further
    expect(out.written).toEqual([ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
  });

  it("supports sequential sessions after the depth returns to zero", () => {
    const out = fakeOutput();
    enterAltScreen(out)();
    enterAltScreen(out)();
    expect(out.written).toEqual([
      ALT_SCREEN_ENTER,
      ALT_SCREEN_EXIT,
      ALT_SCREEN_ENTER,
      ALT_SCREEN_EXIT,
    ]);
  });
});
