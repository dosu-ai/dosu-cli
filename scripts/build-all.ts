#!/usr/bin/env bun
/**
 * Cross-platform build script.
 *
 * Builds standalone binaries for all supported platforms using `bun build --compile`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  { target: "bun-darwin-arm64", output: "dosu-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dosu-darwin-x64" },
  { target: "bun-linux-x64-baseline", output: "dosu-linux-x64" },
  { target: "bun-linux-arm64", output: "dosu-linux-arm64" },
  { target: "bun-linux-x64-musl", output: "dosu-linux-x64-musl" },
  { target: "bun-linux-arm64-musl", output: "dosu-linux-arm64-musl" },
  { target: "bun-windows-x64-baseline", output: "dosu-windows-x64.exe" },
];

/**
 * Build --define flags to bake version info into the compiled binary.
 *
 * `bun build --compile` produces a standalone executable that does NOT inherit
 * the build-time environment, so `process.env.X` reads return undefined at
 * runtime. `--define` replaces identifiers at compile time, turning e.g.
 *   process.env.DOSU_VERSION ?? "dev"
 * into
 *   "0.2.0" ?? "dev"          →  "0.2.0"
 */
export function buildDefines(): string[] {
  const version = process.env.DOSU_VERSION ?? "dev";
  const commit = process.env.DOSU_COMMIT ?? "none";
  const date = process.env.DOSU_DATE ?? "unknown";

  return [
    "--define",
    `process.env.DOSU_VERSION=${JSON.stringify(version)}`,
    "--define",
    `process.env.DOSU_COMMIT=${JSON.stringify(commit)}`,
    "--define",
    `process.env.DOSU_DATE=${JSON.stringify(date)}`,
  ];
}

async function main() {
  const distDir = join(import.meta.dir, "..", "dist");
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  const defines = buildDefines();
  console.log(`Building for ${TARGETS.length} platforms...\n`);

  for (const { target, output } of TARGETS) {
    const outPath = join(distDir, output);
    console.log(`  Building ${target} → ${output}`);

    const proc = Bun.spawn(
      [
        "bun",
        "build",
        "--compile",
        ...defines,
        "--target",
        target,
        "src/index.ts",
        "--outfile",
        outPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`  ✗ Failed: ${stderr}`);
      process.exit(1);
    }
    console.log(`  ✓ ${output}`);
  }

  console.log(`\nAll binaries built in ${distDir}`);
}

// Only run when executed directly (not imported by tests)
const isDirectRun =
  typeof import.meta.dir === "string" && process.argv[1]?.endsWith("build-all.ts");
if (isDirectRun) main();
