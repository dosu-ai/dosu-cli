/**
 * Render an InsightsReport as a self-contained HTML file.
 *
 * Embeds all CSS inline so the file is portable. No external assets, no JS.
 * Visually inspired by Claude Code's `/insights` report but only renders
 * sections we can populate with real data.
 */

import type { InsightsReport, UsageStats } from "./insights";

export function renderHTML(report: InsightsReport): string {
  const safeName = escapeHTML(report.deploymentName);
  const generated = formatDate(report.generatedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Dosu Insights — ${safeName}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${CSS}</style>
</head>
<body>
  <main class="container">
    <header class="hero">
      <div class="brand">DOSU INSIGHTS</div>
      <h1>${safeName}</h1>
      <p class="subtitle">Last ${report.windowDays} days · generated ${generated}</p>
    </header>

    ${renderAtAGlance(report)}
    ${renderStatsRow(report)}
    ${renderCheers(report)}
    ${renderCharts(report.current)}
    ${renderTopics(report)}
    ${renderSuggestions(report)}
    ${renderTrend(report)}

    <footer class="fun-ending">
      <div class="fun-headline">${pickFlair(report)}</div>
      <div class="fun-detail">Run <code>dosu insights</code> any time to see what's new. ✨</div>
    </footer>
  </main>
</body>
</html>`;
}

function renderAtAGlance(r: InsightsReport): string {
  const text = r.narratives.atAGlance ?? fallbackAtAGlance(r);
  return `
    <section class="at-a-glance">
      <div class="glance-title">At a Glance</div>
      <p>${escapeHTML(text)}</p>
    </section>`;
}

function renderStatsRow(r: InsightsReport): string {
  const ar = r.derived.answerRate !== null ? `${(r.derived.answerRate * 100).toFixed(0)}%` : "—";
  const arDelta = formatDelta(r.derived.answerRateDelta, true);
  const pr =
    r.current.reactions.totalPositive + r.current.reactions.totalNegative > 0
      ? `${(r.current.reactions.positiveRate * 100).toFixed(0)}%`
      : "—";
  const prDelta = formatDelta(r.derived.positiveRateDelta, true);
  const respDelta = formatDelta(
    r.derived.responsesDelta / Math.max(1, r.previous.totalResponses),
    true,
  );
  return `
    <section class="stats-row">
      <div class="stat">
        <div class="stat-value">${r.current.totalResponses}</div>
        <div class="stat-label">Responses</div>
        <div class="stat-delta">${respDelta}</div>
      </div>
      <div class="stat">
        <div class="stat-value">${ar}</div>
        <div class="stat-label">Answer rate</div>
        <div class="stat-delta">${arDelta}</div>
      </div>
      <div class="stat">
        <div class="stat-value">${pr}</div>
        <div class="stat-label">Positive feedback</div>
        <div class="stat-delta">${prDelta}</div>
      </div>
      <div class="stat">
        <div class="stat-value">${r.windowDays}</div>
        <div class="stat-label">Days</div>
        <div class="stat-delta">&nbsp;</div>
      </div>
    </section>`;
}

function renderCheers(r: InsightsReport): string {
  const items = r.cheers.map((c) => `<li>${escapeHTML(c)}</li>`).join("");
  return `
    <section>
      <h2>Worth Celebrating</h2>
      <ul class="cheers">${items}</ul>
    </section>`;
}

function renderCharts(stats: UsageStats): string {
  return `
    <section class="charts">
      <div class="chart-card">
        <div class="chart-title">Confidence Breakdown</div>
        ${barChart([
          ["High", stats.byConfidence.high, "#16a34a"],
          ["Medium", stats.byConfidence.medium, "#eab308"],
          ["Low", stats.byConfidence.low, "#dc2626"],
        ])}
      </div>
      <div class="chart-card">
        <div class="chart-title">Reactions</div>
        ${barChart([
          ["Positive", stats.reactions.totalPositive, "#16a34a"],
          ["Negative", stats.reactions.totalNegative, "#dc2626"],
        ])}
      </div>
    </section>`;
}

function renderTopics(r: InsightsReport): string {
  const text =
    r.narratives.topics ??
    "Not enough signal yet to summarize topics — try again after more questions roll in.";
  return `
    <section>
      <h2>What People Are Asking About</h2>
      <div class="narrative">${escapeHTML(text)}</div>
    </section>`;
}

function renderSuggestions(r: InsightsReport): string {
  if (!r.narratives.suggestions) {
    return `
    <section>
      <h2>Suggested Next Steps</h2>
      <div class="narrative muted">No suggestions this round — Dosu was too busy answering questions. 😄</div>
    </section>`;
  }
  // Render as preformatted-ish so numbered lists keep their shape; still escaped.
  return `
    <section>
      <h2>Suggested Next Steps</h2>
      <div class="narrative suggestions">${escapeHTML(r.narratives.suggestions)}</div>
    </section>`;
}

function renderTrend(r: InsightsReport): string {
  const cur = r.current.totalResponses;
  const prev = r.previous.totalResponses;
  const delta = cur - prev;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  return `
    <section>
      <h2>Trend</h2>
      <div class="trend trend-${dir}">
        <span class="trend-arrow">${arrow}</span>
        <span><strong>${cur}</strong> responses this window vs <strong>${prev}</strong> the prior ${r.windowDays} days
        (${delta >= 0 ? "+" : ""}${delta}).</span>
      </div>
    </section>`;
}

function fallbackAtAGlance(r: InsightsReport): string {
  if (r.current.totalResponses === 0) {
    return `Your deployment is brand new and ready to go. The next ${r.windowDays} days will give us something to talk about — let's see what your team asks first.`;
  }
  const ar = r.derived.answerRate !== null ? `${(r.derived.answerRate * 100).toFixed(0)}%` : "—";
  return `In the last ${r.windowDays} days you logged ${r.current.totalResponses} responses with a ${ar} answer rate. Keep the questions coming — every one teaches Dosu more about your team.`;
}

function pickFlair(r: InsightsReport): string {
  if (r.current.totalResponses === 0) return "🌱 Day one. Welcome aboard.";
  if (r.current.totalResponses >= 1000)
    return "🚀 You crossed 1,000 responses. That's a lot of help shipped.";
  if (r.current.totalResponses >= 100) return "🎉 Triple digits. Your team is on a roll.";
  if (r.derived.answerRate !== null && r.derived.answerRate >= 0.95)
    return "💯 Almost everything got answered. Chef's kiss.";
  return "👏 Keep the questions coming.";
}

function barChart(rows: Array<[string, number, string]>): string {
  const max = Math.max(1, ...rows.map(([, v]) => v));
  return rows
    .map(
      ([label, value, color]) => `
        <div class="bar-row">
          <div class="bar-label">${escapeHTML(label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%;background:${color}"></div></div>
          <div class="bar-value">${value}</div>
        </div>`,
    )
    .join("");
}

function formatDelta(delta: number | null, asPercent: boolean): string {
  if (delta === null || !Number.isFinite(delta)) return "&nbsp;";
  if (Math.abs(delta) < 0.005 && asPercent) return "no change";
  if (asPercent) {
    const pct = (delta * 100).toFixed(0);
    return delta > 0 ? `▲ ${pct} pts` : `▼ ${Math.abs(Number(pct))} pts`;
  }
  return delta > 0 ? `▲ ${delta}` : `▼ ${Math.abs(delta)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; background: #f8fafc; color: #334155; line-height: 1.6; padding: 48px 24px; }
.container { max-width: 820px; margin: 0 auto; }
.hero { margin-bottom: 32px; }
.brand { font-size: 11px; letter-spacing: 0.18em; color: #b45309; font-weight: 700; margin-bottom: 8px; }
h1 { font-size: 32px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
h2 { font-size: 18px; font-weight: 600; color: #0f172a; margin-top: 40px; margin-bottom: 12px; }
.subtitle { color: #64748b; font-size: 14px; }
.at-a-glance { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #f59e0b; border-radius: 12px; padding: 20px 24px; margin-top: 32px; }
.glance-title { font-size: 11px; letter-spacing: 0.18em; font-weight: 700; color: #92400e; margin-bottom: 10px; }
.at-a-glance p { color: #78350f; font-size: 15px; line-height: 1.7; }
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 24px 0 8px; padding: 20px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
.stat { text-align: center; }
.stat-value { font-size: 26px; font-weight: 700; color: #0f172a; }
.stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
.stat-delta { font-size: 11px; color: #64748b; margin-top: 4px; }
.cheers { list-style: none; display: grid; gap: 8px; }
.cheers li { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; border-radius: 8px; padding: 12px 16px; font-size: 14px; }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
.chart-title { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }
.bar-row { display: flex; align-items: center; margin-bottom: 6px; }
.bar-label { width: 70px; font-size: 12px; color: #475569; }
.bar-track { flex: 1; height: 6px; background: #f1f5f9; border-radius: 3px; margin: 0 8px; }
.bar-fill { height: 100%; border-radius: 3px; }
.bar-value { width: 36px; font-size: 12px; font-weight: 500; color: #475569; text-align: right; }
.narrative { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; font-size: 14px; line-height: 1.7; color: #475569; white-space: pre-wrap; }
.narrative.muted { color: #94a3b8; }
.suggestions { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
.trend { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; font-size: 14px; color: #1e40af; display: flex; align-items: center; gap: 12px; }
.trend-up { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
.trend-down { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.trend-arrow { font-size: 18px; font-weight: 700; }
.fun-ending { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 1px solid #fbbf24; border-radius: 12px; padding: 24px; margin-top: 40px; text-align: center; }
.fun-headline { font-size: 18px; font-weight: 600; color: #78350f; margin-bottom: 6px; }
.fun-detail { font-size: 14px; color: #92400e; }
.fun-detail code { background: rgba(255,255,255,0.7); padding: 2px 6px; border-radius: 4px; font-family: ui-monospace, monospace; font-size: 13px; }
@media (max-width: 640px) { .stats-row { grid-template-columns: repeat(2, 1fr); } .charts { grid-template-columns: 1fr; } }
`;
