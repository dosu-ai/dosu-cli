import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearState, getStateDir, loadState, sanitize, saveState, type TicketState } from "./state";

function makeState(overrides: Partial<TicketState> = {}): TicketState {
  return {
    ticketId: "kt_abc",
    sessionId: "sess-1",
    status: "pending",
    createdAt: 1000,
    expiresAt: 2000,
    ...overrides,
  };
}

describe("hooks/state", () => {
  let tempDir: string;
  let origStateDir: string | undefined;
  let origXdg: string | undefined;
  let origDev: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dosu-state-test-"));
    origStateDir = process.env.DOSU_HOOK_STATE_DIR;
    origXdg = process.env.XDG_CONFIG_HOME;
    origDev = process.env.DOSU_DEV;
    delete process.env.DOSU_DEV;
    process.env.DOSU_HOOK_STATE_DIR = join(tempDir, "state");
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("DOSU_HOOK_STATE_DIR", origStateDir);
    restore("XDG_CONFIG_HOME", origXdg);
    restore("DOSU_DEV", origDev);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getStateDir honors DOSU_HOOK_STATE_DIR", () => {
    expect(getStateDir()).toBe(join(tempDir, "state"));
  });

  it("getStateDir falls back to the CLI config dir + /hooks", () => {
    delete process.env.DOSU_HOOK_STATE_DIR;
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg");
    expect(getStateDir()).toBe(join(tempDir, "xdg", "dosu-cli", "hooks"));
  });

  it("sanitize replaces unsafe characters but keeps safe ones", () => {
    expect(sanitize("a/b c:d")).toBe("a_b_c_d");
    expect(sanitize("ok_1.2-3")).toBe("ok_1.2-3");
  });

  it("save/load round-trips and writes owner-only (0o600) files", () => {
    const state = makeState({ sessionId: "sess/with:unsafe" });
    saveState(state);
    const file = join(tempDir, "state", `${sanitize("sess/with:unsafe")}.json`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadState("sess/with:unsafe")).toEqual(state);
  });

  it("loadState returns null when no state file exists", () => {
    expect(loadState("never-created")).toBeNull();
  });

  it("loadState returns null on a corrupt state file", () => {
    const dir = join(tempDir, "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sanitize("corrupt")}.json`), "{not json");
    expect(loadState("corrupt")).toBeNull();
  });

  it("clearState removes the session file", () => {
    const state = makeState({ sessionId: "to-clear" });
    saveState(state);
    expect(loadState("to-clear")).not.toBeNull();
    clearState("to-clear");
    expect(loadState("to-clear")).toBeNull();
  });

  it("saveState never throws when the state dir cannot be created", () => {
    const blocker = join(tempDir, "afile");
    writeFileSync(blocker, "x");
    process.env.DOSU_HOOK_STATE_DIR = join(blocker, "sub"); // cannot mkdir under a file
    expect(() => saveState(makeState())).not.toThrow();
  });
});
