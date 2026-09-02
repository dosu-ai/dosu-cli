/**
 * Vendors the canonical background-miner rules from the dosu-skill repo into
 * `src/miner/prompt-core.generated.ts`. At run time the miner prefers the
 * rules from the *installed* skill (src/miner/prompt-source.ts); this vendored
 * copy is only the fallback for machines without the skill, so the published
 * bundle stays self-contained.
 *
 * Run from a checkout that has dosu-skill as a sibling directory (or set
 * DOSU_SKILL_REPO):
 *
 *   bun run scripts/vendor-miner-prompt.ts
 *
 * Drift is caught by `src/miner/prompt-sync.test.ts`, which compares the
 * generated copy against the sibling checkout when one exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractMinerCore } from "../src/miner/prompt-core";

export const SKILL_PROMPT_RELPATH = join(
  "skills",
  "log-to-dosu-knowledge",
  "references",
  "miner-system-prompt.md",
);
export const GENERATED_RELPATH = join("src", "miner", "prompt-core.generated.ts");

/** The generated TypeScript module embedding the rules as a template literal. */
export function renderModule(core: string): string {
  const escaped = core.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: dosu-skill ${SKILL_PROMPT_RELPATH}
 * Regenerate with: bun run scripts/vendor-miner-prompt.ts
 * Drift against a sibling dosu-skill checkout is caught by
 * src/miner/prompt-sync.test.ts.
 *
 * At run time the miner prefers the installed skill's copy of these rules
 * (see prompt-source.ts); this module is the fallback for machines where
 * the Dosu skill is not installed.
 */

/** Vendored fallback of the canonical write-knowledge rules for the miner. */
export const MINER_CORE_RULES = \`${escaped}\`;
`;
}

/** Sibling checkout by convention; DOSU_SKILL_REPO overrides. */
export function skillRepoPath(cliRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.DOSU_SKILL_REPO ?? resolve(cliRoot, "..", "dosu-skill");
}

function main(): void {
  const cliRoot = resolve(import.meta.dir, "..");
  const mdPath = join(skillRepoPath(cliRoot), SKILL_PROMPT_RELPATH);
  if (!existsSync(mdPath)) {
    console.error(`dosu-skill checkout not found at ${mdPath} — set DOSU_SKILL_REPO to override.`);
    process.exit(1);
  }
  const core = extractMinerCore(readFileSync(mdPath, "utf-8"));
  const outPath = join(cliRoot, GENERATED_RELPATH);
  writeFileSync(outPath, renderModule(core));
  console.log(`Vendored miner core rules → ${GENERATED_RELPATH}`);
}

const isDirectRun = process.argv[1]?.endsWith("vendor-miner-prompt.ts");
if (isDirectRun) main();
