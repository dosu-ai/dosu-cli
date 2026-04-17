/**
 * `dosu insights` — open a fun visual report of your deployment activity.
 *
 * One word, no flags. Builds an HTML report from `analytics.getUsageStats`
 * plus a few parallel `/ask` calls for narrative sections, writes it to
 * ~/.config/dosu-cli/insights/ (timestamped snapshot + latest.html), and opens it in the default browser.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { type Config, getConfigDir } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { type AskFn, buildInsights, renderHTML } from "../insights";
import { requireAPIKey, requireLoginConfig } from "./auth";

const ASK_TIMEOUT_MS = 90_000;
const KEEP_REPORTS = 20;
const REPORT_FILE_PATTERN = /^report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.html$/;

function requireFullConfig(): Config {
  const cfg = requireLoginConfig();
  requireAPIKey(cfg);
  if (!cfg.space_id || !cfg.deployment_id) {
    console.error(pc.red("Missing deployment config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function makeAskFn(cfg: Config): AskFn {
  const backendURL = getBackendURL();
  if (!backendURL) {
    logger.warn("insights", "Backend URL not configured; narrative sections will be skipped.");
    return async () => null;
  }
  return async (question) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
      const resp = await fetch(`${backendURL}/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // biome-ignore lint/style/noNonNullAssertion: checked in requireFullConfig
          "X-Dosu-API-Key": cfg.api_key!,
        },
        body: JSON.stringify({
          // biome-ignore lint/style/noNonNullAssertion: checked in requireFullConfig
          deployment_id: cfg.deployment_id!,
          question,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        logger.debug("insights", `ask returned ${resp.status}`);
        return null;
      }
      const body = (await resp.json()) as { answer?: unknown };
      return typeof body.answer === "string" ? body.answer : null;
    } catch (err) {
      logger.debug("insights", `ask failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  };
}

export function insightsDir(): string {
  return join(getConfigDir(), "insights");
}

export function reportPath(timestamp?: Date): string {
  const dir = insightsDir();
  if (!timestamp) return join(dir, "latest.html");
  const iso = timestamp.toISOString().slice(0, 19).replace(/:/g, "-");
  return join(dir, `report-${iso}Z.html`);
}

export function pruneOldReports(dir: string, keepN: number): void {
  if (!existsSync(dir)) return;
  const reports = readdirSync(dir)
    .filter((f) => REPORT_FILE_PATTERN.test(f))
    .sort()
    .reverse();
  for (const f of reports.slice(keepN)) {
    try {
      unlinkSync(join(dir, f));
    } catch (err) {
      logger.debug("insights", `failed to prune ${f}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export interface InsightsRunner {
  build: typeof buildInsights;
  render: typeof renderHTML;
  writeFile: (path: string, content: string) => void;
  prune: (dir: string, keepN: number) => void;
  openInBrowser: (path: string) => Promise<void>;
  ask: AskFn;
}

export async function runInsights(cfg: Config, runner: InsightsRunner): Promise<string> {
  const client = createTypedClient(cfg);

  console.log(pc.dim("✨ Looking at the last 30 days of your deployment..."));

  const report = await runner.build({ client, cfg, ask: runner.ask, windowDays: 30 });
  const html = runner.render(report);
  const timestamp = new Date();
  const snapshotPath = reportPath(timestamp);
  const latestPath = reportPath();
  runner.writeFile(snapshotPath, html);
  runner.writeFile(latestPath, html);
  runner.prune(insightsDir(), KEEP_REPORTS);

  console.log("");
  console.log(pc.bold(`📊 Dosu Insights — ${report.deploymentName}`));
  if (report.cheers[0]) {
    console.log(pc.green(`   ${report.cheers[0]}`));
  }
  console.log("");
  console.log(`   Snapshot: ${pc.cyan(`file://${snapshotPath}`)}`);
  console.log(`   Latest:   ${pc.cyan(`file://${latestPath}`)}`);
  console.log(pc.dim("   Opening in your browser..."));

  try {
    await runner.openInBrowser(snapshotPath);
  } catch {
    console.log(pc.dim("   (couldn't auto-open — copy the link above)"));
  }

  return snapshotPath;
}

export function defaultRunner(cfg: Config): InsightsRunner {
  return {
    build: buildInsights,
    render: renderHTML,
    writeFile: (path, content) => {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
    },
    prune: pruneOldReports,
    openInBrowser: async (path) => {
      const open = await import("open");
      await open.default(path);
    },
    ask: makeAskFn(cfg),
  };
}

/**
 * Run the insights flow with the default runner. Shared by the CLI command
 * and the TUI menu so both surfaces produce identical output.
 *
 * Logs and swallows errors — callers (TUI) shouldn't crash on one bad insights run.
 */
export async function executeInsights(cfg: Config): Promise<void> {
  try {
    await runInsights(cfg, defaultRunner(cfg));
  } catch (err) {
    console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
  }
}

export function insightsCommand(): Command {
  return new Command("insights")
    .description("Open a fun visual report of your Dosu deployment activity")
    .action(async () => {
      const cfg = requireFullConfig();
      try {
        await runInsights(cfg, defaultRunner(cfg));
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
