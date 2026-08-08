/**
 * `dosu statusline` — Claude Code status line showing Dosu knowledge counts.
 *
 * Installs a renderer script (Python 3, stdlib only) into `~/.dosu/claude/`
 * and wires it into the user's `~/.claude/settings.json`. The per-session
 * counts it renders are recorded by `dosu hooks post-tool-use` / `stop`
 * (installed per project via `dosu hooks install claude-code`), covering both
 * explicit `read_knowledge` calls and hook-injected knowledge. The row renders
 * `Knowledge 📚 3 pages · 📝 77 notes` after a delivery and prints nothing
 * before one — an empty pre-delivery state is deliberate.
 */

import { spawnSync } from "node:child_process";
import { Command } from "commander";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The renderer is Python 3, stdlib only. Without it the install is inert. */
export function python3OnPath(): boolean {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    return spawnSync(cmd, ["python3"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export interface StatuslineInstallOptions {
  force?: boolean;
  json?: boolean;
}

export async function runStatuslineInstall(opts: StatuslineInstallOptions): Promise<void> {
  const { installStatuslineSettings, writeStatuslineScripts } = await import(
    "../statusline/install"
  );
  const warnings: string[] = [];
  if (!python3OnPath()) {
    warnings.push("python3 was not found on PATH — the status line will not render without it");
  }
  try {
    writeStatuslineScripts();
    const result = installStatuslineSettings(undefined, { force: opts.force });
    warnings.push(...result.warnings);
    if (opts.json) {
      const { emitStep } = await import("../agent/output");
      emitStep({
        step: "statusline-install",
        path: result.settingsPath,
        status_line: result.statusLine,
        existing_command: result.existingCommand,
        warnings,
      });
      if (result.statusLine === "conflict") process.exitCode = 1;
      return;
    }
    if (result.statusLine === "conflict") {
      process.exitCode = 1;
      console.log("⚠ You already have a Claude Code status line configured:");
      console.log(`    ${result.existingCommand}`);
      console.log("  Left it untouched. Re-run with --force to replace it (the original");
      console.log("  is backed up and restored on 'dosu statusline uninstall').");
    } else if (result.statusLine === "replaced") {
      console.log("✓ Replaced your existing status line (original backed up):");
      console.log(`    ${result.existingCommand}`);
    } else {
      console.log(
        result.statusLine === "updated"
          ? "✓ Refreshed the Dosu knowledge status line."
          : "✓ Installed the Dosu knowledge status line.",
      );
    }
    console.log(`  → ${result.settingsPath}`);
    console.log("  Counts are recorded by the Dosu hooks — run 'dosu hooks install claude-code'");
    console.log("  in each project. The row appears after the next knowledge delivery in a new");
    console.log("  session; it deliberately prints nothing until then.");
    for (const w of warnings) console.log(`⚠ ${w}`);
  } catch (err) {
    process.exitCode = 1;
    if (opts.json) {
      const { emitError } = await import("../agent/output");
      emitError({
        step: "statusline-install",
        reason: "write_failed",
        agent_next_steps: errMsg(err),
      });
    } else {
      console.error(`Failed to install status line: ${errMsg(err)}`);
    }
  }
}

export async function runStatuslineUninstall(opts: { json?: boolean }): Promise<void> {
  const { uninstallStatusline } = await import("../statusline/install");
  const result = uninstallStatusline();
  if (opts.json) {
    const { emitStep } = await import("../agent/output");
    emitStep({
      step: "statusline-uninstall",
      path: result.settingsPath,
      status_line_removed: result.statusLineRemoved,
      status_line_restored: result.statusLineRestored,
    });
    return;
  }
  if (result.statusLineRemoved) {
    console.log(`✓ Removed the Dosu knowledge status line from ${result.settingsPath}.`);
    if (result.statusLineRestored) {
      console.log("  Restored your previous status line from backup.");
    }
  } else {
    console.log("No Dosu status line was installed.");
  }
}

export async function runStatuslineStatus(opts: { json?: boolean }): Promise<void> {
  const { inspectStatusline } = await import("../statusline/install");
  const info = inspectStatusline();
  const python3 = python3OnPath();
  if (opts.json) {
    const { emitStep } = await import("../agent/output");
    emitStep({ step: "statusline-status", ...info, python3_on_path: python3 });
    return;
  }
  const icon = (ok: boolean) => (ok ? "✓" : "✗");
  console.log(`${icon(info.scriptInstalled)} renderer installed (~/.dosu/claude/)`);
  console.log(`${icon(info.statusLineConfigured)} statusLine configured (~/.claude/settings.json)`);
  console.log(`${icon(python3)} python3 on PATH`);
  if (info.settingsParseError) {
    console.log("✗ ~/.claude/settings.json exists but is not valid JSON");
  }
  for (const w of info.warnings) console.log(`⚠ ${w}`);
  console.log(
    "ℹ Counts are recorded by the Dosu hooks — check 'dosu hooks doctor' in your project.",
  );
}

export function statuslineCommand(): Command {
  const cmd = new Command("statusline").description(
    "Claude Code status line showing Dosu knowledge counts",
  );

  cmd
    .command("install")
    .description("Install the Dosu knowledge status line for Claude Code (user scope)")
    .option("--force", "Replace an existing status line (original is backed up)", false)
    .option("--json", "Emit machine-readable JSON", false)
    .addHelpText(
      "after",
      [
        "",
        "Shows how much knowledge Dosu last delivered to the session, e.g.:",
        "  Knowledge 📚 3 pages · 📝 77 notes",
        "",
        "Counts are recorded by the Dosu hooks ('dosu hooks install claude-code'),",
        "covering explicit read_knowledge calls and hook-injected knowledge alike.",
        "The row prints nothing until a delivery happens — that is deliberate.",
        "Requires python3 on PATH. Installs into ~/.claude/settings.json and",
        "~/.dosu/claude/; never overwrites an existing status line without --force.",
      ].join("\n"),
    )
    .action((opts: StatuslineInstallOptions) => runStatuslineInstall(opts));

  cmd
    .command("uninstall")
    .description("Remove the Dosu knowledge status line (restores any replaced status line)")
    .option("--json", "Emit machine-readable JSON", false)
    .action((opts: { json?: boolean }) => runStatuslineUninstall(opts));

  cmd
    .command("status")
    .description("Show whether the Dosu status line is installed and able to run")
    .option("--json", "Emit machine-readable JSON", false)
    .action((opts: { json?: boolean }) => runStatuslineStatus(opts));

  return cmd;
}
