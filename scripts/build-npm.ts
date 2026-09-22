#!/usr/bin/env bun

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefines } from "./build-all";

const SCRIPT_DIR =
  typeof import.meta.dir === "string" ? import.meta.dir : dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPT_DIR, "..", "bin");
const ENTRY_NAME = "dosu.js";
const NODE_SHEBANG = "#!/usr/bin/env node";

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

/** Bun ends each output with a `//# debugId=` comment but not the runtime registration the Sentry
 * SDK reads, and `sentry-cli sourcemaps inject` skips files that already carry a debug id. Dropping
 * the comment lets inject add both, reusing the id Bun already wrote into the source map. */
export function stripBunDebugId(content: string): string {
  return content.replace(/\n\/\/# debugId=[0-9A-Fa-f-]+\n?$/, "\n");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // Chunk names change between builds; never pack or upload a stale one.
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".js") || file.endsWith(".js.map")) rmSync(join(OUT_DIR, file));
  }

  // Splitting keeps dynamically imported modules (such as the Sentry SDK, which loads only when
  // reporting an error) out of the entry chunk, so they cost nothing on the startup path.
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--target",
      "node",
      "--splitting",
      "--sourcemap=external",
      "--outdir",
      OUT_DIR,
      "--entry-naming",
      ENTRY_NAME,
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

  for (const file of readdirSync(OUT_DIR)) {
    if (!file.endsWith(".js")) continue;
    const path = join(OUT_DIR, file);
    const original = readFileSync(path, "utf8");
    const content = stripBunDebugId(original);
    // Otherwise sentry-cli would silently skip the file and its stack traces would stay unmapped.
    if (content === original) throw new Error(`No Bun debugId comment to replace in ${file}`);
    writeFileSync(path, file === ENTRY_NAME ? normalizeNodeBundle(content) : content);
  }

  console.log(`Built Node CLI bundle and source maps in ${OUT_DIR}`);
}

const isDirectRun = process.argv[1]?.endsWith("build-npm.ts");

if (isDirectRun) await main();
