/**
 * Build an InsightsReport for the user's Dosu space.
 *
 * Hard numbers come from `analytics.getUsageStats` for the current and prior
 * windows. The "investigate" warnings, "cheers" wins, and "suggestions" CTAs
 * are all derived locally from those numbers, so every report has actionable
 * content even if the optional /ask narrative call fails.
 *
 * The single /ask call powers only the warm at-a-glance prose. If it fails or
 * times out, we fall back to a stats-grounded summary so atAGlance is never
 * empty.
 */

import type { TypedClient } from "../client/trpc";
import type { Config } from "../config/config";

export interface UsageStats {
  totalResponses: number;
  byConfidence: { high: number; medium: number; low: number };
  reactions: {
    totalPositive: number;
    totalNegative: number;
    messagesWithReactions: number;
    reactionRate: number;
    positiveRate: number;
  };
}

export interface Suggestion {
  headline: string;
  detail: string;
  command?: string;
}

export interface InsightsReport {
  generatedAt: string;
  windowDays: number;
  spaceName: string;
  current: UsageStats;
  previous: UsageStats;
  derived: {
    highConfidenceRate: number | null;
    highConfidenceRateDelta: number | null;
    responsesDelta: number;
    positiveRateDelta: number | null;
    hasPriorWindow: boolean;
  };
  atAGlance: string;
  cheers: string[];
  investigate: string[];
  suggestions: Suggestion[];
}

export type AskFn = (question: string) => Promise<string | null>;

export type InsightsStage = "stats" | "narrative";
export type ProgressFn = (stage: InsightsStage) => void;

export interface BuildInsightsArgs {
  client: TypedClient;
  cfg: Config;
  ask: AskFn;
  windowDays?: number;
  now?: () => Date;
  onProgress?: ProgressFn;
}

const EMPTY_STATS: UsageStats = {
  totalResponses: 0,
  byConfidence: { high: 0, medium: 0, low: 0 },
  reactions: {
    totalPositive: 0,
    totalNegative: 0,
    messagesWithReactions: 0,
    reactionRate: 0,
    positiveRate: 0,
  },
};

export async function buildInsights({
  client,
  cfg,
  ask,
  windowDays = 30,
  now = () => new Date(),
  onProgress,
}: BuildInsightsArgs): Promise<InsightsReport> {
  if (!cfg.space_id) {
    throw new Error("space_id missing — run 'dosu setup' first");
  }
  const spaceId = cfg.space_id;

  onProgress?.("stats");
  const [currentRaw, combinedRaw] = await Promise.all([
    client.analytics.getUsageStats.query({ spaceId, days: windowDays }),
    client.analytics.getUsageStats.query({ spaceId, days: windowDays * 2 }),
  ]);

  const current = normalizeStats(currentRaw);
  const combined = normalizeStats(combinedRaw);
  const previous = subtractStats(combined, current);

  const derived = computeDerived(current, previous);
  const cheers = computeCheers(current, derived);
  const investigate = computeInvestigate(current, previous, derived);
  const suggestions = computeSuggestions(current, previous, derived);

  onProgress?.("narrative");
  const atAGlanceFromAsk = await ask(buildAtAGlancePrompt(current, derived, windowDays));
  const atAGlance = atAGlanceFromAsk ?? fallbackAtAGlance(current, derived, windowDays);

  return {
    generatedAt: now().toISOString(),
    windowDays,
    spaceName: cfg.deployment_name ?? "your space",
    current,
    previous,
    derived,
    atAGlance,
    cheers,
    investigate,
    suggestions,
  };
}

function normalizeStats(raw: UsageStats | null | undefined): UsageStats {
  if (!raw) return { ...EMPTY_STATS };
  return {
    totalResponses: raw.totalResponses ?? 0,
    byConfidence: {
      high: raw.byConfidence?.high ?? 0,
      medium: raw.byConfidence?.medium ?? 0,
      low: raw.byConfidence?.low ?? 0,
    },
    reactions: {
      totalPositive: raw.reactions?.totalPositive ?? 0,
      totalNegative: raw.reactions?.totalNegative ?? 0,
      messagesWithReactions: raw.reactions?.messagesWithReactions ?? 0,
      reactionRate: raw.reactions?.reactionRate ?? 0,
      positiveRate: raw.reactions?.positiveRate ?? 0,
    },
  };
}

function subtractStats(combined: UsageStats, current: UsageStats): UsageStats {
  const totalResponses = Math.max(0, combined.totalResponses - current.totalResponses);
  const positive = Math.max(0, combined.reactions.totalPositive - current.reactions.totalPositive);
  const negative = Math.max(0, combined.reactions.totalNegative - current.reactions.totalNegative);
  const reactionMsgs = Math.max(
    0,
    combined.reactions.messagesWithReactions - current.reactions.messagesWithReactions,
  );
  const totalReactions = positive + negative;
  return {
    totalResponses,
    byConfidence: {
      high: Math.max(0, combined.byConfidence.high - current.byConfidence.high),
      medium: Math.max(0, combined.byConfidence.medium - current.byConfidence.medium),
      low: Math.max(0, combined.byConfidence.low - current.byConfidence.low),
    },
    reactions: {
      totalPositive: positive,
      totalNegative: negative,
      messagesWithReactions: reactionMsgs,
      reactionRate: totalResponses > 0 ? reactionMsgs / totalResponses : 0,
      positiveRate: totalReactions > 0 ? positive / totalReactions : 0,
    },
  };
}

function computeDerived(current: UsageStats, previous: UsageStats): InsightsReport["derived"] {
  const highConfidenceRate =
    current.totalResponses > 0 ? current.byConfidence.high / current.totalResponses : null;
  const prevHighConfidenceRate =
    previous.totalResponses > 0 ? previous.byConfidence.high / previous.totalResponses : null;
  const highConfidenceRateDelta =
    highConfidenceRate !== null && prevHighConfidenceRate !== null
      ? highConfidenceRate - prevHighConfidenceRate
      : null;

  const positiveRateDelta =
    current.reactions.totalPositive + current.reactions.totalNegative > 0 &&
    previous.reactions.totalPositive + previous.reactions.totalNegative > 0
      ? current.reactions.positiveRate - previous.reactions.positiveRate
      : null;

  return {
    highConfidenceRate,
    highConfidenceRateDelta,
    responsesDelta: current.totalResponses - previous.totalResponses,
    positiveRateDelta,
    hasPriorWindow: previous.totalResponses > 0,
  };
}

function computeCheers(stats: UsageStats, derived: InsightsReport["derived"]): string[] {
  const out: string[] = [];
  if (stats.totalResponses === 0) {
    out.push(
      "Your space is brand new and ready to roll. Share `dosu setup` with your team to start asking questions.",
    );
    return out;
  }
  if (derived.highConfidenceRate !== null && derived.highConfidenceRate >= 0.8) {
    out.push(
      `${pct(derived.highConfidenceRate)} of responses were high-confidence — Dosu's knowledge base is paying off.`,
    );
  }
  if (stats.byConfidence.high > stats.byConfidence.low * 2 && stats.byConfidence.high > 0) {
    out.push(
      `${stats.byConfidence.high} high-confidence answers vs ${stats.byConfidence.low} low — your knowledge base has the receipts.`,
    );
  }
  if (
    stats.reactions.totalPositive + stats.reactions.totalNegative > 0 &&
    stats.reactions.positiveRate >= 0.8
  ) {
    out.push(
      `${pct(stats.reactions.positiveRate)} positive feedback — your team is loving the answers.`,
    );
  }
  if (derived.hasPriorWindow && derived.responsesDelta > 0) {
    out.push(`Volume is up by ${derived.responsesDelta} responses vs the prior window. 📈`);
  }
  if (out.length === 0) {
    out.push(
      `${stats.totalResponses} responses logged this window — every one is a chance to learn what your team needs.`,
    );
  }
  return out;
}

function computeInvestigate(
  current: UsageStats,
  previous: UsageStats,
  derived: InsightsReport["derived"],
): string[] {
  const out: string[] = [];
  if (current.totalResponses === 0) return out;

  if (
    derived.highConfidenceRateDelta !== null &&
    derived.highConfidenceRateDelta <= -0.05 &&
    previous.totalResponses > 0
  ) {
    const before = pct(previous.byConfidence.high / previous.totalResponses);
    const now = pct(current.byConfidence.high / current.totalResponses);
    out.push(
      `High-confidence share dropped from ${before} to ${now}. Usually a sign of a new product area Dosu doesn't have docs for yet.`,
    );
  }

  const lowDelta = current.byConfidence.low - previous.byConfidence.low;
  if (derived.hasPriorWindow && lowDelta >= 5 && current.byConfidence.low > 0) {
    out.push(
      `Low-confidence answers grew by ${lowDelta} (now ${current.byConfidence.low} this window). Each one is a hint that your knowledge base has gaps.`,
    );
  }

  if (derived.positiveRateDelta !== null && derived.positiveRateDelta <= -0.05) {
    const before = pct(previous.reactions.positiveRate);
    const now = pct(current.reactions.positiveRate);
    out.push(
      `Positive feedback fell from ${before} to ${now}. The negative reactions are the most actionable signal — open them first.`,
    );
  }

  if (
    current.reactions.totalNegative > current.reactions.totalPositive &&
    current.reactions.totalNegative >= 3
  ) {
    out.push(
      `${current.reactions.totalNegative} negative reactions vs ${current.reactions.totalPositive} positive. Worth a look — what changed?`,
    );
  }

  if (derived.hasPriorWindow && derived.responsesDelta <= -10) {
    out.push(
      `Volume is down by ${Math.abs(derived.responsesDelta)} responses. If your team stopped asking, find out why.`,
    );
  }

  if (
    derived.highConfidenceRate !== null &&
    derived.highConfidenceRate < 0.5 &&
    current.totalResponses >= 5
  ) {
    const lowAndMed = current.byConfidence.low + current.byConfidence.medium;
    out.push(
      `${lowAndMed} of ${current.totalResponses} responses were medium- or low-confidence. Open the threads to see where the knowledge base needs more material.`,
    );
  }

  return out;
}

function computeSuggestions(
  current: UsageStats,
  previous: UsageStats,
  derived: InsightsReport["derived"],
): Suggestion[] {
  const out: Suggestion[] = [];

  // Empty space: single most important CTA
  if (current.totalResponses === 0) {
    out.push({
      headline: "Get your team using Dosu",
      detail:
        "No responses logged yet. The fastest unlock is wiring Dosu into the tools your team already uses — ask Dosu in Slack, your editor, or anywhere else.",
      command: "dosu setup",
    });
    out.push({
      headline: "Connect a knowledge source",
      detail:
        "Dosu is only as good as what it can read. Add at least one source so it has material to draw from.",
      command: "dosu integrations",
    });
    return out;
  }

  const lowDelta = current.byConfidence.low - previous.byConfidence.low;
  const lowGrewSignificantly = derived.hasPriorWindow && lowDelta >= 5;
  const lowHighInAbsoluteTerms =
    current.byConfidence.low >= Math.max(5, current.totalResponses * 0.3);
  if (lowGrewSignificantly || lowHighInAbsoluteTerms) {
    out.push({
      headline: "Audit recent low-confidence answers",
      detail: `${current.byConfidence.low} answers had low confidence this window${
        lowGrewSignificantly ? ` (+${lowDelta} vs prior)` : ""
      }. Open them to see exactly what knowledge is missing.`,
      command: "dosu threads list",
    });
  }

  // Positive rate dropping
  if (derived.positiveRateDelta !== null && derived.positiveRateDelta <= -0.05) {
    out.push({
      headline: "Refresh your sources",
      detail:
        "Positive feedback is trending down. Usually a stale doc, a moved page, or a new product area Dosu hasn't seen.",
      command: "dosu sources list",
    });
  }

  if (
    current.totalResponses >= 50 &&
    derived.highConfidenceRate !== null &&
    derived.highConfidenceRate >= 0.7 &&
    out.length === 0
  ) {
    out.push({
      headline: "Share the win with your team",
      detail: `${current.byConfidence.high} of ${current.totalResponses} responses landed with high confidence (${pct(
        derived.highConfidenceRate,
      )}). People are getting unblocked — make sure your team knows it's working.`,
    });
  }

  if (derived.hasPriorWindow && derived.responsesDelta >= 10) {
    out.push({
      headline: "Ride the momentum — add another source",
      detail: `Volume is up by ${derived.responsesDelta} responses vs the prior window. Connect another source while engagement is high.`,
      command: "dosu integrations",
    });
  }

  // Always-available fallback so we never ship an empty list
  if (out.length === 0) {
    out.push({
      headline: "Connect more knowledge sources",
      detail:
        "Each new source expands what Dosu can answer. Even a single new repo or doc set typically lifts high-confidence share.",
      command: "dosu integrations",
    });
  }

  // Cap at 4 to keep the report scannable
  return out.slice(0, 4);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function statsBlock(stats: UsageStats, derived: InsightsReport["derived"]): string {
  const hc = derived.highConfidenceRate !== null ? pct(derived.highConfidenceRate) : "n/a";
  const pr =
    stats.reactions.totalPositive + stats.reactions.totalNegative > 0
      ? pct(stats.reactions.positiveRate)
      : "n/a";
  return [
    `- ${stats.totalResponses} total responses`,
    `- Confidence: ${stats.byConfidence.high} high, ${stats.byConfidence.medium} medium, ${stats.byConfidence.low} low (${hc} high-confidence share)`,
    `- Reactions: ${stats.reactions.totalPositive} positive, ${stats.reactions.totalNegative} negative (${pr} positive rate)`,
  ].join("\n");
}

export function buildAtAGlancePrompt(
  stats: UsageStats,
  derived: InsightsReport["derived"],
  days: number,
): string {
  const priorNote = derived.hasPriorWindow
    ? ""
    : `\n\nNote: this is the space's first ${days}-day window, so do NOT compare to a prior period. Focus on what's present.`;
  return `You're writing the "At a Glance" panel for a Dosu space insights report. Here are the real stats from the last ${days} days:

${statsBlock(stats, derived)}${priorNote}

Write 2-3 short sentences (no bullets, no headers, no markdown) that synthesize what's interesting or worth celebrating. Be warm, specific, and a little fun. Don't just list the numbers — interpret them. Speak directly to the reader ("you" / "your team").`;
}

export function fallbackAtAGlance(
  stats: UsageStats,
  derived: InsightsReport["derived"],
  days: number,
): string {
  if (stats.totalResponses === 0) {
    return `Your space is brand new. The next ${days} days will give us something to talk about, so let's see what your team asks first.`;
  }
  const hc = derived.highConfidenceRate !== null ? pct(derived.highConfidenceRate) : "—";
  const reactions = stats.reactions.totalPositive + stats.reactions.totalNegative;
  const pr = reactions > 0 ? `, with ${pct(stats.reactions.positiveRate)} positive feedback` : "";
  if (!derived.hasPriorWindow) {
    return `In your first ${days}-day window you logged ${stats.totalResponses} responses, ${hc} of them high-confidence${pr}. Check back after another ${days} days for trend comparisons.`;
  }
  const trend =
    derived.responsesDelta > 0
      ? ` Volume is up ${derived.responsesDelta} vs the prior ${days} days — the team is leaning on Dosu more.`
      : derived.responsesDelta < 0
        ? ` Volume is down ${Math.abs(derived.responsesDelta)} vs the prior ${days} days — worth a quick look.`
        : "";
  return `In the last ${days} days you logged ${stats.totalResponses} responses, ${hc} of them high-confidence${pr}.${trend}`;
}
