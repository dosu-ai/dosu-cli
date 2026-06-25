import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../config/config", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  };
});

import {
  addPendingTask,
  checkForReadyTasks,
  fetchTaskRun,
  readPendingTasks,
  writePendingTasks,
} from "./pending-tasks-check";

let tempDir: string;
let origXDG: string | undefined;
let origBackend: string | undefined;

function cachePath(): string {
  return join(tempDir, "dosu-cli", "pending-tasks.json");
}

function writeCacheFile(tasks: unknown[]): void {
  const { mkdirSync } = require("node:fs");
  mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ tasks }));
}

function readCacheFile(): { tasks: unknown[] } {
  return JSON.parse(readFileSync(cachePath(), "utf-8"));
}

beforeEach(() => {
  origXDG = process.env.XDG_CONFIG_HOME;
  origBackend = process.env.DOSU_BACKEND_URL_OVERRIDE;
  tempDir = mkdtempSync(join(tmpdir(), "dosu-pending-test-"));
  process.env.XDG_CONFIG_HOME = tempDir;
  process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test";
  mockLoadConfig.mockReturnValue({ api_key: "sk_user_test" });
});

afterEach(() => {
  if (origXDG !== undefined) process.env.XDG_CONFIG_HOME = origXDG;
  else delete process.env.XDG_CONFIG_HOME;
  if (origBackend !== undefined) process.env.DOSU_BACKEND_URL_OVERRIDE = origBackend;
  else delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("readPendingTasks / writePendingTasks", () => {
  it("returns empty list when no cache exists", () => {
    expect(readPendingTasks()).toEqual({ tasks: [] });
  });

  it("round-trips tasks through write + read", () => {
    writePendingTasks({
      tasks: [{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 5 }],
    });
    const cache = readPendingTasks();
    expect(cache.tasks).toHaveLength(1);
    expect(cache.tasks[0].task_id).toBe("t1");
  });

  it("returns empty on corrupt cache", () => {
    writeCacheFile([]);
    writeFileSync(cachePath(), "NOT JSON{{{");
    expect(readPendingTasks()).toEqual({ tasks: [] });
  });

  it("returns empty when tasks is not an array", () => {
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(tempDir, "dosu-cli"), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ tasks: "nope" }));
    expect(readPendingTasks()).toEqual({ tasks: [] });
  });
});

describe("addPendingTask", () => {
  it("appends a task with lastCheck=0", () => {
    addPendingTask({ task_id: "t1", doc_types: ["readme"], repo: "o/r" });
    const cache = readCacheFile();
    expect(cache.tasks).toHaveLength(1);
    expect(cache.tasks[0]).toMatchObject({
      task_id: "t1",
      doc_types: ["readme"],
      repo: "o/r",
      lastCheck: 0,
    });
  });

  it("appends to existing tasks", () => {
    addPendingTask({ task_id: "t1", doc_types: ["readme"], repo: "o/r" });
    addPendingTask({ task_id: "t2", doc_types: ["agents"], repo: "o/r" });
    expect(readCacheFile().tasks).toHaveLength(2);
  });
});

describe("fetchTaskRun", () => {
  it("returns parsed response on ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ state: "SUCCESS", pr_url: "u" }) }),
    );
    const res = await fetchTaskRun("https://api.example.test", "k", "t1");
    expect(res).toEqual({ state: "SUCCESS", pr_url: "u" });
  });

  it("sends the API key header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ state: "PROGRESS" }) });
    vi.stubGlobal("fetch", fetchMock);
    await fetchTaskRun("https://api.example.test", "secret", "t9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/v1/cli/task/run/t9");
    expect(init.headers["X-Dosu-API-Key"]).toBe("secret");
  });

  it("returns null on non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchTaskRun("https://api.example.test", "k", "t1")).toBeNull();
  });

  it("returns null when state missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await fetchTaskRun("https://api.example.test", "k", "t1")).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await fetchTaskRun("https://api.example.test", "k", "t1")).toBeNull();
  });
});

describe("checkForReadyTasks — display latch", () => {
  it("no-ops with empty cache", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    checkForReadyTasks();
    expect(spy).not.toHaveBeenCalled();
  });

  it("prints a ready PR once and prunes it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    writeCacheFile([
      {
        task_id: "t1",
        doc_types: ["agents"],
        repo: "o/r",
        lastCheck: Date.now(),
        prUrl: "https://pr",
      },
    ]);
    checkForReadyTasks();
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("https://pr");
    // Finished + displayed → pruned.
    expect(readCacheFile().tasks).toHaveLength(0);
  });

  it("prints a failure note", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    writeCacheFile([
      { task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: Date.now(), error: "kaboom" },
    ]);
    checkForReadyTasks();
    expect(spy.mock.calls[0][0]).toContain("kaboom");
    expect(readCacheFile().tasks).toHaveLength(0);
  });

  it("does not re-display an already-displayed task", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    // displayedAt set but with prUrl → already shown last run; should prune silently.
    writeCacheFile([
      {
        task_id: "t1",
        doc_types: ["agents"],
        repo: "o/r",
        lastCheck: Date.now(),
        prUrl: "https://pr",
        displayedAt: Date.now() - 1000,
      },
    ]);
    checkForReadyTasks();
    expect(spy).not.toHaveBeenCalled();
    expect(readCacheFile().tasks).toHaveLength(0);
  });

  it("handles corrupt cache without throwing", () => {
    writeCacheFile([]);
    writeFileSync(cachePath(), "NOT JSON{{{");
    expect(() => checkForReadyTasks()).not.toThrow();
  });
});

describe("checkForReadyTasks — polling", () => {
  it("polls a stale in-flight task and stores prUrl on SUCCESS", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "SUCCESS", pr_url: "https://pr/1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);

    checkForReadyTasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      const task = readCacheFile().tasks[0] as { prUrl?: string };
      expect(task.prUrl).toBe("https://pr/1");
    });
  });

  it("stores error on FAILURE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "FAILURE", detail: { message: "no perms" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);

    checkForReadyTasks();
    await vi.waitFor(() => {
      const task = readCacheFile().tasks[0] as { error?: string };
      expect(task.error).toBe("no perms");
    });
  });

  it("falls back to a placeholder url when SUCCESS has no pr_url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ state: "SUCCESS" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);

    checkForReadyTasks();
    await vi.waitFor(() => {
      const task = readCacheFile().tasks[0] as { prUrl?: string };
      expect(task.prUrl).toBe("(no URL returned)");
    });
  });

  it("falls back to a generic error when FAILURE has no detail message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ state: "FAILURE" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);

    checkForReadyTasks();
    await vi.waitFor(() => {
      const task = readCacheFile().tasks[0] as { error?: string };
      expect(task.error).toBe("generation failed");
    });
  });

  it("leaves a task in-flight on PROGRESS (only bumps lastCheck)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ state: "PROGRESS" }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);

    checkForReadyTasks();
    await vi.waitFor(() => {
      const task = readCacheFile().tasks[0] as {
        prUrl?: string;
        error?: string;
        lastCheck: number;
      };
      expect(task.prUrl).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(task.lastCheck).toBeGreaterThan(0);
    });
  });

  it("does not poll a fresh in-flight task", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: Date.now() }]);
    checkForReadyTasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not poll when api key is missing", () => {
    mockLoadConfig.mockReturnValue({});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);
    checkForReadyTasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not poll when the backend URL is not configured", () => {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);
    checkForReadyTasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows unexpected errors during the check (never throws on the hot path)", () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A pending task gets past the early-return, then loadConfig blows up.
    writeCacheFile([{ task_id: "t1", doc_types: ["agents"], repo: "o/r", lastCheck: 0 }]);
    mockLoadConfig.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => checkForReadyTasks()).not.toThrow();
  });
});
