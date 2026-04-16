/**
 * `dosu insights` — open a fun visual report of your deployment activity.
 *
 * One word, no flags. Builds an HTML report from `analytics.getUsageStats`
 * plus a few parallel `/ask` calls for narrative sections, writes it to
 * ~/.config/dosu-cli/insights/report.html, and opens it in the default browser.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

export function reportPath(): string {
  return join(getConfigDir(), "insights", "report.html");
}

export interface InsightsRunner {
  build: typeof buildInsights;
  render: typeof renderHTML;
  writeFile: (path: string, content: string) => void;
  openInBrowser: (path: string) => Promise<void>;
  ask: AskFn;
}

export async function runInsights(cfg: Config, runner: InsightsRunner): Promise<string> {
  const client = createTypedClient(cfg);

  console.log(pc.dim("✨ Looking at the last 30 days of your deployment..."));

  const report = await runner.build({ client, cfg, ask: runner.ask, windowDays: 30 });
  const html = runner.render(report);
  const path = reportPath();
  runner.writeFile(path, html);

  console.log("");
  console.log(pc.bold(`📊 Dosu Insights — ${report.deploymentName}`));
  if (report.cheers[0]) {
    console.log(pc.green(`   ${report.cheers[0]}`));
  }
  console.log("");
  console.log(`   Report: ${pc.cyan(`file://${path}`)}`);
  console.log(pc.dim("   Opening in your browser..."));

  try {
    await runner.openInBrowser(path);
  } catch {
    console.log(pc.dim("   (couldn't auto-open — copy the link above)"));
  }

  return path;
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
