#!/usr/bin/env bun
/** Single-platform standalone binary via `bun build --compile`, with env vars baked at compile
 * time through --define (same as build-all.ts). */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefines } from "./build-all";

const SCRIPT_DIR =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const OUTFILE = join(SCRIPT_DIR, "..", "bin", "dosu");

async function main() {
  mkdirSync(dirname(OUTFILE), { recursive: true });

  const defines = buildDefines();

  const proc = Bun.spawn(
    ["bun", "build", "--compile", ...defines, "src/index.ts", "--outfile", OUTFILE],
    { stdout: "inherit", stderr: "inherit", env: process.env },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) process.exit(1);

  console.log(`Built standalone binary at ${OUTFILE}`);
}

const isDirectRun = process.argv[1]?.endsWith("build-compile.ts");

if (isDirectRun) await main();
