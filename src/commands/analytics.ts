/**
 * `dosu analytics` — usage statistics.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printInfo, printResult } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function analyticsCommand(): Command {
  const cmd = new Command("analytics")
    .description("View usage statistics")
    .option("--days <n>", "Number of days to analyze (default: 30)", "30")
    .option("--json", "Output as JSON")
    .action(async (opts: { days?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const stats = await client.analytics.getUsageStats.query({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        spaceId: cfg.active_account!.target!.space_id!,
        days: Number.parseInt(opts.days ?? "30", 10),
      });

      if (opts.json) {
        printResult(stats, opts);
        return;
      }

      const pct = (v?: number) => (v !== undefined ? `${(v * 100).toFixed(1)}%` : "—");
      const highConfidenceRate =
        stats.totalResponses > 0 ? stats.byConfidence.high / stats.totalResponses : undefined;

      printInfo(
        [
          ["Total Responses", String(stats.totalResponses)],
          ["High-Confidence Share", pct(highConfidenceRate)],
          ["High Confidence", String(stats.byConfidence.high)],
          ["Medium Confidence", String(stats.byConfidence.medium)],
          ["Low Confidence", String(stats.byConfidence.low)],
          ["Positive Reactions", String(stats.reactions.totalPositive)],
          ["Negative Reactions", String(stats.reactions.totalNegative)],
          ["Positive Rate", pct(stats.reactions.positiveRate)],
        ],
        { rawData: stats },
      );
    });

  return cmd;
}
