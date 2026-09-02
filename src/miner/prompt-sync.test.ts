/**
 * Drift guard for the vendored miner rules.
 *
 * The canonical rules live in the dosu-skill repo; this test compares the
 * committed generated copy against a sibling checkout (or DOSU_SKILL_REPO)
 * and fails when they diverge — re-run `bun run scripts/vendor-miner-prompt.ts`
 * to fix. When no checkout is present (e.g. CI of this repo alone), the
 * comparison is skipped and only the extraction/rendering logic is tested.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderModule,
  SKILL_PROMPT_RELPATH,
  skillRepoPath,
} from "../../scripts/vendor-miner-prompt";
import { extractMinerCore } from "./prompt-core";
import { MINER_CORE_RULES } from "./prompt-core.generated";

const cliRoot = resolve(__dirname, "..", "..");
const skillPromptPath = join(skillRepoPath(cliRoot), SKILL_PROMPT_RELPATH);

describe("vendored miner rules", () => {
  it.skipIf(!existsSync(skillPromptPath))(
    "match the canonical dosu-skill copy (re-run scripts/vendor-miner-prompt.ts on failure)",
    () => {
      const canonical = extractMinerCore(readFileSync(skillPromptPath, "utf-8"));
      expect(MINER_CORE_RULES).toBe(canonical);
    },
  );

  it("committed copy round-trips through the generator", () => {
    expect(renderModule(MINER_CORE_RULES)).toContain("GENERATED FILE");
  });
});

describe("extractMinerCore", () => {
  it("returns the trimmed block between the markers", () => {
    const md = "intro\n<!-- dosu:miner-core:start -->\n rules here \n<!-- dosu:miner-core:end -->";
    expect(extractMinerCore(md)).toBe("rules here");
  });

  it("throws when the markers are missing", () => {
    expect(() => extractMinerCore("no markers")).toThrow(/markers not found/);
  });
});

describe("renderModule", () => {
  it("escapes template-literal special characters", () => {
    const rendered = renderModule(`uses \`backticks\`, \${interpolation} and back\\slash`);
    expect(rendered).toContain(`\\\`backticks\\\``);
    expect(rendered).toContain(`\\\${interpolation}`);
    expect(rendered).toContain(`back\\\\slash`);
  });
});

describe("skillRepoPath", () => {
  it("prefers DOSU_SKILL_REPO over the sibling convention", () => {
    expect(skillRepoPath("/x/cli", { DOSU_SKILL_REPO: "/custom" })).toBe("/custom");
    expect(skillRepoPath("/x/cli", {})).toBe(resolve("/x/cli", "..", "dosu-skill"));
  });
});
