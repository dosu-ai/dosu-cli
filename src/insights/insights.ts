/**
 * Build an InsightsReport for the user's Dosu deployment.
 *
 * Combines hard numbers from `analytics.getUsageStats` with narrative prose
 * pulled from the Dosu `/ask` workflow. Each /ask call is independent — if one
 * fails or times out, the report still renders with the others.
 */

import type { TypedClient } from "../client/trpc";
import type { Config } from "../config/config";

export interface UsageStats {
  totalResponses: number;
  totalWithResponse: number;
  byConfidence: { high: number; medium: number; low: number };
  reactions: {
    totalPositive: number;
    totalNegative: number;
    messagesWithReactions: number;
    reactionRate: number;
    positiveRate: number;
  };
}

export interface InsightsNarratives {
  atAGlance: string | null;
  topics: string | null;
  suggestions: string | null;
}

export interface InsightsReport {
  generatedAt: string;
  windowDays: number;
  deploymentName: string;
  current: UsageStats;
  previous: UsageStats;
  derived: {
    answerRate: number | null;
    answerRateDelta: number | null;
    responsesDelta: number;
    positiveRateDelta: number | null;
  };
  narratives: InsightsNarratives;
  cheers: string[];
}

export type AskFn = (question: string) => Promise<string | null>;

export interface BuildInsightsArgs {
  client: TypedClient;
  cfg: Config;
  ask: AskFn;
  windowDays?: number;
  now?: () => Date;
}

const EMPTY_STATS: UsageStats = {
  totalResponses: 0,
  totalWithResponse: 0,
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
}: BuildInsightsArgs): Promise<InsightsReport> {
  if (!cfg.space_id) {
    throw new Error("space_id missing — run 'dosu setup' first");
  }
  const spaceId = cfg.space_id;

  const [currentRaw, combinedRaw] = await Promise.all([
    client.analytics.getUsageStats.query({ spaceId, days: windowDays }),
    client.analytics.getUsageStats.query({ spaceId, days: windowDays * 2 }),
  ]);

  const current = normalizeStats(currentRaw);
  const combined = normalizeStats(combinedRaw);
  const previous = subtractStats(combined, current);

  const derived = computeDerived(current, previous);
  const cheers = computeCheers(current, derived);

  const [atAGlance, topics, suggestions] = await Promise.all([
    ask(buildAtAGlancePrompt(current, derived, windowDays)),
    ask(buildTopicsPrompt(windowDays)),
    ask(buildSuggestionsPrompt(current, derived, windowDays)),
  ]);

  return {
    generatedAt: now().toISOString(),
    windowDays,
    deploymentName: cfg.deployment_name ?? "your deployment",
    current,
    previous,
    derived,
    narratives: { atAGlance, topics, suggestions },
    cheers,
  };
}

function normalizeStats(raw: UsageStats | null | undefined): UsageStats {
  if (!raw) return { ...EMPTY_STATS };
  return {
    totalResponses: raw.totalResponses ?? 0,
    totalWithResponse: raw.totalWithResponse ?? 0,
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
  const totalWithResponse = Math.max(0, combined.totalWithResponse - current.totalWithResponse);
  const positive = Math.max(0, combined.reactions.totalPositive - current.reactions.totalPositive);
  const negative = Math.max(0, combined.reactions.totalNegative - current.reactions.totalNegative);
  const reactionMsgs = Math.max(
    0,
    combined.reactions.messagesWithReactions - current.reactions.messagesWithReactions,
  );
  const totalReactions = positive + negative;
  return {
    totalResponses,
    totalWithResponse,
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
  const answerRate =
    current.totalResponses > 0 ? current.totalWithResponse / current.totalResponses : null;
  const prevAnswerRate =
    previous.totalResponses > 0 ? previous.totalWithResponse / previous.totalResponses : null;
  const answerRateDelta =
    answerRate !== null && prevAnswerRate !== null ? answerRate - prevAnswerRate : null;

  const positiveRateDelta =
    current.reactions.totalPositive + current.reactions.totalNegative > 0 &&
    previous.reactions.totalPositive + previous.reactions.totalNegative > 0
      ? current.reactions.positiveRate - previous.reactions.positiveRate
      : null;

  return {
    answerRate,
    answerRateDelta,
    responsesDelta: current.totalResponses - previous.totalResponses,
    positiveRateDelta,
  };
}

function computeCheers(stats: UsageStats, derived: InsightsReport["derived"]): string[] {
  const out: string[] = [];
  if (stats.totalResponses === 0) {
    out.push(
      "Your deployment is brand new and ready to roll. Share `dosu setup` with your team to start asking questions.",
    );
    return out;
  }
  if (derived.answerRate !== null && derived.answerRate >= 0.9) {
    out.push(
      `${pct(derived.answerRate)} answer rate — Dosu is finding answers for almost everything you throw at it.`,
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
  if (derived.responsesDelta > 0) {
    out.push(`Volume is up by ${derived.responsesDelta} responses vs the prior window. 📈`);
  }
  if (out.length === 0) {
    out.push(
      `${stats.totalResponses} responses logged this window — every one is a chance to learn what your team needs.`,
    );
  }
  return out;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function statsBlock(stats: UsageStats, derived: InsightsReport["derived"]): string {
  const ar = derived.answerRate !== null ? pct(derived.answerRate) : "n/a";
  const pr =
    stats.reactions.totalPositive + stats.reactions.totalNegative > 0
      ? pct(stats.reactions.positiveRate)
      : "n/a";
  return [
    `- ${stats.totalResponses} total responses`,
    `- ${stats.totalWithResponse} with answers (${ar} answer rate)`,
    `- Confidence: ${stats.byConfidence.high} high, ${stats.byConfidence.medium} medium, ${stats.byConfidence.low} low`,
    `- Reactions: ${stats.reactions.totalPositive} positive, ${stats.reactions.totalNegative} negative (${pr} positive rate)`,
  ].join("\n");
}

export function buildAtAGlancePrompt(
  stats: UsageStats,
  derived: InsightsReport["derived"],
  days: number,
): string {
  return `You're writing the "At a Glance" panel for a Dosu deployment insights report. Here are the real stats from the last ${days} days:

${statsBlock(stats, derived)}

Write 2-3 short sentences (no bullets, no headers, no markdown) that synthesize what's interesting or worth celebrating. Be warm, specific, and a little fun. Don't just list the numbers — interpret them. Speak directly to the reader ("you" / "your team").`;
}

export function buildTopicsPrompt(days: number): string {
  return `Looking at the questions and threads in this Dosu deployment over the last ${days} days, what are the most common topics or themes people have been asking about? Reply in 2-3 friendly sentences naming specific topic areas. No bullet points, no headers — plain prose. If you don't have enough signal yet, say so honestly in one sentence.`;
}

export function buildSuggestionsPrompt(
  stats: UsageStats,
  derived: InsightsReport["derived"],
  days: number,
): string {
  return `Given this Dosu deployment's activity over the last ${days} days:

${statsBlock(stats, derived)}

Suggest 2-3 concrete, specific things the team could do this week to get more value from Dosu. Format as a short numbered list with one sentence each. Be actionable, not generic.`;
}
