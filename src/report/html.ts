/** The memory report as one self-contained HTML page. Each function mirrors a component of the
 * web app's memory pages (components/memories/*) — same sections, wording and badge variants —
 * and links into them, so a session here reads like its session page, many sessions at once. */

import { REPORT_CSS } from "./css";
import { sessionTime } from "./model";
import type {
  EpisodeKind,
  MemoryKind,
  MemoryListItem,
  Report,
  ReportMemory,
  ReportSession,
  SourceEffect,
  TaskOutcome,
  TraceDetail,
} from "./types";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plural(count: number, one: string, other = `${one}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : other}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

type BadgeVariant =
  | "default"
  | "neutral"
  | "faint"
  | "accent"
  | "highlight"
  | "success"
  | "warning"
  | "error";

function badge(label: string, variant: BadgeVariant = "default", title?: string): string {
  const cls = variant === "default" ? "badge" : `badge ${variant}`;
  return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</span>`;
}

// MemoryKindBadge.tsx
const KIND: Record<MemoryKind, [string, BadgeVariant]> = {
  semantic: ["Semantic", "accent"],
  procedural: ["Procedural", "highlight"],
  episodic: ["Episodic", "neutral"],
};
const EPISODE_KIND: Record<EpisodeKind, string> = {
  hard_won_context: "Hard-won context",
  human_feedback: "Human feedback",
  mistake: "Mistake",
};
const EFFECT: Record<SourceEffect, string> = {
  created: "Created",
  updated: "Updated",
  confirmed: "Confirmed",
  contradicted: "Contradicted",
};
const OUTCOME: Record<TaskOutcome, [string, BadgeVariant]> = {
  success: ["Success", "success"],
  partial: ["Partial", "warning"],
  failed: ["Failed", "error"],
  abandoned: ["Abandoned", "neutral"],
};

function effectBadge(effect: SourceEffect): string {
  return badge(EFFECT[effect], effect === "contradicted" ? "warning" : "faint");
}

// ScopeChips.tsx
function scopeChips(item: { repo: string | null; branch: string | null; agent: string | null }) {
  const chips = [item.repo, item.branch, item.agent]
    .filter((value): value is string => Boolean(value))
    .map((value) => badge(value, "faint", value));
  return chips.length > 0 ? `<span class="row">${chips.join("")}</span>` : "";
}

function memoryHref(appUrl: string, item: MemoryListItem): string {
  const id = encodeURIComponent(item.id);
  return item.kind === "episodic"
    ? `${appUrl}/memories/episodes/${id}`
    : `${appUrl}/memories/${id}`;
}

// MemoryCard.tsx, plus how many of the report's sessions touched the memory.
function memoryCard(
  appUrl: string,
  item: MemoryListItem,
  effects: readonly SourceEffect[] = [],
  sessionCount = 0,
): string {
  const title = item.redacted
    ? `<span class="tombstone">Redacted by the submitter</span>`
    : `<span class="card-title" title="${esc(item.title)}">${esc(item.title)}</span>`;
  const badges = [
    badge(...KIND[item.kind]),
    item.episode_kind
      ? badge(
          EPISODE_KIND[item.episode_kind],
          item.episode_kind === "mistake" ? "error" : "neutral",
        )
      : "",
    ...effects.map(effectBadge),
    item.active ? "" : badge("Invalidated", "error"),
  ].join("");
  const footer = [
    scopeChips(item),
    item.source_count !== null
      ? `<span class="nums">${plural(item.source_count, "episode")}</span>`
      : "",
    item.kind !== "episodic"
      ? `<span class="nums">${plural(item.retrieval_count, "retrieval")}</span>`
      : "",
    sessionCount > 1 ? badge(plural(sessionCount, "session"), "neutral") : "",
    `<span class="push nums">${esc(new Date(item.updated_at).toLocaleDateString("en-US"))}</span>`,
  ].join("");
  return `<a class="card" href="${esc(memoryHref(appUrl, item))}">
  <span class="row">${title}<span class="row">${badges}</span></span>
  ${!item.redacted && item.snippet ? `<p class="snippet">${esc(item.snippet)}</p>` : ""}
  <span class="row xs faint">${footer}</span>
</a>`;
}

function metaRow(label: string, value: string, href?: string): string {
  const shown = href ? `<a class="link" href="${esc(href)}">${esc(value)}</a>` : esc(value);
  return `<div><dt>${esc(label)}</dt><dd title="${esc(value)}">${shown}</dd></div>`;
}

// TraceLineageView.tsx
function traceLineage(appUrl: string, detail: TraceDetail): string {
  const { trace, status, tasks, episodes, memories } = detail;
  const sessionHref = trace.session_id
    ? `${appUrl}/memories/sessions/${encodeURIComponent(trace.session_id)}`
    : undefined;
  const progress =
    status === "processing"
      ? `<p class="divided strong">Dosu is reading this session…</p>`
      : `<p class="divided row xs faint"><span class="strong">Processed ${esc(formatDate(trace.processed_at))}</span>
  <span class="nums">${plural(tasks.length, "task")}</span>
  <span class="nums">${plural(episodes.length, "episode")}</span>
  <span class="nums">${plural(memories.length, "memory", "memories")}</span></p>`;
  const header = `<div class="card stack">
  <div class="row">${badge(trace.source, "neutral")}${scopeChips(trace)}
    <a class="link push" href="${esc(`${appUrl}/memories/traces/${encodeURIComponent(trace.id)}`)}">View trace</a></div>
  <dl class="meta">
    ${metaRow("Session", trace.session_id ?? "—", sessionHref)}
    ${metaRow("Events", trace.event_count.toLocaleString("en-US"))}
    ${metaRow("Started", formatDate(trace.started_at))}
    ${metaRow("Ended", formatDate(trace.ended_at))}
  </dl>
  ${progress}
</div>`;
  const taskCards = tasks
    .map(
      (task) => `<div class="card stack">
  <div class="row xs faint"><span class="nums">#${task.ordinal}</span>${badge(...OUTCOME[task.outcome])}
    <span class="nums">Events ${task.event_start}–${task.event_end}</span></div>
  ${task.task_text ? `<p>${esc(task.task_text)}</p>` : ""}
  ${task.summary ? `<p class="xs faint">${esc(task.summary)}</p>` : ""}
</div>`,
    )
    .join("");
  const sections = [
    header,
    tasks.length > 0
      ? `<section><h2>Tasks</h2><div class="stack">${taskCards}</div></section>`
      : "",
    episodes.length > 0
      ? `<section><h2>Episodes captured</h2><div class="grid">${episodes
          .map((episode) => memoryCard(appUrl, episode))
          .join("")}</div></section>`
      : "",
    memories.length > 0
      ? `<section><h2>Memories touched</h2><div class="grid">${memories
          .map((m) => memoryCard(appUrl, m.item, m.effects))
          .join("")}</div></section>`
      : "",
    status === "complete" && tasks.length + episodes.length + memories.length === 0
      ? `<p class="faint">No tasks, episodes, or memories were captured from this trace.</p>`
      : "",
  ];
  return sections.filter(Boolean).join("\n");
}

const STATE: Record<ReportSession["state"], [string, BadgeVariant]> = {
  complete: ["Processed", "success"],
  processing: ["Processing", "warning"],
  waiting: ["Waiting", "faint"],
  private: ["Private", "faint"],
  error: ["Unavailable", "error"],
};

function sessionBody(appUrl: string, session: ReportSession): string {
  if (session.trace) return traceLineage(appUrl, session.trace);
  if (session.state === "private") {
    return `<div class="card stack"><p class="strong">This session report is private to whoever submitted it.</p>
  <p class="xs faint">Excerpts and memories distilled from it remain visible across the organization.</p></div>`;
  }
  if (session.state === "waiting") {
    return `<div class="card stack"><p class="strong">Waiting for this session to be ingested…</p>
  <p class="xs faint">Run the report again once Dosu has processed it.</p></div>`;
  }
  return `<div class="card"><p class="strong">Could not load this session${
    session.error ? ` (${esc(session.error)})` : ""
  }.</p></div>`;
}

// SessionView.tsx, collapsed to a summary row per session.
function sessionBlock(appUrl: string, session: ReportSession): string {
  const counts = session.trace
    ? `<span class="xs faint nums">${plural(session.trace.tasks.length, "task")} · ${plural(
        session.trace.episodes.length,
        "episode",
      )} · ${plural(session.trace.memories.length, "memory", "memories")}</span>`
    : "";
  const href = `${appUrl}/memories/sessions/${encodeURIComponent(session.sessionId)}`;
  return `<details class="session" data-session="${esc(session.sessionId)}">
<summary>${badge(session.harness, "neutral")}${badge(...STATE[session.state])}
  ${session.project ? `<span class="strong">${esc(session.project)}</span>` : ""}
  <span class="mono xs faint" title="${esc(session.sessionId)}">${esc(session.sessionId.slice(0, 12))}</span>
  ${counts}
  <span class="push xs faint">${esc(formatDate(sessionTime(session)))}</span>
  <a class="link" href="${esc(href)}">Open in Dosu</a></summary>
<div class="session-body">${sessionBody(appUrl, session)}</div>
</details>`;
}

function stat(key: string, label: string, value: number, detail: string): string {
  return `<div class="card stat" data-stat="${key}"><span class="xs faint">${esc(label)}</span>
  <span class="value">${value.toLocaleString("en-US")}</span><span class="xs faint">${esc(detail)}</span></div>`;
}

function crossSessionMemories(appUrl: string, memories: readonly ReportMemory[]): string {
  if (memories.length === 0) return "";
  return `<section id="memories"><h2>Memories touched</h2>
<p class="xs faint" style="margin-bottom:12px">What these sessions taught Dosu memory, most widely touched first.</p>
<div class="grid">${memories
    .map((m) => memoryCard(appUrl, m.item, m.effects, m.sessionIds.length))
    .join("")}</div></section>`;
}

export function buildReportHtml(report: Report): string {
  const { totals } = report;
  const changes = (["created", "updated", "confirmed", "contradicted"] as const)
    .filter((effect) => totals[effect] > 0)
    .map((effect) => `${totals[effect]} ${effect}`)
    .join(" · ");
  const body =
    report.sessions.length === 0
      ? `<div class="card stack"><p class="strong">No sessions shipped to Dosu memory in the last ${report.days} days.</p>
  <p class="xs faint">Finished agent sessions ship automatically; run <span class="mono">dosu knowledge sync</span> to send any that are waiting.</p></div>`
      : `<section class="stats">
  ${stat("sessions", "Sessions", totals.sessions, `${totals.processed} processed`)}
  ${stat("tasks", "Tasks", totals.tasks, "segmented from the transcripts")}
  ${stat("episodes", "Episodes captured", totals.episodes, "excerpts worth keeping")}
  ${stat("memories", "Memories touched", totals.memories, changes || "none yet")}
</section>
${crossSessionMemories(report.appUrl, report.memories)}
<section id="sessions"><h2>Sessions</h2>
${report.sessions.map((session) => sessionBlock(report.appUrl, session)).join("\n")}
</section>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dosu memory report — ${esc(report.orgName)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main class="wrap">
<header class="hero">
  <p class="eyebrow">Dosu memory report</p>
  <h1>What your agent sessions taught Dosu</h1>
  <p class="faint">${esc(report.orgName)} · last ${report.days} days · generated ${esc(formatDate(report.generatedAt))}</p>
  <div class="row toolbar"><button type="button" data-action="expand">Expand all sessions</button>
    <button type="button" onclick="window.print()">Print / PDF</button></div>
</header>
${body}
<footer>Sessions shipped from this machine. Open any card to see it in Dosu, where memories link to the evidence behind them.</footer>
</main>
<script>
  const sessions = () => document.querySelectorAll("details.session");
  document.querySelector('[data-action="expand"]').addEventListener("click", (event) => {
    const open = ![...sessions()].every((d) => d.open);
    sessions().forEach((d) => { d.open = open; });
    event.target.textContent = open ? "Collapse all sessions" : "Expand all sessions";
  });
  window.addEventListener("beforeprint", () => sessions().forEach((d) => { d.open = true; }));
</script>
</body>
</html>
`;
}
