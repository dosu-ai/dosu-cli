#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_DEBUG_ID_PLACEHOLDER } from "../src/telemetry/debug-id";
import { buildDefines } from "./build-all";

const SCRIPT_DIR =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(SCRIPT_DIR, "..");
const OUTFILE = join(REPOSITORY_ROOT, "bin", "dosu.js");
const SOURCE_MAP_FILE = `${OUTFILE}.map`;
const NODE_SHEBANG = "#!/usr/bin/env node";

export { BUNDLE_DEBUG_ID_PLACEHOLDER } from "../src/telemetry/debug-id";
export { buildDefines } from "./build-all";

export function normalizeNodeBundle(content: string): string {
  const lines = content.split("\n");

  if (lines[0]?.startsWith("#!")) {
    lines[0] = NODE_SHEBANG;
  } else {
    lines.unshift(NODE_SHEBANG);
  }

  if (lines[1] === "// @bun") {
    // Keep the line so generated positions remain aligned with the source map.
    lines[1] = "";
  }

  const normalized = lines.join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function canonicalDebugId(value: string): string {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new Error("Invalid Bun source map debug ID");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function finalizeSourceMapBundle(
  bundle: string,
  rawSourceMap: string,
): { bundle: string; sourceMap: string; debugId: string } {
  const bundleMatches = [...bundle.matchAll(/^\/\/# debugId=([0-9a-f-]+)$/gim)];
  if (bundleMatches.length !== 1 || !bundleMatches[0]?.[1]) {
    throw new Error("Expected exactly one Bun source map debug ID in the npm bundle");
  }

  const sourceMap = JSON.parse(rawSourceMap) as Record<string, unknown>;
  if (typeof sourceMap.debugId !== "string") {
    throw new Error("Expected a Bun debug ID in the npm source map");
  }
  if (!Array.isArray(sourceMap.sources) || sourceMap.sourceRoot) {
    throw new Error(
      "Npm source map must contain repository-relative sources without a source root",
    );
  }

  sourceMap.sources = sourceMap.sources.map((source) => {
    if (
      typeof source !== "string" ||
      isAbsolute(source) ||
      /^[A-Za-z]:[\\/]/.test(source) ||
      source.startsWith("file://")
    ) {
      throw new Error("Npm source map must contain only repository-owned source paths");
    }
    const repositoryRelative = relative(REPOSITORY_ROOT, resolve(dirname(SOURCE_MAP_FILE), source));
    if (
      repositoryRelative === "" ||
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelative)
    ) {
      throw new Error("Npm source map must contain only repository-owned source paths");
    }
    const normalized = repositoryRelative.replaceAll("\\", "/");
    if (!/^(?:src|node_modules)\//.test(normalized)) {
      throw new Error("Npm source map contains an unexpected source path");
    }
    return normalized;
  });
  delete sourceMap.sourceRoot;
  delete sourceMap.file;

  const bundleDebugId = canonicalDebugId(bundleMatches[0][1]);
  const sourceMapDebugId = canonicalDebugId(sourceMap.debugId);
  if (bundleDebugId !== sourceMapDebugId) {
    throw new Error("Bundle and source map debug IDs do not match");
  }
  if (!bundle.includes(BUNDLE_DEBUG_ID_PLACEHOLDER)) {
    throw new Error("Npm bundle is missing the Sentry debug ID placeholder");
  }

  sourceMap.debugId = bundleDebugId;
  const finalizedBundle = bundle
    .replaceAll(BUNDLE_DEBUG_ID_PLACEHOLDER, bundleDebugId)
    .replace(bundleMatches[0][0], `//# debugId=${bundleDebugId}`);

  return {
    bundle: finalizedBundle,
    sourceMap: `${JSON.stringify(sourceMap)}\n`,
    debugId: bundleDebugId,
  };
}

async function main() {
  mkdirSync(dirname(OUTFILE), { recursive: true });

  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--target",
      "node",
      "--sourcemap=external",
      "--outdir",
      dirname(OUTFILE),
      "--entry-naming",
      basename(OUTFILE),
      ...buildDefines(),
      "src/index.ts",
    ],
    { stdout: "pipe", stderr: "pipe", env: process.env },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(stderr);
    process.exit(1);
  }

  const finalized = finalizeSourceMapBundle(
    readFileSync(OUTFILE, "utf8"),
    readFileSync(SOURCE_MAP_FILE, "utf8"),
  );
  writeFileSync(OUTFILE, normalizeNodeBundle(finalized.bundle));
  writeFileSync(SOURCE_MAP_FILE, finalized.sourceMap);

  console.log(`Built Node CLI bundle and source map at ${OUTFILE}`);
}

const isDirectRun = process.argv[1]?.endsWith("build-npm.ts");

if (isDirectRun) await main();
