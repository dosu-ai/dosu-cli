/**
 * Render an InsightsReport as a self-contained HTML file.
 *
 * Embeds all CSS inline so the file is portable. No external assets, no JS.
 * Visually inspired by Claude Code's `/insights` report — gradient panels,
 * card-based content, color-coded deltas, and an action-oriented suggestions
 * grid that calls out the exact `dosu` commands to run next.
 */

import type { InsightsReport, Suggestion, UsageStats } from "./insights";

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
    ${renderSignals(report)}
    ${renderSuggestions(report)}
    ${renderCharts(report.current)}
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
  return `
    <section class="at-a-glance">
      <div class="glance-title">At a Glance</div>
      <p>${escapeHTML(r.atAGlance)}</p>
    </section>`;
}

function renderStatsRow(r: InsightsReport): string {
  const ar = r.derived.answerRate !== null ? `${(r.derived.answerRate * 100).toFixed(0)}%` : "—";
  const arDelta = formatPctDelta(r.derived.answerRateDelta);
  const pr =
    r.current.reactions.totalPositive + r.current.reactions.totalNegative > 0
      ? `${(r.current.reactions.positiveRate * 100).toFixed(0)}%`
      : "—";
  const prDelta = formatPctDelta(r.derived.positiveRateDelta);
  const respDelta = formatCountDelta(r.derived.responsesDelta);
  return `
    <section class="stats-row">
      <div class="stat">
        <div class="stat-value">${r.current.totalResponses}</div>
        <div class="stat-label">Responses</div>
        ${respDelta}
      </div>
      <div class="stat">
        <div class="stat-value">${ar}</div>
        <div class="stat-label">Answer rate</div>
        ${arDelta}
      </div>
      <div class="stat">
        <div class="stat-value">${pr}</div>
        <div class="stat-label">Positive feedback</div>
        ${prDelta}
      </div>
      <div class="stat">
        <div class="stat-value">${r.windowDays}</div>
        <div class="stat-label">Days</div>
        <div class="stat-delta">&nbsp;</div>
      </div>
    </section>`;
}

function renderSignals(r: InsightsReport): string {
  if (r.cheers.length === 0 && r.investigate.length === 0) return "";
  return `
    <section class="signals">
      ${
        r.cheers.length > 0
          ? `<div class="signal-card signal-cheers">
        <h2><span class="signal-icon">✨</span> Worth Celebrating</h2>
        <ul>${r.cheers.map((c) => `<li>${escapeHTML(c)}</li>`).join("")}</ul>
      </div>`
          : ""
      }
      ${
        r.investigate.length > 0
          ? `<div class="signal-card signal-investigate">
        <h2><span class="signal-icon">🔎</span> Things to Investigate</h2>
        <ul>${r.investigate.map((c) => `<li>${escapeHTML(c)}</li>`).join("")}</ul>
      </div>`
          : ""
      }
    </section>`;
}

function renderSuggestions(r: InsightsReport): string {
  if (r.suggestions.length === 0) return "";
  return `
    <section>
      <h2 class="section-heading">Suggested Next Steps</h2>
      <p class="section-intro">Based on this window's activity. The fastest wins first.</p>
      <div class="suggestions">
        ${r.suggestions.map(renderSuggestionCard).join("")}
      </div>
    </section>`;
}

function renderSuggestionCard(s: Suggestion): string {
  const cmd = s.command
    ? `<div class="suggestion-cta"><code>$ ${escapeHTML(s.command)}</code></div>`
    : "";
  return `
    <article class="suggestion">
      <h3>${escapeHTML(s.headline)}</h3>
      <p>${escapeHTML(s.detail)}</p>
      ${cmd}
    </article>`;
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

function renderTrend(r: InsightsReport): string {
  const cur = r.current.totalResponses;
  const prev = r.previous.totalResponses;
  const delta = cur - prev;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  return `
    <section>
      <div class="trend trend-${dir}">
        <span class="trend-arrow">${arrow}</span>
        <span><strong>${cur}</strong> responses this window vs <strong>${prev}</strong> the prior ${r.windowDays} days
        (${delta >= 0 ? "+" : ""}${delta}).</span>
      </div>
    </section>`;
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

function formatPctDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return `<div class="stat-delta">&nbsp;</div>`;
  if (Math.abs(delta) < 0.005) return `<div class="stat-delta delta-flat">no change</div>`;
  const pct = Math.round(Math.abs(delta * 100));
  if (delta > 0) return `<div class="stat-delta delta-up">▲ ${pct} pts</div>`;
  return `<div class="stat-delta delta-down">▼ ${pct} pts</div>`;
}

function formatCountDelta(delta: number): string {
  if (delta === 0) return `<div class="stat-delta delta-flat">no change</div>`;
  if (delta > 0) return `<div class="stat-delta delta-up">▲ ${delta}</div>`;
  return `<div class="stat-delta delta-down">▼ ${Math.abs(delta)}</div>`;
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
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  background: #f8fafc;
  color: #334155;
  line-height: 1.6;
  padding: 56px 24px;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 880px; margin: 0 auto; }

/* Hero */
.hero { margin-bottom: 32px; }
.brand {
  font-size: 11px;
  letter-spacing: 0.18em;
  color: #b45309;
  font-weight: 700;
  margin-bottom: 8px;
}
h1 { font-size: 30px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
.subtitle { color: #64748b; font-size: 14px; }
.section-heading { font-size: 18px; font-weight: 600; color: #0f172a; margin-bottom: 4px; }
.section-intro { color: #64748b; font-size: 13px; margin-bottom: 16px; }

/* At-a-glance */
.at-a-glance {
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #f59e0b;
  border-radius: 12px;
  padding: 22px 26px;
  margin-top: 8px;
}
.glance-title {
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: 700;
  color: #92400e;
  margin-bottom: 10px;
}
.at-a-glance p { color: #78350f; font-size: 15px; line-height: 1.7; }

/* Stats row */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin: 32px 0 8px;
  padding: 20px 0;
  border-top: 1px solid #e2e8f0;
  border-bottom: 1px solid #e2e8f0;
}
.stat { text-align: center; }
.stat-value { font-size: 26px; font-weight: 700; color: #0f172a; line-height: 1.1; }
.stat-label {
  font-size: 11px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 6px;
}
.stat-delta { font-size: 11px; color: #64748b; margin-top: 6px; font-weight: 500; }
.delta-up { color: #16a34a; }
.delta-down { color: #dc2626; }
.delta-flat { color: #94a3b8; }

/* Signals (cheers + investigate side-by-side) */
.signals {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 32px;
}
.signals:has(.signal-card:only-child) { grid-template-columns: 1fr; }
.signal-card {
  border-radius: 10px;
  padding: 18px 20px;
  border: 1px solid;
}
.signal-card h2 {
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.signal-icon { font-size: 16px; }
.signal-card ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.signal-card li {
  font-size: 14px;
  line-height: 1.55;
  padding-left: 16px;
  position: relative;
}
.signal-card li::before {
  content: "•";
  position: absolute;
  left: 0;
  font-weight: 700;
  opacity: 0.6;
}
.signal-cheers {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.signal-cheers h2, .signal-cheers li { color: #166534; }
.signal-investigate {
  background: #fef2f2;
  border-color: #fecaca;
}
.signal-investigate h2, .signal-investigate li { color: #991b1b; }

/* Suggestions */
section { margin-top: 36px; }
.suggestions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
.suggestion {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.suggestion h3 { font-size: 15px; font-weight: 600; color: #0f172a; }
.suggestion p { font-size: 13px; color: #475569; line-height: 1.55; flex: 1; }
.suggestion-cta { margin-top: 4px; }
.suggestion-cta code {
  display: inline-block;
  background: #0f172a;
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  letter-spacing: 0.01em;
}

/* Charts */
.charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.chart-card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 18px;
}
.chart-title {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 12px;
}
.bar-row { display: flex; align-items: center; margin-bottom: 8px; }
.bar-row:last-child { margin-bottom: 0; }
.bar-label { width: 80px; font-size: 12px; color: #475569; }
.bar-track { flex: 1; height: 8px; background: #f1f5f9; border-radius: 4px; margin: 0 10px; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s ease; }
.bar-value { width: 36px; font-size: 12px; font-weight: 600; color: #475569; text-align: right; }

/* Trend */
.trend {
  border-radius: 10px;
  padding: 14px 18px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 14px;
  border: 1px solid;
}
.trend-up { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
.trend-down { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
.trend-flat { background: #f1f5f9; border-color: #cbd5e1; color: #475569; }
.trend-arrow { font-size: 22px; font-weight: 700; line-height: 1; }

/* Fun ending */
.fun-ending {
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #fbbf24;
  border-radius: 12px;
  padding: 26px;
  margin-top: 40px;
  text-align: center;
}
.fun-headline { font-size: 18px; font-weight: 600; color: #78350f; margin-bottom: 6px; }
.fun-detail { font-size: 14px; color: #92400e; }
.fun-detail code {
  background: rgba(255,255,255,0.7);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

/* Responsive */
@media (max-width: 720px) {
  body { padding: 32px 16px; }
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .signals { grid-template-columns: 1fr; }
  .suggestions { grid-template-columns: 1fr; }
  .charts { grid-template-columns: 1fr; }
}
@media (prefers-color-scheme: dark) {
  body { background: #0b1220; color: #cbd5e1; }
  h1, .stat-value, .section-heading { color: #f1f5f9; }
  .subtitle, .section-intro, .stat-label, .chart-title { color: #94a3b8; }
  .stats-row { border-color: #1e293b; }
  .suggestion, .chart-card { background: #111827; border-color: #1e293b; }
  .suggestion h3 { color: #f1f5f9; }
  .suggestion p { color: #94a3b8; }
  .bar-track { background: #1e293b; }
  .bar-label, .bar-value { color: #cbd5e1; }
  .signal-cheers { background: rgba(22,163,74,0.08); border-color: rgba(22,163,74,0.35); }
  .signal-cheers h2, .signal-cheers li { color: #86efac; }
  .signal-investigate { background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.35); }
  .signal-investigate h2, .signal-investigate li { color: #fca5a5; }
  .trend-up { background: rgba(22,163,74,0.08); border-color: rgba(22,163,74,0.35); color: #86efac; }
  .trend-down { background: rgba(220,38,38,0.08); border-color: rgba(220,38,38,0.35); color: #fca5a5; }
  .trend-flat { background: #111827; border-color: #1e293b; color: #94a3b8; }
}
`;
