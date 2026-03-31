/**
 * `dosu init` — interactive setup wizard that installs Claude Code skills into a project.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { dim, info } from "../setup/styles";

const SKILL_DIR = ".claude/skills/dosu";
const SKILL_FILE = "SKILL.md";
const AGENTS_FILE = "AGENTS.md";

export async function runInit(): Promise<void> {
  p.intro("Initialize Dosu for this project");

  const cwd = process.cwd();
  const skillDir = join(cwd, SKILL_DIR);
  const skillPath = join(skillDir, SKILL_FILE);

  // Check if already initialized
  if (existsSync(skillPath)) {
    const overwrite = await p.confirm({
      message: "Dosu skill already exists. Overwrite?",
      initialValue: false,
    });

    if (p.isCancel(overwrite) || !overwrite) {
      p.outro("No changes made");
      return;
    }
  }

  // Write skill file
  const s = p.spinner();
  s.start("Writing skill file...");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, generateSkillContent());
  s.stop(`Created ${dim(join(SKILL_DIR, SKILL_FILE))}`);

  // Optionally update AGENTS.md
  const agentsPath = join(cwd, AGENTS_FILE);
  const agentsExists = existsSync(agentsPath);

  const updateAgents = await p.confirm({
    message: agentsExists
      ? "Add Dosu skill to existing AGENTS.md?"
      : "Create AGENTS.md with Dosu skill?",
    initialValue: true,
  });

  if (!p.isCancel(updateAgents) && updateAgents) {
    const s2 = p.spinner();
    s2.start(agentsExists ? "Updating AGENTS.md..." : "Creating AGENTS.md...");
    writeAgentsEntry(agentsPath, agentsExists);
    s2.stop(agentsExists ? "Updated AGENTS.md" : `Created ${dim(AGENTS_FILE)}`);
  }

  p.log.success("Dosu initialized for this project");
  p.log.message(
    `Available skills:\n` +
      `  ${info("/dosu-add")}   — Add a public GitHub repo as a library\n` +
      `  ${info("/dosu-sync")}  — Re-sync an existing library`,
  );

  p.outro("Done!");
}

export function generateSkillContent(): string {
  return `---
description: Add and sync public GitHub repositories as Dosu libraries
globs: "**/*"
---

# Dosu Skills

## /dosu-add

Add a public GitHub repository as a Dosu public library for indexing.

### Usage

\`\`\`
/dosu-add owner/repo
\`\`\`

### Steps

1. Run \`dosu add <owner/repo>\` in the terminal
2. The CLI will detect your GitHub token, validate the repo is public, and add it to Dosu
3. Once added, you can query it with:

\`\`\`
ask_public_library(question="your question here", repository_slug="owner/repo")
\`\`\`

## /dosu-sync

Re-trigger indexing for a previously added public library.

### Usage

\`\`\`
/dosu-sync owner/repo
\`\`\`

Or without arguments to pick from a list:

\`\`\`
/dosu-sync
\`\`\`

### Steps

1. Run \`dosu sync [owner/repo]\` in the terminal
2. The CLI will trigger re-indexing for the specified (or selected) library
`;
}

const AGENTS_ENTRY = `
## Dosu

| Skill | Description |
|-------|-------------|
| \`/dosu-add <owner/repo>\` | Add a public GitHub repo as a Dosu library |
| \`/dosu-sync [owner/repo]\` | Re-sync an existing Dosu library |

See \`.claude/skills/dosu/SKILL.md\` for details.
`;

export function writeAgentsEntry(agentsPath: string, exists: boolean): void {
  if (exists) {
    const content = readFileSync(agentsPath, "utf-8");
    // Don't duplicate if already present
    if (content.includes(".claude/skills/dosu/SKILL.md")) {
      return;
    }
    writeFileSync(agentsPath, `${content.trimEnd()}\n${AGENTS_ENTRY}`);
  } else {
    writeFileSync(agentsPath, `# Agents\n${AGENTS_ENTRY}`);
  }
}
