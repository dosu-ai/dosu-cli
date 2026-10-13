/** `dosu project`: the project key Dosu memory scopes a directory's sessions by, and the
 * directory links that override it (e.g. two clones of one codebase, or a monorepo package that
 * should be its own project). Session uploads, prompt-time memory, and the MCP proxy all resolve
 * keys through sessions/project.ts, so a link applies to all three from the next session on. */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import pc from "picocolors";
import {
  GIT_BUDGETS,
  MAX_PROJECT_KEY_LENGTH,
  matchingLink,
  readProjectLinks,
  resolveProjectOfDir,
  validKey,
} from "../sessions/project";
import { linkProjectDir, ProjectLinksError, unlinkProjectDir } from "../sessions/project-links";
import { printResult } from "./output";

/** What each rule means, for `show`. */
const RULE_NOTES = {
  link: "a directory link (dosu project link)",
  env: "the DOSU_PROJECT environment variable",
  origin: "the git origin remote",
  "root-commit": "the repository's root commit (no origin remote)",
  path: "the directory's path (not in a git repository with history)",
} as const;

/** An absolute directory argument (default: the cwd), without a trailing slash. */
function absoluteDir(dir: string | undefined): string {
  return resolve(dir ?? process.cwd()).replace(/\/+$/, "") || "/";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fail(message: string): void {
  console.error(pc.red(message));
  process.exitCode = 1;
}

export function projectCommand(): Command {
  const cmd = new Command("project").description(
    "Show or link the project key Dosu memory scopes a directory's sessions by",
  );

  cmd
    .command("link")
    .description("Link a directory (default: the current one) and everything under it to a key")
    // `[dir] <key>`: Commander cannot put an optional argument first, so the one-argument form
    // arrives as the first and is the key.
    .usage("[dir] <key>")
    .argument("<dir|key>", "Directory to link, or alone, the key for the current directory")
    .argument("[key]", "Project key for the directory, e.g. github.com/acme/widget")
    .action((first: string, second: string | undefined) => {
      const [dirArg, keyArg] = second === undefined ? [undefined, first] : [first, second];
      const dir = absoluteDir(dirArg);
      const project = validKey(keyArg);
      if (project === null) {
        return fail(
          `A project key must be non-empty and at most ${MAX_PROJECT_KEY_LENGTH} characters.`,
        );
      }
      if (!isDirectory(dir)) return fail(`${dir} is not a directory.`);
      try {
        linkProjectDir(dir, project);
      } catch (err) {
        if (err instanceof ProjectLinksError) return fail(err.message);
        throw err;
      }
      console.log(`Linked ${dir} to project ${project}.`);
      console.log(pc.dim("Sessions started there from now on are scoped to it."));
    });

  cmd
    .command("unlink")
    .description("Remove a directory's link (default: the current directory)")
    .argument("[dir]", "Linked directory (default: the current directory)")
    .action((dirArg: string | undefined) => {
      const dir = absoluteDir(dirArg);
      let removed: boolean;
      try {
        removed = unlinkProjectDir(dir);
      } catch (err) {
        if (err instanceof ProjectLinksError) return fail(err.message);
        throw err;
      }
      if (removed) {
        console.log(`Unlinked ${dir}.`);
        return;
      }
      console.log(`No project link for ${dir}.`);
      const inherited = matchingLink(dir, readProjectLinks());
      if (inherited) {
        console.log(
          pc.dim(`It is linked at ${inherited.dir}; run 'dosu project unlink ${inherited.dir}'.`),
        );
      }
    });

  cmd
    .command("show")
    .description("Show a directory's project key and the rule that produced it")
    .argument("[dir]", "Directory (default: the current directory)")
    .addOption(new Option("--json", "Output as JSON"))
    .action((dirArg: string | undefined, opts: { json?: boolean }) => {
      const dir = absoluteDir(dirArg);
      const key = resolveProjectOfDir(dir, { budget: GIT_BUDGETS.background });
      if (key === null) return fail(`git did not answer in time for ${dir}; try again.`);
      const link = key.rule === "link" ? matchingLink(dir, readProjectLinks()) : null;
      if (opts.json) {
        printResult({ dir, ...key, ...(link ? { link_dir: link.dir } : {}) }, opts);
        return;
      }
      console.log(`Project: ${key.project}`);
      console.log(`Rule:    ${key.rule} -- ${RULE_NOTES[key.rule]}`);
      if (link) console.log(`Linked:  ${link.dir}`);
    });

  return cmd;
}
