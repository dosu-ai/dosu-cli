/** Differential check of `src/memory/record-rules.ts` against the frozen Python it ports
 * (coding-memory-bench 0951e6a). Every command and observation found in the given clbench traces
 * goes through both implementations; any difference is printed and the exit code is 1.
 *
 *   bun run scripts/memory-rules-diff.ts --bench <coding-memory-bench clone> \
 *     [--python <interpreter>] <trace.json|dir>...
 *
 * Directories are searched for `run_*.json`. The Python is read from the clone with
 * `git show 0951e6a:…`, so the clone's checkout does not matter. Pass the clone's own interpreter
 * (`<clone>/.venv/bin/python`) to match the Unicode tables the experiments ran with; the default
 * is `python3`. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clip, parseCommandObservation, prepareRecordedCommand } from "../src/memory/record-rules";

const FROZEN = "0951e6a";
/** `_clip` limit exercised on observations; any limit tests strip and code-point counting. */
const CLIP_LIMIT = 2_000;

/** Pulls the ported definitions out of the frozen sources by name (AST, not line numbers), runs
 * them on every case, and prints the results as JSON. */
const PYTHON_DRIVER = `
import ast, json, re, subprocess, sys
bench, frozen, cases_path, clip_limit = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

def source(path):
    return subprocess.run(["git", "-C", bench, "show", f"{frozen}:{path}"],
                          check=True, capture_output=True, text=True).stdout

def pick(src, names):
    found = []
    for node in ast.parse(src).body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            found.append(ast.get_source_segment(src, node))
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in names for t in node.targets
        ):
            found.append(ast.get_source_segment(src, node))
    return found

procmem = {"MAX_ERROR_LINE_LENGTH", "_CD_PREFIX_RE", "_HEREDOC_RE", "_RETURNCODE_RE",
           "_OUTPUT_RE", "_ERROR_MARKER_RE", "_ANSI_ESCAPE_RE", "_heredoc_delimiters",
           "_strip_heredoc_bodies", "_prepare_recorded_command", "_parse_command_observation"}
code = ["from __future__ import annotations"]
code += pick(source("src/systems/procmem/system.py"), procmem)
code += pick(source("src/systems/memwriter/system.py"), {"_clip"})
ns = {"re": re}
exec("\\n\\n".join(code), ns)
cases = json.load(open(cases_path))
json.dump({
    "commands": [ns["_prepare_recorded_command"](c) for c in cases["commands"]],
    "observations": [ns["_parse_command_observation"](o) for o in cases["observations"]],
    "clips": [ns["_clip"](o, clip_limit) for o in cases["observations"]],
}, sys.stdout)
`;

function traceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true, encoding: "utf-8" })
    .filter((name) => /(^|\/)run_[^/]*\.json$/.test(name))
    .map((name) => join(path, name));
}

/** Distinct commands and observation contents across the traces' interactions. */
function collectCases(paths: string[]): { commands: string[]; observations: string[] } {
  const commands = new Set<string>();
  const observations = new Set<string>();
  for (const file of paths.flatMap(traceFiles)) {
    const trace = JSON.parse(readFileSync(file, "utf-8"));
    for (const step of trace.interactions ?? []) {
      const command = step?.response?.action?.command;
      const content = step?.observation?.content;
      if (typeof command === "string") commands.add(command);
      if (typeof content === "string") observations.add(content);
    }
  }
  return { commands: [...commands], observations: [...observations] };
}

function main(): number {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    return args.splice(at, 2)[1];
  };
  const bench = option("--bench");
  const python3 = option("--python") ?? "python3";
  if (!bench || args.length === 0) {
    console.error(
      "usage: bun run scripts/memory-rules-diff.ts --bench <clone> [--python <bin>] <trace|dir>...",
    );
    return 2;
  }
  const inputs = args;

  const cases = collectCases(inputs);
  const dir = mkdtempSync(join(tmpdir(), "memory-rules-diff-"));
  let python: { commands: string[]; observations: unknown[]; clips: string[] };
  try {
    const casesPath = join(dir, "cases.json");
    writeFileSync(casesPath, JSON.stringify(cases));
    python = JSON.parse(
      execFileSync(python3, ["-c", PYTHON_DRIVER, bench, FROZEN, casesPath, String(CLIP_LIMIT)], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 1024,
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const mismatches: string[] = [];
  const compare = (kind: string, input: string, ours: unknown, theirs: unknown) => {
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
      mismatches.push(
        `${kind}\n  input:  ${JSON.stringify(input).slice(0, 300)}\n` +
          `  ts:     ${JSON.stringify(ours)}\n  python: ${JSON.stringify(theirs)}`,
      );
    }
  };
  cases.commands.forEach((command, i) => {
    compare(
      "prepare_recorded_command",
      command,
      prepareRecordedCommand(command),
      python.commands[i],
    );
  });
  cases.observations.forEach((content, i) => {
    compare(
      "parse_command_observation",
      content,
      parseCommandObservation(content),
      python.observations[i],
    );
    compare("clip", content, clip(content, CLIP_LIMIT), python.clips[i]);
  });

  for (const mismatch of mismatches.slice(0, 20)) console.log(mismatch);
  console.log(
    `${cases.commands.length} commands, ${cases.observations.length} observations: ` +
      `${mismatches.length} mismatches`,
  );
  return mismatches.length === 0 ? 0 : 1;
}

process.exit(main());
