/** Fresh CLAUDE_CONFIG_DIR per miner run: a stored claude.ai login on disk would authenticate
 * the spawned binary regardless of env, so each run gets an empty pre-onboarded dir. */

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
