/** `dosu upgrade` — delegate updates to the package manager that owns the install. */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { INSTALL_CHANNEL, isNpxInvocation } from "../version/version";

const NPM_MANUAL_COMMAND = "npm install -g @dosu/cli@latest";
const BREW_MANUAL_COMMAND = "brew upgrade dosu-ai/dosu/dosu";
const NPX_COMMAND = "npx -y @dosu/cli@latest";
const RELEASES_URL = "https://github.com/dosu-ai/dosu-cli/releases/latest";

interface Invocation {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface UpgradePlan extends Invocation {
  label: string;
  manualCommand: string;
}

type NpmAction = "root" | "install";

function windowsCommandProcessor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (env.ComSpec && win32.isAbsolute(env.ComSpec)) return env.ComSpec;
  const systemRoot =
    env.SystemRoot && win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return win32.join(systemRoot, "System32", "cmd.exe");
}

export function buildNpmInvocation(
  action: NpmAction,
  platform: NodeJS.Platform = process.platform,
  comSpec?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Invocation {
  if (platform === "win32") {
    return {
      command: comSpec && win32.isAbsolute(comSpec) ? comSpec : windowsCommandProcessor(env),
      args: ["/d", "/s", "/c", action === "root" ? "npm root -g" : NPM_MANUAL_COMMAND],
      // Prevent cmd.exe from resolving a malicious npm.cmd in the current project first.
      env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" },
    };
  }
  return action === "root"
    ? { command: "npm", args: ["root", "-g"] }
    : { command: "npm", args: ["install", "-g", "@dosu/cli@latest"] };
}

function globalNpmRoot(
  platform: NodeJS.Platform,
  comSpec: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const invocation = buildNpmInvocation("root", platform, comSpec, env);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    ...(invocation.env ? { env: invocation.env } : {}),
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim() || null;
}

function isGlobalNpmInstallation(
  entrypoint: string | undefined,
  platform: NodeJS.Platform,
  comSpec?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!entrypoint) return false;
  const root = globalNpmRoot(platform, comSpec, env);
  if (!root) return false;

  const path = platform === "win32" ? win32 : posix;
  try {
    const packageRoot = realpathSync(path.join(root, "@dosu", "cli"));
    const relative = path.relative(packageRoot, realpathSync(entrypoint));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function upgradePlan(
  channel: string,
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
  if (channel === "npm") {
    const invocation = buildNpmInvocation("install", platform, comSpec, env);
    return {
      label: "npm",
      ...invocation,
      manualCommand: NPM_MANUAL_COMMAND,
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

function printNonGlobalNpmGuidance(): void {
  console.log("This Dosu copy is not a global npm installation, so it was not changed.");
  console.log(`\nRun the latest version without installing:\n  ${NPX_COMMAND}`);
  console.log(`\nOr install Dosu globally:\n  ${NPM_MANUAL_COMMAND}`);
}

export function runUpgrade(channel = INSTALL_CHANNEL, options: UpgradeOptions = {}): number {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (channel === "npm") {
    if (isNpxInvocation(channel, env)) {
      printNonGlobalNpmGuidance();
      return 1;
    }
    if (
      !isGlobalNpmInstallation(
        options.entrypoint ?? process.argv[1],
        platform,
        options.comSpec,
        env,
      )
    ) {
      printNonGlobalNpmGuidance();
      return 1;
    }
  }

  const plan = upgradePlan(channel, platform, options.comSpec, env);
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
