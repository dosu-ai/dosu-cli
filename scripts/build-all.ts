#!/usr/bin/env bun
/**
 * Cross-platform build script.
 *
 * Builds standalone binaries for all supported platforms using `bun build --compile`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(SCRIPT_DIR, "..", "package.json");

const TARGETS = [
  { target: "bun-darwin-arm64", output: "dosu-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dosu-darwin-x64" },
  { target: "bun-linux-x64-baseline", output: "dosu-linux-x64" },
  { target: "bun-linux-arm64", output: "dosu-linux-arm64" },
  { target: "bun-linux-x64-musl", output: "dosu-linux-x64-musl" },
  { target: "bun-linux-arm64-musl", output: "dosu-linux-arm64-musl" },
  { target: "bun-windows-x64-baseline", output: "dosu-windows-x64.exe" },
];

function readPackageVersion(): string {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")).version ?? "dev";
  } catch {
    return "dev";
  }
}

/**
 * Build --define flags to bake config into compiled/bundled output.
 *
 * `bun build --compile` produces a standalone executable that does NOT inherit
 * the build-time environment, so `process.env.X` reads return undefined at
 * runtime. `--define` replaces identifiers at compile time.
 */
export function buildDefines(): string[] {
  const version = process.env.DOSU_VERSION ?? readPackageVersion();
  const webAppURL = process.env.DOSU_WEB_APP_URL ?? "";
  const backendURL = process.env.DOSU_BACKEND_URL ?? "";
  const supabaseURL = process.env.SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
  const installChannel = process.env.DOSU_INSTALL_CHANNEL ?? "npm";

  return [
    "--define",
    `process.env.DOSU_VERSION=${JSON.stringify(version)}`,
    "--define",
    `process.env.DOSU_WEB_APP_URL=${JSON.stringify(webAppURL)}`,
    "--define",
    `process.env.DOSU_BACKEND_URL=${JSON.stringify(backendURL)}`,
    "--define",
    `process.env.SUPABASE_URL=${JSON.stringify(supabaseURL)}`,
    "--define",
    `process.env.SUPABASE_ANON_KEY=${JSON.stringify(supabaseAnonKey)}`,
    "--define",
    `process.env.DOSU_INSTALL_CHANNEL=${JSON.stringify(installChannel)}`,
  ];
}

async function main() {
  const distDir = join(SCRIPT_DIR, "..", "dist");
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  const defines = buildDefines();
  const outputSuffix = process.env.DOSU_OUTPUT_SUFFIX ?? "";
  console.log(
    `Building for ${TARGETS.length} platforms...${outputSuffix ? ` (suffix: ${outputSuffix})` : ""}\n`,
  );

  for (const { target, output: baseOutput } of TARGETS) {
    // Insert suffix before the file extension (.exe) or append to the end.
    const output = baseOutput.includes(".")
      ? baseOutput.replace(/(\.[^.]+)$/, `${outputSuffix}$1`)
      : `${baseOutput}${outputSuffix}`;
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
      { stdout: "pipe", stderr: "pipe", env: process.env },
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
