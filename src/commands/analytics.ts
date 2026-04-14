/**
 * `dosu analytics` — usage statistics.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printInfo, printResult } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

interface UsageStats {
  total_responses?: number;
  answer_rate?: number;
  high_confidence_count?: number;
  medium_confidence_count?: number;
  low_confidence_count?: number;
  positive_reaction_count?: number;
  negative_reaction_count?: number;
  reaction_rate?: number;
  positive_rate?: number;
  [key: string]: unknown;
}

export function analyticsCommand(): Command {
  const cmd = new Command("analytics")
    .description("View usage statistics")
    .option("--days <n>", "Number of days to analyze (default: 30)", "30")
    .option("--json", "Output as JSON")
    .action(async (opts: { days?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const stats = await trpc.query<UsageStats>("analytics.getUsageStats", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        spaceId: cfg.space_id!,
        days: Number.parseInt(opts.days ?? "30", 10),
      });

      if (opts.json) {
        printResult(stats, opts);
        return;
      }

      const pct = (v?: number) => (v !== undefined ? `${(v * 100).toFixed(1)}%` : "—");

      printInfo(
        [
          ["Total Responses", String(stats.total_responses ?? 0)],
          ["Answer Rate", pct(stats.answer_rate)],
          ["High Confidence", String(stats.high_confidence_count ?? 0)],
          ["Medium Confidence", String(stats.medium_confidence_count ?? 0)],
          ["Low Confidence", String(stats.low_confidence_count ?? 0)],
          ["Positive Reactions", String(stats.positive_reaction_count ?? 0)],
          ["Negative Reactions", String(stats.negative_reaction_count ?? 0)],
          ["Reaction Rate", pct(stats.reaction_rate)],
          ["Positive Rate", pct(stats.positive_rate)],
        ],
        { rawData: stats },
      );
    });

  return cmd;
}
