/** `dosu upgrade` — delegate updates to the package manager that owns the install. */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { INSTALL_CHANNEL, isNpxInvocation } from "../version/version";

const PACKAGE_NAME = "@dosu/cli";
const LATEST_PACKAGE = `${PACKAGE_NAME}@latest`;
const BREW_MANUAL_COMMAND = "brew upgrade dosu-ai/dosu/dosu";
const NPX_COMMAND = "npx -y @dosu/cli@latest";
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
  if (platform === "win32") {
    return {
      command: isAbsoluteCommandProcessor(comSpec) ? comSpec : windowsCommandProcessor(env),
      args: ["/d", "/s", "/c", [manager, ...args].join(" ")],
      // Prevent cmd.exe from resolving a malicious package-manager shim in the project first.
      env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" },
    };
  }
  return { command: manager, args: [...args] };
}

function packageRoots(
  manager: GlobalPackageManager,
  platform: NodeJS.Platform,
  comSpec: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const invocation = buildPackageManagerInvocation(manager, "locate", platform, comSpec, env);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    ...(invocation.env ? { env: invocation.env } : {}),
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
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
    packageRoots(manager, platform, comSpec, env).some((root) => {
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
    );
    if (!manager) {
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

export function upgradeCommand(): Command {
  return new Command("upgrade").description("Update Dosu to the latest version").action(() => {
    const status = runUpgrade();
    if (status !== 0) process.exitCode = status;
  });
}
