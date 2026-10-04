import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnableMemoryHooks } = vi.hoisted(() => ({ mockEnableMemoryHooks: vi.fn() }));
vi.mock("../memory/install", () => ({
  enableMemoryHooks: mockEnableMemoryHooks,
  disableMemoryHooks: vi.fn(),
  memoryHookStatus: vi.fn(),
  memoryHooksTarget: () => ({ name: "Cursor", configPath: "/home/u/.cursor/hooks.json" }),
}));

import { memoryCommand } from "./memory";

let binDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
const saved = { PATH: process.env.PATH, DOSU_DEV: process.env.DOSU_DEV };

const output = () => logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");

async function enable() {
  const cmd = memoryCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", "hooks", "enable", "--agent", "cursor"]);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "dosu-memory-cmd-"));
  process.env.PATH = binDir;
  delete process.env.DOSU_DEV;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mockEnableMemoryHooks.mockReset();
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(binDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("memory hooks enable", () => {
  it("warns when dosu is not on PATH, and still enables", async () => {
    await enable();

    expect(output()).toContain("'dosu' is not on PATH");
    expect(mockEnableMemoryHooks).toHaveBeenCalledWith("cursor");
  });

  it("does not warn when dosu resolves on PATH", async () => {
    writeFileSync(join(binDir, process.platform === "win32" ? "dosu.cmd" : "dosu"), "");

    await enable();

    expect(output()).not.toContain("not on PATH");
    expect(output()).toContain("✓ Cursor · memory hooks enabled");
  });

  it("does not warn in dev mode, whose hooks run this working copy", async () => {
    process.env.DOSU_DEV = "true";

    await enable();

    expect(output()).not.toContain("not on PATH");
  });
});
