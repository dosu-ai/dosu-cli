import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { pollImportCompletion } from "./doc-analyze-step";

/**
 * Minimal stub of the TypedClient surface that pollImportCompletion touches.
 * Other fields are unused by this function so we type-pun with `as never`.
 */
function makeTrpc(getImportStatus: ReturnType<typeof vi.fn>) {
  return {
    docImports: {
      getImportStatus: { query: getImportStatus },
    },
  } as never;
}

describe("pollImportCompletion", () => {
  let getImportStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getImportStatus = vi.fn();
  });

  it("returns counts when state transitions to SUCCESS", async () => {
    getImportStatus.mockResolvedValueOnce({
      task_id: "t1",
      state: "SUCCESS",
      detail: { total: 5, completed: 4, failed: 1 },
    });

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ imported: 4, failed: 1 });
    expect(result.timed_out).toBeUndefined();
  });

  it("returns counts when state transitions to FAILURE", async () => {
    getImportStatus.mockResolvedValueOnce({
      task_id: "t1",
      state: "FAILURE",
      detail: { total: 3, completed: 0, failed: 3 },
    });

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ imported: 0, failed: 3 });
  });

  it("times out and surfaces timed_out=true when state stays PROGRESS", async () => {
    // Always reply PROGRESS so the loop never finds a terminal state.
    getImportStatus.mockResolvedValue({
      task_id: "t1",
      state: "PROGRESS",
      detail: { total: 1, completed: 0, failed: 0 },
    });

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 10, // 10ms — exit after ~1-2 polls
    });

    expect(result).toMatchObject({ imported: 0, failed: 0, timed_out: true });
    // Should have polled at least once before bailing
    expect(getImportStatus.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns early after IMPORT_STATUS_MAX_ERRORS consecutive null responses", async () => {
    getImportStatus.mockResolvedValue(null);

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 60_000, // big enough that the error budget is what trips, not the deadline
    });

    expect(result).toEqual({ imported: 0, failed: 0 });
    // 3 consecutive nulls trips the error budget
    expect(getImportStatus.mock.calls.length).toBe(3);
  });

  it("returns early after IMPORT_STATUS_MAX_ERRORS consecutive throws", async () => {
    getImportStatus.mockRejectedValue(new Error("network blip"));

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 60_000,
    });

    expect(result).toEqual({ imported: 0, failed: 0 });
    expect(getImportStatus.mock.calls.length).toBe(3);
  });

  it("recovers from a transient error then completes", async () => {
    getImportStatus.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce({
      task_id: "t1",
      state: "SUCCESS",
      detail: { total: 2, completed: 2, failed: 0 },
    });

    const result = await pollImportCompletion(makeTrpc(getImportStatus), "t1", {
      intervalMs: 0,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ imported: 2, failed: 0 });
    expect(getImportStatus).toHaveBeenCalledTimes(2);
  });
});
