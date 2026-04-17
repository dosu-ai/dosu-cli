import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

function createMockProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
      return createMockProxy([...path, prop]);
    },
  });
}

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn().mockImplementation(() => createMockProxy()),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", async () => {
  const actual = await vi.importActual<typeof import("../config/config")>("../config/config");
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  };
});

const mockGetBackendURL = vi.fn(() => "https://api.test");
vi.mock("../config/constants", () => ({
  getBackendURL: () => mockGetBackendURL(),
  getWebAppURL: () => "https://web.test",
  getSupabaseURL: () => "",
  getSupabaseAnonKey: () => "",
}));

import type { InsightsReport } from "../insights";
import {
  type InsightsRunner,
  insightsCommand,
  insightsDir,
  makeAskFn,
  pruneOldReports,
  reportPath,
  runInsights,
} from "./insights";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
  deployment_id: "d1",
  deployment_name: "Test Deploy",
};

const fakeReport: InsightsReport = {
  generatedAt: "2026-04-16T00:00:00Z",
  windowDays: 30,
  deploymentName: "Test Deploy",
  current: {
    totalResponses: 50,
    byConfidence: { high: 25, medium: 15, low: 10 },
    reactions: {
      totalPositive: 8,
      totalNegative: 2,
      messagesWithReactions: 10,
      reactionRate: 0.2,
      positiveRate: 0.8,
    },
  },
  previous: {
    totalResponses: 40,
    byConfidence: { high: 20, medium: 10, low: 10 },
    reactions: {
      totalPositive: 6,
      totalNegative: 4,
      messagesWithReactions: 10,
      reactionRate: 0.25,
      positiveRate: 0.6,
    },
  },
  derived: {
    highConfidenceRate: 0.5,
    highConfidenceRateDelta: 0,
    responsesDelta: 10,
    positiveRateDelta: 0.2,
    hasPriorWindow: true,
  },
  atAGlance: "Hi",
  cheers: ["Big cheer!"],
  investigate: [],
  suggestions: [{ headline: "Try X", detail: "X is great.", command: "dosu setup" }],
};

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockQuery.mockReset();
  mockGetBackendURL.mockReturnValue("https://api.test");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function makeRunner(over: Partial<InsightsRunner> = {}): InsightsRunner {
  return {
    build: vi.fn().mockResolvedValue(fakeReport),
    render: vi.fn().mockReturnValue("<html>hi</html>"),
    writeFile: vi.fn(),
    prune: vi.fn(),
    openInBrowser: vi.fn().mockResolvedValue(undefined),
    ask: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

describe("runInsights", () => {
  it("writes both a timestamped snapshot and latest.html, and opens the snapshot", async () => {
    const runner = makeRunner();
    const path = await runInsights(validConfig, runner);

    expect(path).toMatch(/report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.html$/);
    expect(runner.build).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: validConfig, windowDays: 30 }),
    );
    expect(runner.render).toHaveBeenCalledWith(fakeReport);

    const writeCalls = (runner.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(writeCalls).toHaveLength(2);
    const writtenPaths = writeCalls.map((c) => c[0] as string);
    expect(writtenPaths).toEqual(expect.arrayContaining([path, reportPath()]));
    for (const call of writeCalls) {
      expect(call[1]).toBe("<html>hi</html>");
    }
    expect(runner.openInBrowser).toHaveBeenCalledWith(path);
  });

  it("prunes the insights directory after writing", async () => {
    const runner = makeRunner();
    await runInsights(validConfig, runner);
    expect(runner.prune).toHaveBeenCalledWith(insightsDir(), 20);
  });

  it("prints the deployment name, first cheer, and both file URLs", async () => {
    const runner = makeRunner();
    const snapshotPath = await runInsights(validConfig, runner);
    const out = allOutput();
    expect(out).toContain("Test Deploy");
    expect(out).toContain("Big cheer!");
    expect(out).toContain(`file://${snapshotPath}`);
    expect(out).toContain(`file://${reportPath()}`);
  });

  it("falls back gracefully when the browser open call rejects", async () => {
    const runner = makeRunner({
      openInBrowser: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await expect(runInsights(validConfig, runner)).resolves.toMatch(/report-.*\.html$/);
    expect(allOutput()).toContain("couldn't auto-open");
  });

  it("skips the cheer line when there are no cheers", async () => {
    const runner = makeRunner({
      build: vi.fn().mockResolvedValue({ ...fakeReport, cheers: [] }),
    });
    await runInsights(validConfig, runner);
    expect(allOutput()).not.toContain("Big cheer!");
  });
});

describe("makeAskFn", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a function that POSTs to /ask and returns the answer", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ answer: "Hello!" }),
    });

    const ask = makeAskFn(validConfig);
    const out = await ask("test");

    expect(out).toBe("Hello!");
    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.test/ask");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["X-Dosu-API-Key"]).toBe("sk_user_test");
    expect(JSON.parse(call[1].body)).toEqual({ deployment_id: "d1", question: "test" });
  });

  it("returns null when the response is not ok", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const ask = makeAskFn(validConfig);
    expect(await ask("q")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("net"));
    const ask = makeAskFn(validConfig);
    expect(await ask("q")).toBeNull();
  });

  it("returns null when the response body has no answer string", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ answer: 42 }),
    });
    const ask = makeAskFn(validConfig);
    expect(await ask("q")).toBeNull();
  });

  it("returns a no-op ask function when backend URL is unset", async () => {
    mockGetBackendURL.mockReturnValue("");
    const ask = makeAskFn(validConfig);
    expect(await ask("q")).toBeNull();
    // fetch should never have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("executeInsights", () => {
  it("runs to completion when config is valid", async () => {
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "ok" }),
      });
    mockQuery.mockResolvedValue({
      totalResponses: 1,
      byConfidence: { high: 1, medium: 0, low: 0 },
      reactions: {
        totalPositive: 0,
        totalNegative: 0,
        messagesWithReactions: 0,
        reactionRate: 0,
        positiveRate: 0,
      },
    });

    // Stub the dynamic open import so executeInsights doesn't try to launch a real browser.
    vi.doMock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

    const { executeInsights } = await import("./insights");
    await expect(executeInsights(validConfig)).resolves.toBeUndefined();
  });

  it("logs and swallows errors so the TUI loop survives", async () => {
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
    mockQuery.mockRejectedValue(new Error("boom"));

    const { executeInsights } = await import("./insights");
    await executeInsights(validConfig);

    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("insightsCommand", () => {
  async function runCmd(...args: string[]) {
    const cmd = insightsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(["node", "test", ...args]);
  }

  it("exits when not logged in", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, access_token: "" });
    await expect(runCmd()).rejects.toThrow("exit");
  });

  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(runCmd()).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(runCmd()).rejects.toThrow("exit");
  });

  it("exits when deployment_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, deployment_id: undefined });
    await expect(runCmd()).rejects.toThrow("exit");
  });

  it("runs to completion when every config field is present", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ answer: "ok" }),
      });
    mockQuery.mockResolvedValue({
      totalResponses: 1,
      byConfidence: { high: 1, medium: 0, low: 0 },
      reactions: {
        totalPositive: 0,
        totalNegative: 0,
        messagesWithReactions: 0,
        reactionRate: 0,
        positiveRate: 0,
      },
    });
    vi.doMock("open", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

    await expect(runCmd()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("logs and exits 1 when the runner throws", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    (globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch = vi.fn();
    mockQuery.mockRejectedValue(new Error("runner boom"));

    await expect(runCmd()).rejects.toThrow("exit");
    expect(errorSpy).toHaveBeenCalled();
    const errOut = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOut).toContain("runner boom");
  });
});

describe("reportPath", () => {
  it("returns the stable latest.html path when called without arguments", () => {
    expect(reportPath()).toMatch(/dosu-cli[\\/]+insights[\\/]+latest\.html$/);
  });

  it("returns a timestamped path when given a Date", () => {
    const d = new Date("2026-04-17T12:30:45.000Z");
    expect(reportPath(d)).toMatch(/dosu-cli[\\/]+insights[\\/]+report-2026-04-17T12-30-45Z\.html$/);
  });

  it("renders colons as dashes so the filename is portable on Windows", () => {
    const d = new Date("2026-04-17T12:30:45.000Z");
    expect(reportPath(d)).not.toContain(":");
  });
});

describe("pruneOldReports", () => {
  it("keeps the most recent N reports and deletes the rest", async () => {
    const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "dosu-insights-test-"));
    try {
      const names = [
        "report-2026-01-01T00-00-00Z.html",
        "report-2026-02-01T00-00-00Z.html",
        "report-2026-03-01T00-00-00Z.html",
        "report-2026-04-01T00-00-00Z.html",
        "report-2026-05-01T00-00-00Z.html",
        // Non-matching files must be left alone
        "latest.html",
        "README.md",
      ];
      for (const n of names) writeFileSync(join(dir, n), "x");

      pruneOldReports(dir, 2);

      const remaining = readdirSync(dir).sort();
      expect(remaining).toEqual(
        [
          "README.md",
          "latest.html",
          "report-2026-04-01T00-00-00Z.html",
          "report-2026-05-01T00-00-00Z.html",
        ].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops when the directory does not exist", () => {
    expect(() => pruneOldReports("/tmp/does-not-exist-dosu-xyz", 5)).not.toThrow();
  });

  it("swallows per-file unlink errors and keeps pruning the rest", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "dosu-insights-test-"));
    try {
      writeFileSync(join(dir, "report-2026-01-01T00-00-00Z.html"), "x");
      writeFileSync(join(dir, "report-2026-02-01T00-00-00Z.html"), "x");
      // A directory whose name matches the report pattern — unlinkSync will
      // throw EISDIR/EPERM on every platform, exercising the catch branch.
      mkdirSync(join(dir, "report-2026-03-01T00-00-00Z.html"));

      expect(() => pruneOldReports(dir, 0)).not.toThrow();

      // The two real files are gone; the problem directory is left in place.
      expect(readdirSync(dir).sort()).toEqual(["report-2026-03-01T00-00-00Z.html"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
