/**
 * saveConfig atomicity tests.
 *
 * Concurrent CLI processes share one config file. A direct write to the
 * final path can interleave with a sibling's write or be observed half
 * written; a clobbered/corrupt refresh token gets replayed on the next
 * refresh and can revoke the whole session under GoTrue reuse detection.
 * saveConfig must therefore write a temp file and atomically rename it
 * over the final path.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

import { renameSync, writeFileSync } from "node:fs";
import { type Config, getConfigPath, loadConfig, saveConfig } from "./config";
import { makeTestConfig } from "./config.test-utils";

describe("saveConfig atomicity", () => {
  let origXDG: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-atomic-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    if (origXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = origXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a temp file and atomically renames it over the final path", () => {
    const cfg: Config = makeTestConfig({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 1,
    });
    saveConfig(cfg);

    const finalPath = getConfigPath();

    // The data write must never target the final path directly.
    const writtenPaths = vi.mocked(writeFileSync).mock.calls.map((c) => String(c[0]));
    expect(writtenPaths).not.toContain(finalPath);

    // ...and must land via exactly one rename onto the final path.
    expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
    const [from, to] = vi.mocked(renameSync).mock.calls[0];
    expect(String(to)).toBe(finalPath);
    expect(String(from)).not.toBe(finalPath);
    // The temp file must live in the same directory (rename is only atomic
    // within a filesystem).
    expect(dirname(String(from))).toBe(dirname(finalPath));

    // Result round-trips and leaves no stray temp files behind.
    const loaded = loadConfig();
    expect(loaded.active_account?.session).toEqual(cfg.active_account?.session);
    expect(loaded.schema_version).toBe(2);
    expect(readdirSync(dirname(finalPath))).toEqual(["config.json"]);
  });

  it("keeps the 0600 mode on the written file", () => {
    saveConfig(makeTestConfig({ access_token: "tok", refresh_token: "ref", expires_at: 1 }));
    const dataWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find((c) => String(c[0]).includes("dosu-cli"));
    expect(dataWrite?.[2]).toMatchObject({ mode: 0o600 });
  });
});
