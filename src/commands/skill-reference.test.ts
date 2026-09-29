/**
 * Checks that the bundled `dosu` skill (what `dosu skill install` writes) routes review-queue
 * requests straight to `dosu review list` and documents the review surface the CLI really has.
 * These assert routing anchors and flag parity, not prose.
 */

import { describe, expect, it } from "vitest";
import { BUNDLED_SKILLS } from "../generated/skills";
import { reviewCommand } from "./review";

function skillFile(path: string): string {
  const skill = BUNDLED_SKILLS.find((s) => s.name === "dosu");
  const file = skill?.files.find((f) => f.path === path);
  if (!file) throw new Error(`bundled dosu skill has no ${path}`);
  return file.content;
}

function frontmatterDescription(skillMd: string): string {
  const match = /^---\n[\s\S]*?^description: '([^\n]*)'$/m.exec(skillMd);
  if (!match) throw new Error("SKILL.md frontmatter has no single-quoted description");
  return match[1];
}

/** `dosu review <sub> ...` lines in the Review section's code block, continuations joined. */
function documentedReviewSyntax(commandsMd: string): Map<string, string> {
  const section = commandsMd.split(/^## /m).find((s) => s.startsWith("Review\n"));
  const block = section ? /```text\n([\s\S]*?)```/.exec(section)?.[1] : undefined;
  if (!block) throw new Error("commands.md has no Review syntax block");
  const syntax = new Map<string, string>();
  let current: string | undefined;
  for (const line of block.split("\n")) {
    const head = /^dosu review (\S+)/.exec(line);
    if (head) {
      current = head[1];
      syntax.set(current, line);
    } else if (current && /^\s+\S/.test(line)) {
      syntax.set(current, `${syntax.get(current)} ${line.trim()}`);
    }
  }
  return syntax;
}

describe("bundled dosu skill: review routing", () => {
  it("names the review queue early in the skill description", () => {
    const description = frontmatterDescription(skillFile("SKILL.md"));
    expect(description.length).toBeLessThanOrEqual(1024);
    // Discovery ranks on the description; the review trigger must not sit at the tail.
    expect(description.slice(0, 200)).toMatch(/review list/i);
    expect(description.slice(0, 200)).toMatch(/pending approval/i);
  });

  it("routes review-list intents directly to `dosu review list --json`", () => {
    const rows = skillFile("SKILL.md")
      .split("\n")
      .filter((line) => line.startsWith("|") && /review/i.test(line));
    expect(rows.some((row) => row.includes("`dosu review list --json`"))).toBe(true);
  });

  it("documents exactly the flags each `dosu review` subcommand accepts", () => {
    const documented = documentedReviewSyntax(skillFile("references/commands.md"));
    const cmd = reviewCommand();
    expect([...documented.keys()].sort()).toEqual(cmd.commands.map((c) => c.name()).sort());
    for (const sub of cmd.commands) {
      const flags = [...(documented.get(sub.name())?.matchAll(/--[a-z][a-z-]*/g) ?? [])].map(
        (m) => m[0],
      );
      const accepted = sub.options.map((o) => o.long);
      expect(new Set(flags), sub.name()).toEqual(new Set(accepted));
    }
  });

  it("describes the list envelope and the context check before any switch", () => {
    const workflow = skillFile("references/review-workflow.md");
    for (const anchor of [
      "`truncated`",
      "`total`",
      "draft_message:",
      "--since",
      "--until",
      "dosu status --json",
      "dosu deployments info --json",
      "dosu deployments list --json",
    ]) {
      expect(workflow, anchor).toContain(anchor);
    }
  });
});
