/**
 * `dosu insights`: open a fun visual report of your space activity.
 *
 * One word, no flags. Builds an HTML report from `analytics.getUsageStats`
 * plus a few parallel `/ask` calls for narrative sections, writes it to
 * ~/.config/dosu-cli/insights/ (timestamped snapshot + latest.html), and opens it in the default browser.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { type Config, getConfigDir, loadConfig } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { type AskFn, buildInsights, type InsightsStage, renderHTML } from "../insights";
import { runSetup } from "../setup/flow";

const ASK_TIMEOUT_MS = 90_000;
const KEEP_REPORTS = 20;
const REPORT_FILE_PATTERN = /^report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.html$/;
const HINT_INTERVAL_MS = 6_000;
export const NARRATIVE_HINTS = [
  "Reading your reactions and confidence levels",
  "Looking for the story in your numbers",
  "Drafting your at-a-glance summary",
  "Spotting the highlights of the week",
  "Sifting through signal and noise",
  "Tracking what changed week over week",
  "Following the threads with the most reactions",
  "Pulling together the highlights",
  "Tuning the headlines for clarity",
  "Surfacing the wins worth sharing",
  "Pondering the patterns",
  "Composing your weekly recap",
  "Crunching the deltas",
  "Catching the standouts",
  "Polishing the writeup",
];

function shuffled<T>(arr: readonly T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string, code?: number): void;
}

export function createDotsSpinner(): Spinner {
  let frameIdx = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let current = "";
  const isTTY = Boolean(process.stdout.isTTY) && process.env.CI !== "true";

  const draw = () => {
    process.stdout.write(`\r\x1b[2K${pc.cyan(SPINNER_FRAMES[frameIdx])} ${current}`);
    frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
  };

  return {
    start(msg) {
      current = msg;
      if (!isTTY) {
        process.stdout.write(`${msg}\n`);
        return;
      }
      draw();
      timer = setInterval(draw, SPINNER_INTERVAL_MS);
    },
    message(msg) {
      current = msg;
    },
    stop(msg, code = 0) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const symbol = code === 0 ? pc.green("✓") : pc.red("✗");
      if (isTTY) {
        process.stdout.write(`\r\x1b[2K${symbol} ${msg}\n`);
      } else {
        process.stdout.write(`${symbol} ${msg}\n`);
      }
    },
  };
}

function isFullConfig(cfg: Config): boolean {
  return Boolean(
    cfg.active_account?.session.access_token &&
      cfg.active_account?.target?.api_key &&
      cfg.active_account?.target?.space_id &&
      cfg.active_account?.target?.deployment_id,
  );
}

export async function ensureFullConfig(): Promise<Config | null> {
  let cfg = loadConfig();
  if (isFullConfig(cfg)) return cfg;

  const reason = !cfg.active_account?.session.access_token
    ? "Insights needs you to log in first."
    : "Insights needs a configured Dosu deployment.";
  p.log.warn(reason);

  const shouldSetup = await p.confirm({
    message: "Run setup now?",
    initialValue: true,
  });
  if (p.isCancel(shouldSetup) || !shouldSetup) return null;

  await runSetup();

  cfg = loadConfig();
  return isFullConfig(cfg) ? cfg : null;
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
          "X-Dosu-API-Key": cfg.active_account!.target!.api_key!,
        },
        body: JSON.stringify({
          // biome-ignore lint/style/noNonNullAssertion: checked in requireFullConfig
          deployment_id: cfg.active_account!.target!.deployment_id!,
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
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    logger.debug(
      "insights",
      `failed to list ${dir} for pruning: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  const reports = entries
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
  createSpinner: () => Spinner;
}

export async function runInsights(cfg: Config, runner: InsightsRunner): Promise<string> {
  const client = createTypedClient(cfg);
  const spinner = runner.createSpinner();
  let hintTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerActive = false;

  const stopHints = () => {
    if (hintTimer) {
      clearInterval(hintTimer);
      hintTimer = undefined;
    }
  };

  const onProgress = (stage: InsightsStage) => {
    if (stage === "stats") {
      spinner.start("Looking at the last 30 days of your space");
      spinnerActive = true;
    } else if (stage === "narrative") {
      const hints = shuffled(NARRATIVE_HINTS);
      let hintIdx = 0;
      spinner.message(hints[hintIdx]);
      stopHints();
      hintTimer = setInterval(() => {
        hintIdx = (hintIdx + 1) % hints.length;
        spinner.message(hints[hintIdx]);
      }, HINT_INTERVAL_MS);
    }
  };

  let report: Awaited<ReturnType<typeof runner.build>>;
  try {
    report = await runner.build({ client, cfg, ask: runner.ask, windowDays: 30, onProgress });
  } catch (err) {
    stopHints();
    if (spinnerActive) spinner.stop("Couldn't build your insights", 1);
    throw err;
  }
  stopHints();
  if (spinnerActive) spinner.stop("Insights ready");

  const html = runner.render(report);
  const timestamp = new Date();
  const snapshotPath = reportPath(timestamp);
  const latestPath = reportPath();
  runner.writeFile(snapshotPath, html);
  runner.writeFile(latestPath, html);
  runner.prune(insightsDir(), KEEP_REPORTS);

  console.log("");
  console.log(pc.bold(`📊 Dosu Insights · ${report.spaceName}`));
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
    console.log(pc.dim("   (couldn't auto-open. Copy the link above.)"));
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
    createSpinner: createDotsSpinner,
  };
}

/**
 * Run the insights flow with the default runner. Shared by the CLI command
 * and the TUI menu so both surfaces produce identical output.
 *
 * Logs and swallows errors so callers (TUI) shouldn't crash on one bad insights run.
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
    .description("Open a fun visual report of your Dosu space activity")
    .action(async () => {
      const cfg = await ensureFullConfig();
      if (!cfg) return;
      try {
        await runInsights(cfg, defaultRunner(cfg));
      } catch (err) {
        console.error(pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
