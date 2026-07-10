import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockCopyFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: mockSpawnSync }));
vi.mock("node:fs", () => ({
  copyFileSync: mockCopyFileSync,
  mkdirSync: mockMkdirSync,
  existsSync: mockExistsSync,
}));

vi.mock("../config/config", () => ({
  getConfigDir: vi.fn(() => "/home/u/.config/dosu-cli"),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dosuOnPath, materializedRuntimePath, resolveHookCommandPrefix } from "./runtime";

const BUNDLE = "/some/npx/cache/@dosu/cli/bin/dosu.js";
let argv1: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  argv1 = process.argv[1];
});

afterEach(() => {
  if (argv1 !== undefined) process.argv[1] = argv1;
});

describe("dosuOnPath", () => {
  it("is true when the PATH lookup exits 0", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });
    expect(dosuOnPath()).toBe(true);
  });

  it("is false when the lookup exits non-zero or throws", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    expect(dosuOnPath()).toBe(false);
    mockSpawnSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(dosuOnPath()).toBe(false);
  });
});

describe("resolveHookCommandPrefix", () => {
  it("returns bare dosu when it is on PATH, without materializing", () => {
    mockSpawnSync.mockReturnValue({ status: 0 });

    expect(resolveHookCommandPrefix()).toBe("dosu");
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("materializes the running bundle and returns a node command when dosu is absent", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockExistsSync.mockReturnValue(true);
    process.argv[1] = BUNDLE;

    const prefix = resolveHookCommandPrefix();

    expect(prefix).toBe(`node "${materializedRuntimePath()}"`);
    expect(mockCopyFileSync).toHaveBeenCalledWith(BUNDLE, materializedRuntimePath());
    expect(mockMkdirSync).toHaveBeenCalledWith("/home/u/.config/dosu-cli/bin", {
      recursive: true,
      mode: 0o700,
    });
  });

  it("falls back to bare dosu when the entry script is not a JS bundle (compiled binary / dev)", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    process.argv[1] = "/usr/local/bin/dosu"; // compiled binary — no .js extension

    expect(resolveHookCommandPrefix()).toBe("dosu");
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("falls back to bare dosu when the entry script does not exist on disk", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockExistsSync.mockReturnValue(false);
    process.argv[1] = BUNDLE;

    expect(resolveHookCommandPrefix()).toBe("dosu");
    expect(mockCopyFileSync).not.toHaveBeenCalled();
  });

  it("falls back to bare dosu when materialization fails", () => {
    mockSpawnSync.mockReturnValue({ status: 1 });
    mockExistsSync.mockReturnValue(true);
    process.argv[1] = BUNDLE;
    mockCopyFileSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(resolveHookCommandPrefix()).toBe("dosu");
  });
});

describe("materializedRuntimePath", () => {
  it("lives under the config dir", () => {
    expect(materializedRuntimePath()).toBe("/home/u/.config/dosu-cli/bin/dosu.js");
  });
});
