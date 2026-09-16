import { describe, expect, it, vi } from "vitest";
import type { SyncState } from "../sync/watermark";

const mockGetHookAgent = vi.hoisted(() => vi.fn());
vi.mock("../hooks/agents", () => ({
  getHookAgent: (...args: unknown[]) => mockGetHookAgent(...args),
}));

const mockLoadSyncState = vi.hoisted(() => vi.fn());
vi.mock("../sync/watermark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sync/watermark")>()),
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args),
}));

const mockTranscriptMarker = vi.hoisted(() => vi.fn());
vi.mock("../sync/incognito", () => ({
  transcriptHasIncognitoMarker: (...args: unknown[]) => mockTranscriptMarker(...args),
}));

import {
  parseStatuslinePayload,
  type RenderDeps,
  renderStatusline,
  resolveStatuslineState,
  STATUSLINE_LABELS,
} from "./render";

const baseState: SyncState = { schema_version: 1, watermark: null, consecutive_failures: 0 };

function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
  return {
    hookEnabled: () => true,
    loadState: () => baseState,
    transcriptIsIncognito: () => false,
    ...overrides,
  };
}

const payload = { cwd: "/work/dosu-cli", transcript_path: "/logs/s1.jsonl" };

describe("parseStatuslinePayload", () => {
  it("reads cwd and transcript_path", () => {
    expect(parseStatuslinePayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("falls back to workspace.current_dir for cwd", () => {
    expect(parseStatuslinePayload(JSON.stringify({ workspace: { current_dir: "/w" } }))).toEqual({
      cwd: "/w",
    });
  });

  it("yields an empty payload for garbage, arrays, and non-string fields", () => {
    expect(parseStatuslinePayload("")).toEqual({});
    expect(parseStatuslinePayload("not json")).toEqual({});
    expect(parseStatuslinePayload("[1,2]")).toEqual({});
    expect(parseStatuslinePayload(JSON.stringify({ cwd: 7, transcript_path: "" }))).toEqual({});
  });
});

describe("resolveStatuslineState", () => {
  it("is off when no Dosu hook is installed for the agent", () => {
    expect(resolveStatuslineState(payload, "claude", deps({ hookEnabled: () => false }))).toBe(
      "off",
    );
  });

  it("is incognito when the transcript carries the marker, ahead of paused", () => {
    const d = deps({
      transcriptIsIncognito: (path) => path === payload.transcript_path,
      loadState: () => ({ ...baseState, paused: true }),
    });
    expect(resolveStatuslineState(payload, "claude", d)).toBe("incognito");
  });

  it("does not look for the marker without a transcript path", () => {
    const spy = vi.fn(() => true);
    expect(
      resolveStatuslineState({ cwd: "/w" }, "claude", deps({ transcriptIsIncognito: spy })),
    ).toBe("on");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is paused when studying is paused", () => {
    const d = deps({ loadState: () => ({ ...baseState, paused: true }) });
    expect(resolveStatuslineState(payload, "claude", d)).toBe("paused");
  });

  it("is not-studied when cwd is outside the project filter", () => {
    const d = deps({ loadState: () => ({ ...baseState, project_filter: ["/work/other"] }) });
    expect(resolveStatuslineState(payload, "claude", d)).toBe("not-studied");
  });

  it("is on when cwd is at or under a studied directory", () => {
    const d = deps({ loadState: () => ({ ...baseState, project_filter: ["/work/dosu-cli/"] }) });
    expect(resolveStatuslineState(payload, "claude", d)).toBe("on");
    expect(resolveStatuslineState({ cwd: "/work/dosu-cli/src" }, "claude", d)).toBe("on");
  });

  it("treats a missing cwd as the unknown bucket", () => {
    const filtered = deps({ loadState: () => ({ ...baseState, project_filter: ["/work"] }) });
    expect(resolveStatuslineState({}, "claude", filtered)).toBe("not-studied");
    const withUnknown = deps({
      loadState: () => ({ ...baseState, project_filter: ["/work", "(unknown)"] }),
    });
    expect(resolveStatuslineState({}, "claude", withUnknown)).toBe("on");
  });

  it("is on with no filter and nothing else set", () => {
    expect(resolveStatuslineState(payload, "claude", deps())).toBe("on");
  });
});

describe("default dependencies", () => {
  it("consult the hook registry, the sync state, and the transcript", () => {
    mockGetHookAgent.mockReturnValue({ isEnabled: () => true });
    mockLoadSyncState.mockReturnValue(baseState);
    mockTranscriptMarker.mockReturnValue(true);
    expect(resolveStatuslineState(payload, "cursor")).toBe("incognito");
    expect(mockGetHookAgent).toHaveBeenCalledWith("cursor");
    expect(mockTranscriptMarker).toHaveBeenCalledWith(payload.transcript_path);
  });

  it("read an unknown agent or an unparseable hook config as off", () => {
    mockGetHookAgent.mockReturnValue(undefined);
    expect(resolveStatuslineState(payload, "zed")).toBe("off");
    mockGetHookAgent.mockReturnValue({
      isEnabled: () => {
        throw new Error("settings.json is not valid JSON");
      },
    });
    expect(resolveStatuslineState(payload, "claude")).toBe("off");
  });
});

describe("renderStatusline", () => {
  it("maps stdin JSON to the labelled line", () => {
    expect(renderStatusline(JSON.stringify(payload), "claude", deps())).toBe(STATUSLINE_LABELS.on);
    expect(
      renderStatusline(JSON.stringify(payload), "claude", deps({ hookEnabled: () => false })),
    ).toBe(STATUSLINE_LABELS.off);
  });

  it("renders an empty payload as off when nothing is installed, and never throws", () => {
    expect(renderStatusline("", "claude", deps({ hookEnabled: () => false }))).toBe(
      STATUSLINE_LABELS.off,
    );
    const exploding = deps({
      loadState: () => {
        throw new Error("disk");
      },
    });
    expect(renderStatusline(JSON.stringify(payload), "claude", exploding)).toBe(
      STATUSLINE_LABELS.off,
    );
  });

  it("gives studying and incognito their own glyphs and the inactive states a shared one", () => {
    const glyph = (state: keyof typeof STATUSLINE_LABELS) => STATUSLINE_LABELS[state].split(" ")[0];
    expect(glyph("on")).not.toBe(glyph("off"));
    expect(glyph("incognito")).not.toBe(glyph("off"));
    expect(glyph("on")).not.toBe(glyph("incognito"));
    expect(glyph("paused")).toBe(glyph("off"));
    expect(glyph("not-studied")).toBe(glyph("off"));
  });
});
