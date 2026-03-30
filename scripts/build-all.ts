#!/usr/bin/env bun
/**
 * Cross-platform build script.
 *
 * Builds standalone binaries for all supported platforms using `bun build --compile`.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  { target: "bun-darwin-arm64", output: "dosu-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dosu-darwin-x64" },
  { target: "bun-linux-x64", output: "dosu-linux-x64" },
  { target: "bun-linux-arm64", output: "dosu-linux-arm64" },
  { target: "bun-windows-x64", output: "dosu-windows-x64.exe" },
];

const distDir = join(import.meta.dir, "..", "dist");

async function main() {
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  console.log(`Building for ${TARGETS.length} platforms...\n`);

  for (const { target, output } of TARGETS) {
    const outPath = join(distDir, output);
    console.log(`  Building ${target} → ${output}`);

    const proc = Bun.spawn(
      ["bun", "build", "--compile", "--target", target, "src/index.ts", "--outfile", outPath],
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

main();
