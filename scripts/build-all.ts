#!/usr/bin/env bun
/** Builds standalone binaries for all supported platforms using `bun build --compile`. */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePostHogProjectToken } from "../src/telemetry/telemetry";

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

/** `https://<public key>@<host>/<project>`, with no secret key and no auth token in the key slot. */
function isPublicClientDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username !== "" &&
      url.password === "" &&
      !url.username.toLowerCase().startsWith("sntry")
    );
  } catch {
    return false;
  }
}

/** Build --define flags to bake config into compiled output: compiled executables do NOT
 * inherit the build-time environment, so identifiers must be replaced at compile time. */
export function buildDefines(): string[] {
  const version = process.env.DOSU_VERSION ?? readPackageVersion();
  const webAppURL = process.env.DOSU_WEB_APP_URL ?? "";
  const backendURL = process.env.DOSU_BACKEND_URL ?? "";
  const supabaseURL = process.env.SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";
  const installChannel = process.env.DOSU_INSTALL_CHANNEL ?? "npm";
  // PostHog project tokens and Sentry DSNs are public ingestion credentials,
  // but releases still inject them at build time so source builds stay inert.
  const rawPosthogProjectToken = process.env.DOSU_POSTHOG_PROJECT_TOKEN ?? "";
  const sentryDsn = process.env.DOSU_CLI_SENTRY_DSN?.trim() ?? "";
  const posthogProjectToken = parsePostHogProjectToken(rawPosthogProjectToken);
  if (rawPosthogProjectToken && !posthogProjectToken) {
    throw new Error(
      "DOSU_POSTHOG_PROJECT_TOKEN must be empty or a public phc_ project token; refusing to bake a management credential",
    );
  }
  if (sentryDsn && !isPublicClientDsn(sentryDsn)) {
    throw new Error(
      "DOSU_CLI_SENTRY_DSN must be empty or a public https:// client DSN; refusing to bake a secret",
    );
  }

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
    "--define",
    `process.env.DOSU_POSTHOG_PROJECT_TOKEN=${JSON.stringify(posthogProjectToken ?? "")}`,
    "--define",
    `process.env.DOSU_CLI_SENTRY_DSN=${JSON.stringify(sentryDsn)}`,
  ];
}

async function main() {
  const distDir = join(SCRIPT_DIR, "..", "dist");
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

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

    const { exitCode, stderr } = await compileBinary(outPath, target);
    if (exitCode !== 0) {
      console.error(`  ✗ Failed: ${stderr}`);
      process.exit(1);
    }
    console.log(`  ✓ ${output}`);
  }

  console.log(`\nAll binaries built in ${distDir}`);
}

/** Compile one standalone binary. `--sourcemap` embeds the map, so stack traces and the Sentry
 * events built from them point at src/ files. Bun also writes that map next to the binary, where
 * nothing reads it and it must not be archived as a release asset, so it is removed. */
export async function compileBinary(
  outfile: string,
  target?: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      "--sourcemap",
      ...buildDefines(),
      ...(target ? ["--target", target] : []),
      "src/index.ts",
      "--outfile",
      outfile,
    ],
    { stdout: "ignore", stderr: "pipe", env: process.env },
  );
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  rmSync(`${outfile}.map`, { force: true });
  return { exitCode, stderr };
}

// Only run when executed directly (not imported by tests)
const isDirectRun =
  typeof import.meta.dir === "string" && process.argv[1]?.endsWith("build-all.ts");
if (isDirectRun) main();
