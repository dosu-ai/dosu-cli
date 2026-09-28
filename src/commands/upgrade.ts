/** `dosu upgrade` — delegate updates to the package manager that owns the install. */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { INSTALL_CHANNEL, isNpxInvocation } from "../version/version";
import { installSkill } from "./skill";

const PACKAGE_NAME = "@dosu/cli";
const LATEST_PACKAGE = `${PACKAGE_NAME}@latest`;
const BREW_MANUAL_COMMAND = "brew upgrade dosu-ai/dosu/dosu";
const NPX_COMMAND = "npx -y @dosu/cli@latest";
const PROBE_TIMEOUT_MS = 5_000;
const RELEASES_URL = "https://github.com/dosu-ai/dosu-cli/releases/latest";

type GlobalPackageManager = "npm" | "pnpm" | "yarn";
type PackageManagerAction = "locate" | "install";

const PACKAGE_MANAGERS: Record<
  GlobalPackageManager,
  { label: string; locateArgs: string[]; installArgs: string[] }
> = {
  npm: {
    label: "npm",
    locateArgs: ["root", "-g"],
    installArgs: ["install", "-g", LATEST_PACKAGE],
  },
  pnpm: {
    label: "pnpm",
    locateArgs: ["list", "-g", "--depth=0", "--parseable", PACKAGE_NAME],
    installArgs: ["add", "-g", LATEST_PACKAGE],
  },
  yarn: {
    label: "Yarn Classic",
    locateArgs: ["--silent", "global", "dir"],
    installArgs: ["global", "add", LATEST_PACKAGE],
  },
};

interface Invocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface UpgradePlan extends Invocation {
  label: string;
  manualCommand: string;
}

function isAbsoluteCommandProcessor(value: string | undefined): value is string {
  return Boolean(
    value && win32.isAbsolute(value) && win32.basename(value).toLowerCase() === "cmd.exe",
  );
}

function windowsCommandProcessor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (isAbsoluteCommandProcessor(env.ComSpec)) return env.ComSpec;
  const systemRoot =
    env.SystemRoot && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return win32.join(systemRoot, "System32", "cmd.exe");
}

function safePackageManagerEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  // The caller's project must not select a package-manager binary or trigger a Corepack download.
  return {
    ...env,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    YARN_IGNORE_PATH: "1",
  };
}

export function buildPackageManagerInvocation(
  manager: GlobalPackageManager,
  action: PackageManagerAction,
  platform: NodeJS.Platform = process.platform,
  comSpec?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Invocation {
  const args =
    action === "locate"
      ? PACKAGE_MANAGERS[manager].locateArgs
      : PACKAGE_MANAGERS[manager].installArgs;
  const safeEnv = safePackageManagerEnv(env);
  if (platform === "win32") {
    return {
      command: isAbsoluteCommandProcessor(comSpec) ? comSpec : windowsCommandProcessor(env),
      args: ["/d", "/s", "/c", [manager, ...args].join(" ")],
      // Prevent cmd.exe from resolving a malicious package-manager shim in the project first.
      env: { ...safeEnv, NoDefaultCurrentDirectoryInExePath: "1" },
    };
  }
  return { command: manager, args: [...args], env: safeEnv };
}

function packageRoots(
  manager: GlobalPackageManager,
  platform: NodeJS.Platform,
  comSpec: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string[] {
  const invocation = buildPackageManagerInvocation(manager, "locate", platform, comSpec, env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: invocation.env,
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];

  const path = platform === "win32" ? win32 : posix;
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line));

  if (manager === "pnpm") {
    return lines.filter(
      (line) =>
        path.basename(line) === "cli" &&
        path.basename(path.dirname(line)) === "@dosu" &&
        path.basename(path.dirname(path.dirname(line))) === "node_modules",
    );
  }
  if (lines.length !== 1) return [];
  return [
    manager === "npm"
      ? path.join(lines[0], "@dosu", "cli")
      : path.join(lines[0], "node_modules", "@dosu", "cli"),
  ];
}

function owningPackageManager(
  entrypoint: string | undefined,
  platform: NodeJS.Platform,
  comSpec?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = homedir(),
): GlobalPackageManager | null {
  const path = platform === "win32" ? win32 : posix;
  if (!entrypoint || !path.isAbsolute(entrypoint)) return null;

  let realEntrypoint: string;
  try {
    realEntrypoint = realpathSync(entrypoint);
  } catch {
    return null;
  }

  const owners = (Object.keys(PACKAGE_MANAGERS) as GlobalPackageManager[]).filter((manager) =>
    packageRoots(manager, platform, comSpec, env, cwd).some((root) => {
      try {
        const relative = path.relative(realpathSync(root), realEntrypoint);
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      } catch {
        return false;
      }
    }),
  );
  return owners.length === 1 ? owners[0] : null;
}

function upgradePlan(
  channel: string,
  manager: GlobalPackageManager | null,
  platform: NodeJS.Platform,
  comSpec?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): UpgradePlan | null {
  if (channel === "homebrew") {
    return {
      label: "Homebrew",
      command: "brew",
      args: ["upgrade", "dosu-ai/dosu/dosu"],
      manualCommand: BREW_MANUAL_COMMAND,
    };
  }
  if (channel === "npm" && manager) {
    const invocation = buildPackageManagerInvocation(manager, "install", platform, comSpec, env);
    return {
      label: PACKAGE_MANAGERS[manager].label,
      ...invocation,
      manualCommand: [manager, ...PACKAGE_MANAGERS[manager].installArgs].join(" "),
    };
  }
  return null;
}

interface UpgradeOptions {
  entrypoint?: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** Whether a person can answer prompts; defaults to stdin+stdout being TTYs. */
  interactive?: boolean;
}

function printNonGlobalPackageGuidance(): void {
  console.log(
    "This Dosu copy is not a uniquely identified global package installation, so it was not changed.",
  );
  console.log(`\nRun the latest version without installing:\n  ${NPX_COMMAND}`);
  console.log("\nOr install Dosu globally with your package manager:");
  for (const manager of Object.keys(PACKAGE_MANAGERS) as GlobalPackageManager[]) {
    console.log(`  ${manager} ${PACKAGE_MANAGERS[manager].installArgs.join(" ")}`);
  }
}

export function runUpgrade(channel = INSTALL_CHANNEL, options: UpgradeOptions = {}): number {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  // Global operations do not need the caller's project, whose config may execute arbitrary code.
  const cwd = options.cwd ?? homedir();
  let manager: GlobalPackageManager | null = null;

  if (channel === "npm") {
    if (isNpxInvocation(channel, env)) {
      printNonGlobalPackageGuidance();
      return 1;
    }
    manager = owningPackageManager(
      options.entrypoint ?? process.argv[1],
      platform,
      options.comSpec,
      env,
      cwd,
    );
    if (!manager) {
      if (env.DOSU_DEV === "true") {
        // `bun run dev upgrade`: nothing to install, but let the post-upgrade hand-off run
        // against this working copy so the whole flow can be exercised from source.
        console.log(
          "DOSU_DEV=true and this copy is not a global package: skipping the package install.",
        );
        return 0;
      }
      printNonGlobalPackageGuidance();
      return 1;
    }
  }

  const plan = upgradePlan(channel, manager, platform, options.comSpec, env);
  if (!plan) {
    console.log("Automatic upgrades are not available for this installation yet.");
    console.log(`Download the latest release:\n  ${RELEASES_URL}`);
    return 1;
  }

  console.log(`Updating Dosu with ${plan.label}...`);
  console.log(`  ${plan.manualCommand}\n`);
  const result = spawnSync(plan.command, plan.args, {
    ...(channel === "npm" ? { cwd } : {}),
    ...(plan.env ? { env: plan.env } : {}),
    shell: false,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error("\nCould not update Dosu automatically.");
    console.error(`Run manually:\n  ${plan.manualCommand}`);
    return result.status && result.status > 0 ? result.status : 1;
  }

  console.log(pc.green("\n✓ Update command completed."));
  console.log('Run "dosu --version" to verify.');
  return 0;
}

const SETUP_FALLBACK = 'Run "dosu setup" to finish updating your AI agents.';

/** What the upgraded binary should run: the full setup wizard when a person is at the terminal
 * (it re-applies MCP, hooks, status line, rules, and skill), or the silent MCP refresh when
 * there is no TTY to drive prompts. */
export function postUpgradeArgs(interactive: boolean): string[] {
  return interactive ? ["setup"] : ["mcp", "refresh"];
}

/** How to re-invoke Dosu after the package manager swapped the files underneath us. Only the
 * freshly installed version knows the new config shapes, so the rewrite must happen in a new
 * process, not in this (old) one. */
export function newBinaryInvocation(
  channel: string,
  args: string[],
  entrypoint: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): Invocation | null {
  if (channel === "npm") {
    // npm/pnpm/yarn replace the package in place, so the entrypoint path now holds the new code.
    return entrypoint ? { command: execPath, args: [entrypoint, ...args] } : null;
  }
  if (channel === "homebrew") {
    // The running binary is the old Cellar version; `dosu` on PATH is the upgraded link.
    return { command: "dosu", args };
  }
  return null;
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function setupAgentsWithNewBinary(
  channel: string,
  interactive: boolean,
  options: UpgradeOptions,
): void {
  const invocation = newBinaryInvocation(
    channel,
    postUpgradeArgs(interactive),
    options.entrypoint ?? process.argv[1],
  );
  /* v8 ignore start -- runUpgrade only succeeds for channels/entrypoints that resolve here */
  if (!invocation) {
    console.error(SETUP_FALLBACK);
    return;
  }
  /* v8 ignore stop */
  console.log(
    interactive
      ? "\nRunning setup with the new version to update your AI agents...\n"
      : "\nRefreshing agent MCP configs with the new version...",
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? homedir(),
    shell: false,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(SETUP_FALLBACK);
  }
}

export async function completeUpgrade(
  channel = INSTALL_CHANNEL,
  options: UpgradeOptions = {},
): Promise<number> {
  const status = runUpgrade(channel, options);
  if (status !== 0) return status;
  const interactive = options.interactive ?? isInteractiveTerminal();
  // The interactive hand-off runs `setup`, which reinstalls skills itself; only the silent
  // `mcp refresh` path needs the old process to refresh them.
  if (!interactive) {
    console.log("Updating Dosu skills...");
    try {
      const result = await installSkill();
      if (result.success) {
        console.log(pc.green("✓ Skills updated."));
      } else {
        console.error('Skills could not be refreshed. Run "dosu skill update" to retry.');
      }
    } catch {
      console.error('Skills could not be refreshed. Run "dosu skill update" to retry.');
    }
  }
  setupAgentsWithNewBinary(channel, interactive, options);
  return 0;
}

export function upgradeCommand(): Command {
  return new Command("upgrade")
    .description("Update Dosu to the latest version, then re-run setup to update your AI agents")
    .action(async () => {
      const status = await completeUpgrade();
      if (status !== 0) process.exitCode = status;
    });
}
