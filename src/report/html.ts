/**
 * Self-contained HTML harvest report — same document as dosu-skill
 * log-to-dosu-knowledge/scripts/generate_report.py.
 */

import { REPORT_CSS } from "./css";
import type {
  DigestTool,
  DigestTurn,
  ReportCandidate,
  ReportDigest,
  ReportInventory,
} from "./types";

const CHARS_PER_TOKEN = 4;
const MAX_TRACE_STEPS = 50;
const PREVIEW_CHARS = 80;
const SQL_DISPLAY = new Set(["execute_sql", "query_run", "list_tables"]);
const LOGS_DISPLAY = new Set(["query_logs"]);
const SKIP_TOOL_NAMES = new Set(["tool_result"]);
const TAG_RE = /<[^>]+>/g;
const WS_RE = /\s+/g;

export interface BuildReportOptions {
  inventory: ReportInventory;
  candidates?: ReportCandidate[];
  orgName?: string;
  repo?: string;
  branch?: string;
  summary?: string;
  dryRun?: boolean;
  generatedAt?: Date;
  digests?: Record<string, ReportDigest>;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtInt(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return Math.trunc(v).toLocaleString("en-US");
}

function applyStatusDefaults(candidates: ReportCandidate[], dryRun: boolean): ReportCandidate[] {
  const fallback = dryRun ? "proposed" : "written";
  const known = new Set(["written", "pending", "proposed", "already_in_library"]);
  return candidates.map((c) => {
    const current = (c.status ?? "").trim().toLowerCase();
    return { ...c, status: known.has(current) ? current : fallback };
  });
}

export function tokenTotalsFromCandidates(
  candidates: ReportCandidate[],
  inventory: ReportInventory,
): {
  baseline_tokens: number;
  replaced_baseline_tokens: number;
  read_knowledge_tokens: number;
  tokens_saved: number;
  pct_saved: number;
} | null {
  if (candidates.length === 0) return null;
  let replaced = 0;
  let hasRediscovery = false;
  let readCost = 0;
  for (const c of candidates) {
    const raw = c.approx_rediscovery_tokens;
    if (raw != null) {
      hasRediscovery = true;
      replaced += Math.max(0, Number(raw) || 0);
    }
    const blob = `${c.title ?? ""}\n${c.content ?? ""}`;
    readCost += Math.round(blob.length / CHARS_PER_TOKEN);
  }
  if (!hasRediscovery) return null;
  let baseline = inventory.totals?.learning_tokens ?? 0;
  if (!baseline) {
    baseline = inventory.transcripts.reduce((sum, t) => sum + (t.learning_tokens || 0), 0);
  }
  const saved = Math.max(0, replaced - readCost);
  const pct = baseline ? Math.round((1000 * saved) / baseline) / 10 : 0;
  return {
    baseline_tokens: baseline,
    replaced_baseline_tokens: replaced,
    read_knowledge_tokens: readCost,
    tokens_saved: saved,
    pct_saved: pct,
  };
}

function presentationCopy(c: ReportCandidate): [string, string] {
  const idea = (c.plain_english || "").trim() || (c.content || "").trim();
  const how = (c.how_found || "").trim();
  if (how) return [idea, how];
  const raw = c.approx_rediscovery_tokens ?? c.baseline_tokens;
  const n = raw == null ? 0 : Number(raw) || 0;
  const work = n
    ? `About ${n.toLocaleString("en-US")} tokens of reading, searching, and tracing in this session before the conclusion.`
    : "Investigation stretch was not measured.";
  return [idea, work];
}

export function parseLineSpec(spec: unknown): Set<number> {
  const out = new Set<number>();
  if (spec == null) return out;
  const raw = Array.isArray(spec) ? spec.map(String).join(",") : String(spec);
  if (!raw.trim()) return out;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [a, b] = trimmed.split("-", 2);
      let start = Number.parseInt(a.trim(), 10);
      let end = Number.parseInt(b.trim(), 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (end < start) [start, end] = [end, start];
      for (let i = start; i <= end; i++) out.add(i);
    } else {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

function expandDigestTurns(turns: DigestTurn[], spec: Set<number>): DigestTurn[] {
  if (turns.length === 0 || spec.size === 0) return [];
  const minLine = Math.min(...spec);
  const maxLine = Math.max(...spec);
  let start = minLine;
  for (const turn of turns) {
    const line = Number(turn.line) || 0;
    if (turn.role === "user" && line <= minLine) start = line;
  }
  return turns.filter((turn) => {
    const line = Number(turn.line) || 0;
    return start <= line && line <= maxLine;
  });
}

function collapsePreview(text: string, limit = PREVIEW_CHARS): string {
  const cleaned = (text || "").replace(TAG_RE, " ").replace(WS_RE, " ").trim();
  if (cleaned.length > limit) return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
  return cleaned;
}

function turnText(turn: DigestTurn): string {
  const texts = turn.text ?? [];
  if (typeof texts === "string") return texts;
  return texts.filter(Boolean).join(" ");
}

function innerToolName(tool: DigestTool): string {
  const name = String(tool.name ?? "");
  for (const key of ["toolName", "tool_name"] as const) {
    const val = tool[key];
    if (val) return String(val);
  }
  if (tool.knowledge?.tool) return String(tool.knowledge.tool);
  if (name.startsWith("mcp:")) return name.split(":", 2)[1] ?? name;
  if (name.startsWith("mcp__")) return name.split("__").at(-1) ?? name;
  return name;
}

function displayToolName(tool: DigestTool): string {
  const inner = innerToolName(tool);
  const wrapper = String(tool.name ?? "");
  if (inner === "GetMcpTools" || wrapper === "GetMcpTools") return "MCP schema";
  if (SQL_DISPLAY.has(inner)) return "SQL";
  if (LOGS_DISPLAY.has(inner)) return "Logs";
  return inner || wrapper || "tool";
}

function firstArgPreview(args: unknown, keys: string[]): string {
  if (typeof args !== "object" || args === null) return "";
  const row = args as Record<string, unknown>;
  for (const key of keys) {
    if (row[key]) {
      const pv = collapsePreview(String(row[key]));
      if (pv) return pv;
    }
  }
  return "";
}

function toolPreview(tool: DigestTool, text: string): string {
  const name = String(tool.name ?? "");
  const inner = innerToolName(tool);
  if (tool.path) {
    const raw = String(tool.path);
    const leaf = raw.includes("/") ? raw.split("/").at(-1) : raw;
    const pv = collapsePreview(leaf ?? "");
    if (pv) return pv;
  }
  if (tool.pattern) {
    const pv = collapsePreview(String(tool.pattern));
    if (pv) return pv;
  }
  if (tool.command_preview) {
    const pv = collapsePreview(String(tool.command_preview));
    if (pv) return pv;
  }
  if (tool.query) {
    const pv = collapsePreview(String(tool.query));
    if (pv) return pv;
  }
  if (tool.file_path) {
    const raw = String(tool.file_path);
    const leaf = raw.includes("/") ? raw.split("/").at(-1) : raw;
    const pv = collapsePreview(leaf ?? "");
    if (pv) return pv;
  }
  if (tool.prompt) {
    const pv = collapsePreview(String(tool.prompt));
    if (pv) return pv;
  }
  if (tool.knowledge) {
    const pv = firstArgPreview(tool.knowledge.arguments, ["query", "sql", "command"]);
    if (pv) return pv;
  }
  const fromArgs = firstArgPreview(tool.arguments, ["query", "sql", "command", "description"]);
  if (fromArgs) return fromArgs;
  const toolName = tool.toolName || tool.tool_name;
  if (toolName) {
    const combo = tool.server ? `${toolName} · ${tool.server}` : String(toolName);
    const pv = collapsePreview(combo);
    if (pv) return pv;
  }
  const fromText = collapsePreview(text);
  if (fromText) return fromText;
  if (name === "GetMcpTools" || inner === "GetMcpTools") return "Look up available MCP tools";
  if (name === "CallMcpTool") {
    const extra = toolName || (inner !== "CallMcpTool" ? inner : "");
    return extra ? `MCP call · ${extra}` : "MCP call";
  }
  return "No input recorded";
}

function classifyDigestTool(tool: DigestTool): string {
  const name = String(tool.name ?? "");
  const inner = innerToolName(tool);
  const canonical = inner || name;
  if (["Write", "Edit", "MultiEdit", "StrReplace", "Delete"].includes(canonical)) return "code";
  if (["TodoWrite", "update_plan", "SwitchMode"].includes(canonical)) return "planning";
  if (["write_knowledge", "finalize_session_knowledge"].includes(canonical)) return "other";
  return "context";
}

function usableTools(turn: DigestTurn): DigestTool[] {
  return (turn.tools ?? []).filter((tool) => !SKIP_TOOL_NAMES.has(String(tool.name ?? "")));
}

interface TraceStep {
  kind?: string;
  bucket?: string;
  label?: string;
  preview?: string;
  tokens?: number;
  omitted?: number;
}

function buildTraceSteps(turns: DigestTurn[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const turn of turns) {
    const role = turn.role ?? "";
    const est = Number(turn.est_tokens) || 0;
    const text = turnText(turn);
    const tools = usableTools(turn);
    if (role === "user") {
      if (!text) continue;
      steps.push({
        kind: "user",
        bucket: "other",
        label: "Question",
        preview: collapsePreview(text) || "No input recorded",
        tokens: est,
      });
      continue;
    }
    if (tools.length > 0) {
      const share = Math.trunc(est / tools.length);
      const remainder = est - share * tools.length;
      tools.forEach((tool, i) => {
        const bucket = classifyDigestTool(tool);
        const preview = toolPreview(tool, text);
        steps.push({
          kind: "tool",
          bucket,
          label: displayToolName(tool),
          preview: bucket === "code" ? `${preview} · implementation (not counted)` : preview,
          tokens: share + (i === 0 ? remainder : 0),
        });
      });
      continue;
    }
    if (text) {
      steps.push({
        kind: "reasoning",
        bucket: "other",
        label: "Reasoning",
        preview: collapsePreview(text),
        tokens: est,
      });
    }
  }
  return steps;
}

function capTraceSteps(steps: TraceStep[]): TraceStep[] {
  if (steps.length <= MAX_TRACE_STEPS) return steps;
  const omitted = steps.length - MAX_TRACE_STEPS;
  return [steps[0], { omitted }, ...steps.slice(-(MAX_TRACE_STEPS - 1))];
}

export function renderTraceHtml(
  candidate: ReportCandidate,
  digests: Record<string, ReportDigest> | undefined,
): string {
  const tid = String(candidate.transcript_id ?? "").trim();
  const digest = tid ? digests?.[tid] : undefined;
  if (!digest) return "";
  // No attributed investigation stretch means no trace: rendering the whole
  // session here would present a session-sized token count as if it were the
  // cost of learning this one note, which the report must never do.
  const spec = parseLineSpec(candidate.investigation_lines);
  if (spec.size === 0) return "";
  const turns = expandDigestTurns(digest.turns, spec);
  if (turns.length === 0) return "";
  const steps = buildTraceSteps(turns);
  if (steps.length === 0) return "";

  const learning = { context: 0, planning: 0, other: 0 };
  const toolCounts = new Map<string, number>();
  let reasoningN = 0;
  for (const step of steps) {
    const bucket = step.bucket;
    const tokens = Number(step.tokens) || 0;
    if (bucket === "context" || bucket === "planning" || bucket === "other") {
      learning[bucket] += tokens;
    }
    if (step.kind === "reasoning") reasoningN += 1;
    else if (step.kind === "tool" && bucket !== "code") {
      const label = String(step.label || "tool");
      toolCounts.set(label, (toolCounts.get(label) ?? 0) + 1);
    }
  }
  const learningTotal = learning.context + learning.planning + learning.other;
  const official = candidate.approx_rediscovery_tokens;
  const summaryTokens =
    official != null && Number.isFinite(Number(official)) ? Number(official) : learningTotal;
  const bits = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => `${n} ${name}`);
  if (reasoningN) bits.push(`${reasoningN} reasoning`);
  bits.push(`~${fmtInt(summaryTokens)} tok`);
  const summary = `Work to learn this · ${bits.join(" · ")}`;
  const learnSum = learningTotal || 1;
  const bar = (["context", "planning", "other"] as const)
    .map((bucket) => {
      const pct = learningTotal ? (100 * learning[bucket]) / learnSum : 0;
      return `<span class="tb ${bucket}" style="width:${pct.toFixed(1)}%"></span>`;
    })
    .join("");
  const legendParts: string[] = [];
  if (learning.context) legendParts.push(`Reads &amp; search ${fmtInt(learning.context)}`);
  if (learning.planning) legendParts.push(`Planning ${fmtInt(learning.planning)}`);
  if (learning.other) legendParts.push(`Reasoning ${fmtInt(learning.other)}`);

  const rows = [
    '<li class="ts-head" aria-hidden="true"><span class="chip">Action</span><span class="pv">What it did</span><span class="tok">Tokens</span></li>',
  ];
  for (const step of capTraceSteps(steps)) {
    if (step.omitted) {
      rows.push(
        `<li class="ts-omit"><span class="chip"></span><span class="pv">${esc(step.omitted)} earlier steps omitted</span><span class="tok"></span></li>`,
      );
      continue;
    }
    const bucket = String(step.bucket || "other");
    const css =
      step.kind === "user"
        ? "ts-user"
        : ({ context: "ts-context", planning: "ts-planning", other: "ts-other", code: "ts-code" }[
            bucket
          ] ?? "ts-other");
    const tok = step.tokens
      ? `<span class="tok">${esc(fmtInt(step.tokens))}</span>`
      : '<span class="tok"></span>';
    rows.push(
      `<li class="${css}"><span class="chip">${esc(step.label)}</span><span class="pv">${esc(step.preview)}</span>${tok}</li>`,
    );
  }

  return `
<details class="trace">
  <summary>${esc(summary)}</summary>
  <div class="trace-bar" title="context / planning / other">${bar}</div>
  <p class="trace-legend">${legendParts.join(" · ")}</p>
  <ol class="trace-steps">${rows.join("")}</ol>
</details>
`;
}

function notesSectionCopy(candidates: ReportCandidate[]): [string, string, string, string] {
  const n = candidates.length;
  const written = candidates.filter(
    (c) => (c.status || "written").toLowerCase() === "written",
  ).length;
  const pending = candidates.filter((c) => (c.status || "").toLowerCase() === "pending").length;
  const already = candidates.filter(
    (c) => (c.status || "").toLowerCase() === "already_in_library",
  ).length;
  const proposed = n - written - pending - already;
  if (n > 0 && already === n) {
    return [
      "Notes already in the Library",
      "These pages were already present — no new write_knowledge calls.",
      "Share",
      "Nothing new to write; the Library already had these pages.",
    ];
  }
  if (n > 0 && written === n) {
    return [
      "Notes written to Dosu",
      "",
      "Share",
      "Notes are on the backfill branch and in the candidate-topic pipeline. Print / Save as PDF if you want a copy.",
    ];
  }
  if (n > 0 && proposed === n) {
    return [
      "Proposed write_knowledge calls",
      "Plain-English takeaway plus what it took to find — not the original user prompts.",
      "Next step",
      "Run the skill (without dry-run) so these payloads are written via write_knowledge.",
    ];
  }
  if (n === 0) {
    return [
      "write_knowledge notes",
      "Plain-English takeaway plus what it took to find — not the original user prompts.",
      "Next step",
      "Run knowledge sync so learnings are extracted and written via write_knowledge.",
    ];
  }
  const bits: string[] = [];
  if (written) bits.push(`${written} written`);
  if (proposed) bits.push(`${proposed} proposed`);
  if (pending) bits.push(`${pending} pending`);
  if (already) bits.push(`${already} already in library`);
  return [
    "write_knowledge notes",
    `${bits.join(", ")} — Plain-English takeaway plus what it took to find — not the original user prompts.`,
    "Share",
    "Written notes are in the candidate-topic pipeline. Proposed/pending items still need a write.",
  ];
}

export function buildReportHtml(options: BuildReportOptions): string {
  const inventory = options.inventory;
  const transcripts = inventory.transcripts ?? [];
  let candidates = applyStatusDefaults(options.candidates ?? [], Boolean(options.dryRun));
  candidates = [...candidates].sort((a, b) => {
    const av = Number(a.approx_rediscovery_tokens) || 0;
    const bv = Number(b.approx_rediscovery_tokens) || 0;
    return bv - av;
  });

  const org = options.orgName || "Your team";
  const repo = options.repo || inventory.cwd || "—";
  const branch = options.branch || "—";
  const summary =
    options.summary ||
    "Local agent session logs were mined into Dosu notes so the next task can reuse them — reducing rediscovery cost.";
  const generated = `${(options.generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16)} UTC`;

  const derived = tokenTotalsFromCandidates(candidates, inventory);
  const [notesHeading, notesLede, footerTitle, footerBody] = notesSectionCopy(candidates);

  const candidateRows = candidates.map((c, i) => {
    const [idea, work] = presentationCopy(c);
    const traceHtml = renderTraceHtml(c, options.digests);
    const content = (c.content || "").trim();
    const ideaHtml = idea
      ? `<p class="idea">${esc(idea)}</p>`
      : "<p class='muted'>Extract a lean note before writing to Dosu.</p>";
    const workHtml = `<p class="work"><span class="work-label">To find this</span> ${esc(work)}</p>`;
    const techHtml =
      content && content !== idea
        ? `<details class="note-tech"><summary>Technical note</summary><pre class="note-body">${esc(content)}</pre></details>`
        : "";
    const status = c.status || "written";
    const queryHtml = c.user_query
      ? `<p class="query"><strong>Trigger:</strong> ${esc(c.user_query)}</p>`
      : "";
    return `
<article class="card" id="c-${i + 1}">
  <header>
    <span class="badge status-${esc(status)}">${esc(status)}</span>
    <h3>${esc(c.title || "Untitled")}</h3>
  </header>
  <p class="meta">
    session ${esc(c.session_title || c.transcript_id || "—")}
    · rediscovery ~${fmtInt(c.approx_rediscovery_tokens ?? c.baseline_tokens)} tok
  </p>
  ${ideaHtml}
  ${workHtml}
  ${traceHtml}
  ${techHtml}
  ${queryHtml}
</article>`;
  });

  const heavy = [...transcripts]
    .sort((a, b) => (b.learning_tokens || 0) - (a.learning_tokens || 0))
    .slice(0, 8);
  const heavyRows = heavy
    .map((t) => {
      const title = (t.title || "").trim() || t.transcript_id;
      const query = (t.user_queries?.[0] || "").slice(0, 100);
      return `<tr>
      <td>${esc(t.source)}</td>
      <td>${esc(title)}</td>
      <td class="num">${fmtInt(t.learning_tokens)}</td>
      <td class="num">${fmtInt(t.rediscovery_tool_calls)}</td>
      <td>${esc(query)}</td>
    </tr>`;
    })
    .join("");

  let tokenSection: string;
  if (derived) {
    tokenSection = `
<section>
  <h2>Estimated context savings</h2>
  <p class="lede">Counterfactual: replace rediscovery stretches with a Dosu <code>read_knowledge</code> hit.</p>
  <div class="stats">
    <div class="stat"><div class="label">Baseline (cost to learn)</div><div class="value">${fmtInt(derived.baseline_tokens)}</div></div>
    <div class="stat"><div class="label">Learning replaced</div><div class="value">${fmtInt(derived.replaced_baseline_tokens)}</div></div>
    <div class="stat"><div class="label">Read cost</div><div class="value">${fmtInt(derived.read_knowledge_tokens)}</div></div>
    <div class="stat highlight"><div class="label">Est. tokens saved</div><div class="value">${fmtInt(derived.tokens_saved)} <span class="pct">(${esc(`${derived.pct_saved}%`)})</span></div></div>
  </div>
</section>`;
  } else {
    tokenSection = `
<section>
  <h2>Estimated context savings</h2>
  <p class="muted">No rediscovery estimates on the notes yet — each candidate needs <code>approx_rediscovery_tokens</code>.</p>
</section>`;
  }

  const notesBody =
    candidateRows.join("") ||
    '<p class="muted">No write_knowledge payloads yet. Run knowledge sync so the miner extracts learnings.</p>';
  const lede = notesLede ? `<p class="lede">${esc(notesLede)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dosu knowledge report — ${esc(org)}</title>
<style>
${REPORT_CSS}
</style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <p class="eyebrow">Dosu · Knowledge report</p>
      <h1>${esc(org)}</h1>
      <p class="lede">${esc(summary)}</p>
      <p class="meta-line">
        Repo <code>${esc(repo)}</code>
        · branch <code>${esc(branch)}</code>
        · generated ${esc(generated)}
      </p>
      <div class="toolbar no-print">
        <button type="button" onclick="window.print()">Print / Save as PDF</button>
      </div>
    </header>

    ${tokenSection}

    <section>
      <h2>${esc(notesHeading)} <span class="muted">(${candidates.length})</span></h2>
      ${lede}
      ${notesBody}
    </section>

    <section>
      <h2>Heaviest sessions</h2>
      <p class="lede">Where learning cost was highest — prime targets for Dosu cache hits.</p>
      <table>
        <thead>
          <tr>
            <th>Host</th><th>Session</th><th>Learning tokens</th><th>Rediscovery tools</th><th>Query</th>
          </tr>
        </thead>
        <tbody>
          ${heavyRows || '<tr><td colspan="5" class="muted">No sessions</td></tr>'}
        </tbody>
      </table>
    </section>

    <footer class="cta">
      <h2>${esc(footerTitle)}</h2>
      <p>${esc(footerBody)}</p>
      <p class="meta">
        Print tip: use <strong>Print / Save as PDF</strong> above (or ⌘P / Ctrl+P).
        Session logs stay between you and your agent — only note text is written to Dosu.
      </p>
      <div class="toolbar no-print">
        <button type="button" onclick="window.print()">Print / Save as PDF</button>
      </div>
    </footer>
  </div>
</body>
</html>
`;
}
