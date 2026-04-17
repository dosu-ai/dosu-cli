// Render an InsightsReport as a self-contained HTML file. All CSS inline, no
// JS, no external assets so the file is portable and shareable.

import type { InsightsReport, Suggestion, UsageStats } from "./insights";

export function renderHTML(report: InsightsReport): string {
  const safeName = escapeHTML(report.deploymentName);
  const generated = formatDate(report.generatedAt);

  const greeting = pickGreeting(report.generatedAt);

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
      <div class="brand">
        <span class="prompt">❯</span> dosu insights<span class="cursor">▌</span>
      </div>
      <h1>${safeName}</h1>
      <p class="subtitle">${greeting} · last ${report.windowDays} days · generated ${generated}</p>
    </header>

    ${renderHeadline(report)}
    ${renderAtAGlance(report)}
    ${renderScorecard(report)}
    ${renderStatsRow(report)}
    ${renderSignals(report)}
    ${renderSuggestions(report)}
    ${renderConfidenceBar(report.current)}
    ${renderReactions(report.current)}
    ${renderComparison(report)}
    ${renderTrend(report)}

    <footer class="fun-ending">
      <div class="fun-headline">${pickFlair(report)}</div>
      <div class="fun-detail">Run <code>dosu insights</code> any time to see what's new. ✨</div>
      <div class="fun-path">~/.config/dosu-cli/insights/latest.html</div>
    </footer>
  </main>
</body>
</html>`;
}

function pickGreeting(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Snapshot";
  const hour = d.getHours();
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  if (hour < 5) return `Late ${day} night`;
  if (hour < 12) return `${day} morning`;
  if (hour < 17) return `${day} afternoon`;
  if (hour < 21) return `${day} evening`;
  return `${day} night`;
}

function pickHeadlineLabel(count: number): string {
  if (count === 0) return "responses to come";
  if (count === 1) return "response logged";
  const variants = ["responses logged", "questions handled", "threads fielded"];
  return variants[count % variants.length];
}

function renderHeadline(r: InsightsReport): string {
  const cur = r.current.totalResponses;
  if (!r.derived.hasPriorWindow) {
    return `
    <section class="headline">
      <div class="headline-number">${cur.toLocaleString("en-US")}</div>
      <div class="headline-label">${pickHeadlineLabel(cur)}</div>
      <div class="headline-delta delta-flat">first ${r.windowDays} days of data</div>
    </section>`;
  }
  const delta = r.derived.responsesDelta;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "→";
  const pct = ` (${delta >= 0 ? "+" : ""}${Math.round((delta / r.previous.totalResponses) * 100)}%)`;
  const deltaText =
    delta === 0
      ? "no change vs the prior window"
      : `${arrow} ${delta >= 0 ? "+" : ""}${delta}${pct} vs the prior ${r.windowDays} days`;
  return `
    <section class="headline">
      <div class="headline-number">${cur.toLocaleString("en-US")}</div>
      <div class="headline-label">${pickHeadlineLabel(cur)}</div>
      <div class="headline-delta delta-${direction}">${deltaText}</div>
    </section>`;
}

function renderAtAGlance(r: InsightsReport): string {
  return `
    <section class="at-a-glance">
      <div class="glance-title">At a Glance</div>
      <p>${escapeHTML(r.atAGlance)}</p>
    </section>`;
}

function renderScorecard(r: InsightsReport): string {
  if (r.current.totalResponses === 0) return "";
  const answer = r.derived.answerRate ?? 0;
  const conf =
    r.current.totalWithResponse > 0 ? r.current.byConfidence.high / r.current.totalWithResponse : 0;
  const reactionTotal = r.current.reactions.totalPositive + r.current.reactions.totalNegative;
  const sentiment = reactionTotal > 0 ? r.current.reactions.positiveRate : 0.7; // neutral default
  const score = Math.round(((answer + conf + sentiment) / 3) * 100);
  const grade = pickGrade(score);

  return `
    <section class="scorecard">
      <div class="scorecard-grade grade-${grade.tone}">
        <div class="grade-letter">${grade.letter}</div>
        <div class="grade-label">${grade.label}</div>
        <div class="grade-score">${score} / 100</div>
      </div>
      <div class="scorecard-bars">
        ${miniBar("Answer rate", answer, "answers reaching the user")}
        ${miniBar("High-confidence", conf, "of answers Dosu was sure about")}
        ${miniBar(
          "Sentiment",
          sentiment,
          reactionTotal > 0 ? "of reactions were positive" : "no reactions yet — neutral default",
        )}
      </div>
    </section>`;
}

function miniBar(label: string, value: number, hint: string): string {
  const v = Math.max(0, Math.min(1, value));
  const tone = v >= 0.8 ? "good" : v >= 0.6 ? "ok" : "low";
  return `
        <div class="mini">
          <div class="mini-row">
            <span class="mini-label">${escapeHTML(label)}</span>
            <span class="mini-value">${(v * 100).toFixed(0)}%</span>
          </div>
          <div class="mini-track"><div class="mini-fill mini-${tone}" style="width:${v * 100}%"></div></div>
          <div class="mini-hint">${escapeHTML(hint)}</div>
        </div>`;
}

function pickGrade(score: number): { letter: string; label: string; tone: string } {
  if (score >= 90) return { letter: "A+", label: "Outstanding", tone: "great" };
  if (score >= 80) return { letter: "A", label: "Excellent", tone: "great" };
  if (score >= 70) return { letter: "B", label: "Healthy", tone: "good" };
  if (score >= 60) return { letter: "C", label: "Needs attention", tone: "warn" };
  return { letter: "D", label: "Investigate", tone: "alarm" };
}

function renderStatsRow(r: InsightsReport): string {
  const ar = r.derived.answerRate !== null ? `${(r.derived.answerRate * 100).toFixed(0)}%` : "—";
  const arDelta = formatPctDelta(r.derived.answerRateDelta);
  const pr =
    r.current.reactions.totalPositive + r.current.reactions.totalNegative > 0
      ? `${(r.current.reactions.positiveRate * 100).toFixed(0)}%`
      : "—";
  const prDelta = formatPctDelta(r.derived.positiveRateDelta);
  const respDelta = r.derived.hasPriorWindow
    ? formatCountDelta(r.derived.responsesDelta)
    : `<div class="stat-delta">&nbsp;</div>`;
  const perDay = r.current.totalResponses > 0 ? r.current.totalResponses / r.windowDays : 0;
  const perDayLabel = !r.derived.hasPriorWindow
    ? "—"
    : perDay >= 1
      ? perDay.toFixed(1)
      : perDay > 0
        ? perDay.toFixed(2)
        : "—";
  const perDayHint = r.derived.hasPriorWindow
    ? `avg over ${r.windowDays} days`
    : `needs ${r.windowDays}d of history`;
  const reactionTotal = r.current.reactions.totalPositive + r.current.reactions.totalNegative;
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
        <div class="stat-value">${perDayLabel}</div>
        <div class="stat-label">Responses / day</div>
        <div class="stat-delta">${perDayHint}</div>
      </div>
      <div class="stat">
        <div class="stat-value">${reactionTotal}</div>
        <div class="stat-label">Reactions</div>
        <div class="stat-delta">${r.current.reactions.totalPositive} 👍 · ${r.current.reactions.totalNegative} 👎</div>
      </div>
      <div class="stat">
        <div class="stat-value">${r.windowDays}</div>
        <div class="stat-label">Window</div>
        <div class="stat-delta">days</div>
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
        <h2>Worth Celebrating</h2>
        <ul>${r.cheers.map((c) => `<li>${escapeHTML(c)}</li>`).join("")}</ul>
      </div>`
          : ""
      }
      ${
        r.investigate.length > 0
          ? `<div class="signal-card signal-investigate">
        <h2>Things to Investigate</h2>
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
    ? `<div class="suggestion-cta"><code><span class="cta-prompt">❯</span> ${escapeHTML(s.command)}</code></div>`
    : "";
  return `
    <article class="suggestion">
      <h3>${escapeHTML(s.headline)}</h3>
      <p>${escapeHTML(s.detail)}</p>
      ${cmd}
    </article>`;
}

function renderConfidenceBar(stats: UsageStats): string {
  const total = stats.byConfidence.high + stats.byConfidence.medium + stats.byConfidence.low;
  if (total === 0) return "";
  const high = (stats.byConfidence.high / total) * 100;
  const med = (stats.byConfidence.medium / total) * 100;
  const low = (stats.byConfidence.low / total) * 100;
  return `
    <section>
      <h2 class="section-heading">Confidence Breakdown</h2>
      <p class="section-intro">How sure Dosu was about each answer.</p>
      <div class="stacked-bar-card">
        <div class="stacked-bar">
          <div class="stack-seg seg-high" style="width:${high}%" title="High confidence: ${stats.byConfidence.high}"></div>
          <div class="stack-seg seg-med" style="width:${med}%" title="Medium confidence: ${stats.byConfidence.medium}"></div>
          <div class="stack-seg seg-low" style="width:${low}%" title="Low confidence: ${stats.byConfidence.low}"></div>
        </div>
        <div class="stacked-legend">
          <div class="legend-item"><span class="legend-swatch swatch-high"></span><strong>${stats.byConfidence.high}</strong> high <span class="legend-pct">${high.toFixed(0)}%</span></div>
          <div class="legend-item"><span class="legend-swatch swatch-med"></span><strong>${stats.byConfidence.medium}</strong> medium <span class="legend-pct">${med.toFixed(0)}%</span></div>
          <div class="legend-item"><span class="legend-swatch swatch-low"></span><strong>${stats.byConfidence.low}</strong> low <span class="legend-pct">${low.toFixed(0)}%</span></div>
        </div>
      </div>
    </section>`;
}

function renderReactions(stats: UsageStats): string {
  const total = stats.reactions.totalPositive + stats.reactions.totalNegative;
  if (total === 0) {
    return `
    <section>
      <h2 class="section-heading">Reactions</h2>
      <div class="empty-card">No reactions logged yet — encourage your team to thumbs-up the answers that helped.</div>
    </section>`;
  }
  const pos = (stats.reactions.totalPositive / total) * 100;
  const neg = (stats.reactions.totalNegative / total) * 100;
  return `
    <section>
      <h2 class="section-heading">Reactions</h2>
      <p class="section-intro">${total} reactions across ${stats.reactions.messagesWithReactions} messages.</p>
      <div class="stacked-bar-card">
        <div class="stacked-bar">
          <div class="stack-seg seg-high" style="width:${pos}%" title="Positive: ${stats.reactions.totalPositive}"></div>
          <div class="stack-seg seg-low" style="width:${neg}%" title="Negative: ${stats.reactions.totalNegative}"></div>
        </div>
        <div class="stacked-legend">
          <div class="legend-item"><span class="legend-swatch swatch-high"></span><strong>${stats.reactions.totalPositive}</strong> positive <span class="legend-pct">${pos.toFixed(0)}%</span></div>
          <div class="legend-item"><span class="legend-swatch swatch-low"></span><strong>${stats.reactions.totalNegative}</strong> negative <span class="legend-pct">${neg.toFixed(0)}%</span></div>
        </div>
      </div>
    </section>`;
}

function renderComparison(r: InsightsReport): string {
  if (!r.derived.hasPriorWindow) {
    return `
    <section>
      <h2 class="section-heading">Period Comparison</h2>
      <div class="empty-card">Not enough history yet — check back after ${r.windowDays} more days for a prior-window comparison.</div>
    </section>`;
  }
  const rows: Array<{ label: string; cur: string; prev: string; delta: string; tone: string }> = [
    rowResp("Responses", r.current.totalResponses, r.previous.totalResponses, true),
    rowResp("Answers given", r.current.totalWithResponse, r.previous.totalWithResponse, true),
    rowPct(
      "Answer rate",
      r.derived.answerRate,
      r.previous.totalResponses > 0
        ? r.previous.totalWithResponse / r.previous.totalResponses
        : null,
    ),
    rowResp("High-confidence", r.current.byConfidence.high, r.previous.byConfidence.high, true),
    rowResp("Low-confidence", r.current.byConfidence.low, r.previous.byConfidence.low, false),
    rowResp(
      "Positive reactions",
      r.current.reactions.totalPositive,
      r.previous.reactions.totalPositive,
      true,
    ),
    rowResp(
      "Negative reactions",
      r.current.reactions.totalNegative,
      r.previous.reactions.totalNegative,
      false,
    ),
  ];
  return `
    <section>
      <h2 class="section-heading">Period Comparison</h2>
      <p class="section-intro">This window vs the prior ${r.windowDays} days.</p>
      <div class="compare-card">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th>This window</th>
              <th>Prior window</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr>
                <td>${escapeHTML(row.label)}</td>
                <td class="num">${row.cur}</td>
                <td class="num prior">${row.prev}</td>
                <td class="num delta-${row.tone}">${row.delta}</td>
              </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

function rowResp(
  label: string,
  cur: number,
  prev: number,
  upIsGood: boolean,
): { label: string; cur: string; prev: string; delta: string; tone: string } {
  const d = cur - prev;
  const tone = d === 0 ? "flat" : d > 0 === upIsGood ? "up" : "down";
  const arrow = d === 0 ? "→" : d > 0 ? "▲" : "▼";
  const delta = d === 0 ? "no change" : `${arrow} ${d > 0 ? "+" : ""}${d}`;
  return {
    label,
    cur: cur.toLocaleString("en-US"),
    prev: prev.toLocaleString("en-US"),
    delta,
    tone,
  };
}

function rowPct(
  label: string,
  cur: number | null,
  prev: number | null,
): { label: string; cur: string; prev: string; delta: string; tone: string } {
  const curStr = cur !== null ? `${(cur * 100).toFixed(0)}%` : "—";
  const prevStr = prev !== null ? `${(prev * 100).toFixed(0)}%` : "—";
  if (cur === null || prev === null)
    return { label, cur: curStr, prev: prevStr, delta: "—", tone: "flat" };
  const d = cur - prev;
  if (Math.abs(d) < 0.005)
    return { label, cur: curStr, prev: prevStr, delta: "no change", tone: "flat" };
  const pct = Math.round(Math.abs(d * 100));
  const arrow = d > 0 ? "▲" : "▼";
  return {
    label,
    cur: curStr,
    prev: prevStr,
    delta: `${arrow} ${pct} pts`,
    tone: d > 0 ? "up" : "down",
  };
}

function renderTrend(r: InsightsReport): string {
  if (!r.derived.hasPriorWindow) return "";
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
  background:
    radial-gradient(ellipse 900px 360px at 50% -120px, rgba(251, 191, 36, 0.18), transparent 70%),
    #f8fafc;
  color: #334155;
  line-height: 1.6;
  padding: 56px 24px 80px;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 920px; margin: 0 auto; }

/* Hero */
.hero { margin-bottom: 28px; }
.brand {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  color: #92400e;
  font-weight: 600;
  margin-bottom: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.brand .prompt { color: #f59e0b; font-weight: 700; }
.brand .cursor {
  display: inline-block;
  margin-left: 2px;
  color: #f59e0b;
  animation: blink 1.1s steps(2) infinite;
}
@keyframes blink { 50% { opacity: 0; } }
h1 { font-size: 32px; font-weight: 700; color: #0f172a; margin-bottom: 4px; letter-spacing: -0.01em; }
.subtitle { color: #64748b; font-size: 14px; }
.section-heading {
  font-size: 18px;
  font-weight: 600;
  color: #0f172a;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-intro { color: #64748b; font-size: 13px; margin-bottom: 16px; }
section { margin-top: 36px; }

/* Headline metric */
.headline {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 32px 24px;
  text-align: center;
  margin-top: 16px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.04);
}
.headline-number {
  font-size: 64px;
  font-weight: 800;
  color: #0f172a;
  line-height: 1;
  letter-spacing: -0.03em;
}
.headline-label {
  font-size: 13px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 10px;
}
.headline-delta {
  font-size: 14px;
  margin-top: 14px;
  font-weight: 500;
}

/* At-a-glance */
.at-a-glance {
  background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
  border: 1px solid #f59e0b;
  border-radius: 14px;
  padding: 24px 28px;
}
.glance-title {
  font-size: 11px;
  letter-spacing: 0.18em;
  font-weight: 700;
  color: #92400e;
  margin-bottom: 10px;
}
.at-a-glance p { color: #78350f; font-size: 15px; line-height: 1.7; }

/* Scorecard */
.scorecard {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 20px;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  padding: 24px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.04);
}
.scorecard-grade {
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.grade-letter { font-size: 56px; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
.grade-label { font-size: 13px; font-weight: 600; margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.grade-score { font-size: 12px; opacity: 0.7; margin-top: 4px; }
.grade-great { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.grade-good { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
.grade-warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
.grade-alarm { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.scorecard-bars {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
}
.mini-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.mini-label { font-size: 13px; font-weight: 600; color: #334155; }
.mini-value { font-size: 14px; font-weight: 700; color: #0f172a; font-variant-numeric: tabular-nums; }
.mini-track { height: 8px; background: #f1f5f9; border-radius: 4px; overflow: hidden; }
.mini-fill { height: 100%; border-radius: 4px; }
.mini-good { background: #16a34a; }
.mini-ok { background: #eab308; }
.mini-low { background: #dc2626; }
.mini-hint { font-size: 12px; color: #64748b; margin-top: 4px; }

/* Stats row */
.stats-row {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  padding: 22px 0;
  border-top: 1px solid #e2e8f0;
  border-bottom: 1px solid #e2e8f0;
}
.stat { text-align: center; }
.stat-value { font-size: 24px; font-weight: 700; color: #0f172a; line-height: 1.1; font-variant-numeric: tabular-nums; }
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

/* Signals */
.signals {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.signals:has(.signal-card:only-child) { grid-template-columns: 1fr; }
.signal-card {
  border-radius: 12px;
  padding: 20px 22px;
  border: 1px solid;
}
.signal-card h2 {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.signal-card ul { list-style: none; display: flex; flex-direction: column; gap: 10px; }
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
.signal-cheers { background: #f0fdf4; border-color: #bbf7d0; }
.signal-cheers h2, .signal-cheers li { color: #166534; }
.signal-investigate { background: #fef2f2; border-color: #fecaca; }
.signal-investigate h2, .signal-investigate li { color: #991b1b; }

/* Suggestions */
.suggestions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
.suggestion {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.suggestion:hover {
  transform: translateY(-2px);
  border-color: #fcd34d;
  box-shadow: 0 6px 18px rgba(245, 158, 11, 0.12);
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
  padding: 6px 12px;
  border-radius: 6px;
}
.cta-prompt { color: #fbbf24; font-weight: 700; margin-right: 4px; }

/* Stacked bars (confidence + reactions) */
.stacked-bar-card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 22px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.stacked-bar-card:hover {
  transform: translateY(-2px);
  border-color: #fcd34d;
  box-shadow: 0 6px 18px rgba(245, 158, 11, 0.12);
}
.stacked-bar {
  display: flex;
  height: 18px;
  border-radius: 6px;
  overflow: hidden;
  background: #f1f5f9;
  margin-bottom: 16px;
}
.stack-seg { height: 100%; transition: width 0.3s ease; }
.seg-high { background: #16a34a; }
.seg-med { background: #eab308; }
.seg-low { background: #dc2626; }
.stacked-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: #475569;
}
.legend-item { display: flex; align-items: center; gap: 6px; }
.legend-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.swatch-high { background: #16a34a; }
.swatch-med { background: #eab308; }
.swatch-low { background: #dc2626; }
.legend-pct { color: #94a3b8; font-variant-numeric: tabular-nums; }
.empty-card {
  background: white;
  border: 1px dashed #cbd5e1;
  border-radius: 12px;
  padding: 22px;
  color: #94a3b8;
  font-size: 14px;
  text-align: center;
}

/* Period comparison table */
.compare-card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 8px 4px;
  box-shadow: 0 1px 3px rgba(15,23,42,0.04);
  overflow-x: auto;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.compare-card:hover {
  transform: translateY(-2px);
  border-color: #fcd34d;
  box-shadow: 0 6px 18px rgba(245, 158, 11, 0.12);
}
.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.compare-table th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  font-weight: 600;
  padding: 12px 16px;
  border-bottom: 1px solid #e2e8f0;
}
.compare-table th.num, .compare-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.compare-table th:nth-child(2), .compare-table td:nth-child(2),
.compare-table th:nth-child(3), .compare-table td:nth-child(3),
.compare-table th:nth-child(4), .compare-table td:nth-child(4) { text-align: right; }
.compare-table td {
  padding: 12px 16px;
  border-bottom: 1px solid #f1f5f9;
  color: #334155;
}
.compare-table tr:last-child td { border-bottom: none; }
.compare-table td.prior { color: #94a3b8; }

/* Trend */
.trend {
  border-radius: 12px;
  padding: 16px 20px;
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
  border-radius: 14px;
  padding: 28px;
  margin-top: 44px;
  text-align: center;
}
.fun-headline { font-size: 18px; font-weight: 700; color: #78350f; margin-bottom: 6px; }
.fun-detail { font-size: 14px; color: #92400e; }
.fun-detail code {
  background: rgba(255,255,255,0.7);
  padding: 2px 8px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
.fun-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #b45309;
  margin-top: 14px;
  opacity: 0.7;
}
.headline {
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.headline:hover {
  border-color: #fcd34d;
  box-shadow: 0 6px 18px rgba(245, 158, 11, 0.12);
}
.scorecard {
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.scorecard:hover {
  border-color: #fcd34d;
  box-shadow: 0 6px 18px rgba(245, 158, 11, 0.12);
}
@media (prefers-reduced-motion: reduce) {
  .brand .cursor { animation: none; }
  .suggestion, .stacked-bar-card, .compare-card, .headline, .scorecard {
    transition: none;
  }
  .suggestion:hover, .stacked-bar-card:hover, .compare-card:hover { transform: none; }
}

/* Responsive */
@media (max-width: 840px) {
  .stats-row { grid-template-columns: repeat(3, 1fr); }
  .scorecard { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  body { padding: 32px 16px 60px; }
  h1 { font-size: 26px; }
  .headline-number { font-size: 52px; }
  .stats-row { grid-template-columns: repeat(2, 1fr); }
  .signals { grid-template-columns: 1fr; }
  .suggestions { grid-template-columns: 1fr; }
}
`;
