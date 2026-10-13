/** Setup's sync-scope picker: which repos the backfill offer (and later syncs) take sessions
 * from. Prompts are faked; the state file is real, in a temporary home. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { loadSyncState, saveSyncState } from "../sync/state";
import * as p from "../tui/prompts";
import { canPickScope, scopeCandidates, stepPickSyncScope } from "./scope-step";

vi.mock("../tui/prompts", () => ({
  multiselect: vi.fn(),
  isCancel: vi.fn(),
  log: { success: vi.fn() },
}));

const CLI = "github.com/dosu-ai/dosu-cli";
const WEB = "github.com/dosu-ai/dosu";
const DOCS = "github.com/dosu-ai/docs";

function session(id: string, repo: string | undefined, updated: string): AgentSession {
  return {
    id,
    harness: "claude",
    path: `/tmp/${id}.jsonl`,
    updated,
    ...(repo ? { repo } : {}),
  };
}

describe("scopeCandidates", () => {
  it("counts sessions per repo, most sessions first, then most recently active", () => {
    const candidates = scopeCandidates(
      [
        session("a", CLI, "2026-09-01T00:00:00.000Z"),
        session("b", WEB, "2026-09-03T00:00:00.000Z"),
        session("c", CLI, "2026-09-02T00:00:00.000Z"),
        session("d", DOCS, "2026-09-05T00:00:00.000Z"),
      ],
      null,
    );

    expect(candidates).toEqual([
      { repo: CLI, sessions: 2, updated: "2026-09-02T00:00:00.000Z" },
      { repo: DOCS, sessions: 1, updated: "2026-09-05T00:00:00.000Z" },
      { repo: WEB, sessions: 1, updated: "2026-09-03T00:00:00.000Z" },
    ]);
  });

  it("leaves out sessions outside any repo", () => {
    expect(scopeCandidates([session("a", undefined, "2026-09-01T00:00:00.000Z")], null)).toEqual(
      [],
    );
  });

  it("keeps every repo the current scope names, even with no sessions, last", () => {
    const candidates = scopeCandidates([session("a", CLI, "2026-09-01T00:00:00.000Z")], [WEB, CLI]);

    expect(candidates).toEqual([
      { repo: CLI, sessions: 1, updated: "2026-09-01T00:00:00.000Z" },
      { repo: WEB, sessions: 0, updated: "" },
    ]);
  });
});

describe("canPickScope", () => {
  let tty: PropertyDescriptor | undefined;
  beforeEach(() => {
    tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  });
  afterEach(() => {
    if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  const two = scopeCandidates(
    [session("a", CLI, "2026-09-01T00:00:00.000Z"), session("b", WEB, "2026-09-01T00:00:00.000Z")],
    null,
  );

  it("asks on a terminal when there are repos to choose between", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    expect(canPickScope(two)).toBe(true);
    expect(canPickScope(two.slice(0, 1))).toBe(false);
    expect(canPickScope([])).toBe(false);
  });

  it("never asks without a terminal", () => {
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    expect(canPickScope(two)).toBe(false);
  });
});

describe("stepPickSyncScope", () => {
  let home: string;
  const candidates = scopeCandidates(
    [
      session("a", CLI, "2026-09-01T00:00:00.000Z"),
      session("b", CLI, "2026-09-02T00:00:00.000Z"),
      session("c", WEB, "2026-09-03T00:00:00.000Z"),
      session("d", DOCS, "2026-09-04T00:00:00.000Z"),
    ],
    null,
  );

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "dosu-scope-step-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    vi.stubEnv("DOSU_DEV", undefined);
    vi.mocked(p.isCancel).mockReturnValue(false);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function lastPrompt() {
    const [opts] = vi.mocked(p.multiselect).mock.calls.at(-1) ?? [];
    if (!opts) throw new Error("multiselect was not shown");
    return opts;
  }

  it("lists the repos with their session counts and preselects every repo without a scope", async () => {
    vi.mocked(p.multiselect).mockResolvedValue([CLI, WEB, DOCS]);

    await stepPickSyncScope(candidates, null);

    const prompt = lastPrompt();
    expect(prompt.options).toEqual([
      { value: CLI, label: "dosu-ai/dosu-cli", hint: "2 sessions" },
      { value: DOCS, label: "dosu-ai/docs", hint: "1 session" },
      { value: WEB, label: "dosu-ai/dosu", hint: "1 session" },
    ]);
    expect(prompt.initialValues).toEqual([CLI, DOCS, WEB]);
    expect(prompt.validate?.([])).toBe("Select at least one repo.");
    expect(prompt.summary?.([CLI, DOCS, WEB])).toContain("all repos");
    expect(prompt.summary?.([CLI])).toBe("1 of 3 repos");
  });

  it("preselects the scope already configured, and names a scoped repo with no sessions", async () => {
    const withIdle = scopeCandidates([session("a", CLI, "2026-09-01T00:00:00.000Z")], [WEB]);
    vi.mocked(p.multiselect).mockResolvedValue([WEB]);

    await stepPickSyncScope(withIdle, [WEB]);

    expect(lastPrompt().initialValues).toEqual([WEB]);
    expect(lastPrompt().options.at(-1)).toMatchObject({ value: WEB, hint: "no recent sessions" });
  });

  it("saves a narrower pick as the scope, keeping the rest of the state", async () => {
    saveSyncState({ ...loadSyncState(), paused: true, project_filter: ["/old"] });
    vi.mocked(p.multiselect).mockResolvedValue([CLI, WEB]);

    const scope = await stepPickSyncScope(candidates, null);

    expect(scope).toEqual([CLI, WEB]);
    const saved = loadSyncState();
    expect(saved.repo_filter).toEqual([CLI, WEB]);
    expect(saved.project_filter).toBeUndefined();
    expect(saved.paused).toBe(true);
    expect(vi.mocked(p.log.success).mock.calls.join(" ")).toContain(
      "dosu-ai/dosu-cli, dosu-ai/dosu",
    );
  });

  it("clears the scope when every repo is picked, so new repos ship too", async () => {
    saveSyncState({ ...loadSyncState(), repo_filter: [CLI] });
    vi.mocked(p.multiselect).mockResolvedValue([CLI, WEB, DOCS]);

    const scope = await stepPickSyncScope(candidates, [CLI]);

    expect(scope).toBeNull();
    expect(loadSyncState().repo_filter).toBeUndefined();
    expect(vi.mocked(p.log.success).mock.calls.join(" ")).toContain("all repos");
  });

  it("keeps the current scope when the prompt is cancelled", async () => {
    saveSyncState({ ...loadSyncState(), repo_filter: [CLI] });
    vi.mocked(p.multiselect).mockResolvedValue(Symbol("cancel"));
    vi.mocked(p.isCancel).mockReturnValue(true);

    const scope = await stepPickSyncScope(candidates, [CLI]);

    expect(scope).toEqual([CLI]);
    expect(loadSyncState().repo_filter).toEqual([CLI]);
    expect(p.log.success).not.toHaveBeenCalled();
  });
});
