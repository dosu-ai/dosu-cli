/**
 * Run-scoped CLAUDE_CONFIG_DIR for the mining-agent subprocess.
 *
 * A machine with a stored claude.ai login authenticates the spawned binary
 * from its on-disk profile regardless of env — confirmed against the live
 * gateway. Every miner run therefore gets a fresh, empty config directory,
 * pre-seeded with just enough state (`hasCompletedOnboarding`) that the
 * binary doesn't attempt its own interactive onboarding.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunConfigDir {
  path: string;
  /** Delete the directory; safe to call more than once. */
  cleanup(): void;
}

export function createRunConfigDir(): RunConfigDir {
  const path = mkdtempSync(join(tmpdir(), "dosu-miner-"));
  writeFileSync(join(path, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
