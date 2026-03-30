#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = join(SCRIPT_DIR, "..", "package.json");
const OUTFILE = join(SCRIPT_DIR, "..", "bin", "dosu.js");
const NODE_SHEBANG = "#!/usr/bin/env node";

interface PackageJSON {
  version?: string;
}

function readPackageJSON(): PackageJSON {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as PackageJSON;
}

export function buildDefines(): string[] {
  const packageJSON = readPackageJSON();
  const version = process.env.DOSU_VERSION ?? packageJSON.version ?? "dev";
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

export function normalizeNodeBundle(content: string): string {
  const lines = content.split("\n");

  if (lines[0]?.startsWith("#!")) {
    lines[0] = NODE_SHEBANG;
  } else {
    lines.unshift(NODE_SHEBANG);
  }

  if (lines[1] === "// @bun") {
    lines.splice(1, 1);
  }

  const normalized = lines.join("\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function main() {
  mkdirSync(dirname(OUTFILE), { recursive: true });

  const proc = Bun.spawn(
    ["bun", "build", "--target", "node", ...buildDefines(), "src/index.ts", "--outfile", OUTFILE],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(stderr);
    process.exit(1);
  }

  const bundle = readFileSync(OUTFILE, "utf8");
  writeFileSync(OUTFILE, normalizeNodeBundle(bundle));

  console.log(`Built Node CLI bundle at ${OUTFILE}`);
}

const isDirectRun =
  process.argv[1]?.endsWith("build-npm.ts");

if (isDirectRun) await main();
